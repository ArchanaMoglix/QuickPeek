import { useEffect, useRef, useState } from 'react';
import { askAssistant, type Message, type ModelKind } from '@/lib/api';
import { getPageContent } from '@/lib/extract';
import { captureScreenshot } from '@/lib/screenshot';
import { getExtraImages } from '@/lib/images';
import { clearSource, showSource, type AnswerSource } from '@/lib/highlight';
import type { AgentStep, RunView } from '@/lib/agent/types';
import {
  agentKey,
  chatKey,
  emptyAgent,
  emptyChat,
  type AgentState,
  type BgMessage,
  type ChatState,
  type Mode,
} from '@/lib/session';
import {
  canListen,
  canSpeak,
  hasMicPermission,
  listen,
  MicPermissionError,
  openMicPermissionPage,
  speak,
  stopSpeaking,
} from '@/lib/speech';
import './App.css';

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
  </svg>
);

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
  </svg>
);

const SpeakerIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
  </svg>
);

const PinIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </svg>
);

// Agent ke chhote actions (Click, Type...)
const ActionList = ({ steps }: { steps: AgentStep[] }) => (
  <ul className="steps">
    {steps.map((s, i) => (
      <li key={i} className={s.result.startsWith('error') ? 'failed' : ''}>
        {s.summary}
        {s.result.startsWith('error') && <small>{s.result.replace(/^error: /, '')}</small>}
      </li>
    ))}
  </ul>
);

// Plan ka step: ho gaya / chal raha / baaki
function planState(run: RunView, n: number): 'done' | 'active' | 'current' | 'todo' {
  const current = run.planStep ?? 1;
  if (run.status === 'done' || n < current) return 'done';
  if (n === current) return run.status === 'running' ? 'active' : 'current';
  return 'todo';
}

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const SpeakerOffIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="m22 9-6 6M16 9l6 6" />
  </svg>
);

const CursorIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 4 7 17 2.5-7.5L21 11z" />
  </svg>
);

const RUN_LABEL: Record<RunView['status'], string> = {
  running: 'Working on it',
  done: 'Done',
  ask_user: 'Needs your input',
  stopped: 'Stopped',
  error: "Couldn't finish",
};

// Overlay card mein khula hai to URL mein tabId aata hai; side panel (fallback) mein nahi
const URL_TAB_ID = Number(new URLSearchParams(location.search).get('tabId')) || null;
const IN_OVERLAY = URL_TAB_ID !== null;
const NEW_RUN: RunView = { status: 'running', activity: 'Starting…', steps: [] };

const sendToBackground = (msg: BgMessage) => browser.runtime.sendMessage(msg).catch(console.error);

function App() {
  const [tabId, setTabId] = useState<number | null>(URL_TAB_ID);
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sourceMissing, setSourceMissing] = useState<Set<string>>(new Set()); // 'Show on page' fail hua
  const [mode, setMode] = useState<Mode>('ask');
  const [agent, setAgent] = useState<AgentState>(emptyAgent()); // background agent ki halat
  const [announced, setAnnounced] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false); // jawab bol ke sunana: default band
  const speakerOnRef = useRef(false);
  const [voiceError, setVoiceError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const modeRef = useRef<Mode>('ask');
  // Bheja gaya sawaal jo abhi chala nahi: user pehle chunega Ask hai ya Do
  const [choosing, setChoosing] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false); // "Clear chat?" dikh raha hai (dusre click pe clear)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const agentRunning = Object.values(agent.runs).some((r) => r.run.status === 'running');
  const busy = loading || agentRunning || choosing !== null;

  // Side panel (fallback) mein tabId URL mein nahi hota: abhi wala tab
  useEffect(() => {
    if (tabId !== null) return;
    browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) setTabId(tab.id);
    });
  }, [tabId]);

  // Is tab ki purani chat aur agent ki halat wapas lao (page badalne pe overlay naya banta hai)
  useEffect(() => {
    if (tabId === null) return;
    const ck = chatKey(tabId);
    const ak = agentKey(tabId);
    browser.storage.session.get([ck, ak]).then((stored) => {
      const chat = (stored[ck] as ChatState | undefined) ?? emptyChat();
      setMessages(chat.messages);
      setMode(chat.mode);
      modeRef.current = chat.mode;
      setSpeakerOn(chat.speakerOn);
      speakerOnRef.current = chat.speakerOn;
      setAnnounced(chat.announced);
      setAgent((stored[ak] as AgentState | undefined) ?? emptyAgent());
      setLoaded(true);
    });
    // Agent background mein chalta hai: uske har step pe yahan update
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && changes[ak]) setAgent((changes[ak].newValue as AgentState) ?? emptyAgent());
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, [tabId]);

  // Chat save karo, taaki page badalne pe wapas aaye
  useEffect(() => {
    if (!loaded || tabId === null) return;
    const chat: ChatState = { messages, mode, speakerOn, announced };
    browser.storage.session.set({ [chatKey(tabId)]: chat }).catch(console.error);
  }, [loaded, tabId, messages, mode, speakerOn, announced]);

  // Agent ka kaam khatam: speaker on ho to nateeja bol ke sunao (ek hi baar)
  useEffect(() => {
    if (!loaded) return;
    const finished = messages
      .map((m) => m.runId)
      .filter((id): id is string => !!id && !announced.includes(id))
      .filter((id) => agent.runs[id] && agent.runs[id].run.status !== 'running');
    if (!finished.length) return;
    setAnnounced((prev) => [...prev, ...finished]);
    const last = agent.runs[finished[finished.length - 1]!];
    if (speakerOnRef.current && canSpeak && last?.content) speak(last.content);
  }, [loaded, agent, messages, announced]);

  // Kaam khatam: input box phir se chalu, cursor wahin rakho
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) inputRef.current?.focus();
    wasBusy.current = busy;
  }, [busy]);

  // Naya message aane pe neeche scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, agent]);

  // Widget band ho to mic aur awaaz band (agent background mein hai, use close button rokta hai)
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (canSpeak) stopSpeaking();
    };
  }, []);

  function changeMode(next: Mode) {
    setMode(next);
    modeRef.current = next;
  }

  function contentOf(m: Message): string {
    return m.runId ? agent.runs[m.runId]?.content ?? '' : m.content;
  }

  function toggleSpeaker() {
    const on = !speakerOn;
    setSpeakerOn(on);
    speakerOnRef.current = on;

    if (!on) return stopSpeaking();
    // On karte hi aakhri jawab suna do
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && contentOf(m));
    if (last) speak(contentOf(last));
  }

  function addMessage(msg: Omit<Message, 'id'>): string {
    const id = crypto.randomUUID();
    setMessages((prev) => [...prev, { ...msg, id }]);
    return id;
  }

  // ---------- Ask mode ----------

  async function ask(question: string) {
    setLoading(true);
    let answer: string;
    let model: ModelKind | undefined;
    let source: AnswerSource | undefined;
    try {
      // Har sawaal pe fresh page text + screenshot; server tay karega kaunsa model use ho
      // Pichhle jawab ka highlight hatao, warna screenshot mein peela dikhega
      await clearSource();
      const [page, screenshot] = await Promise.all([getPageContent(question), captureScreenshot()]);
      // Sawaal screen ke bahar wali kisi image ke baare mein ho to uski file bhi bhejo
      const extraImages = await getExtraImages(question, page.images);
      // source: jawab page pe kahan hai. "Show on page" button dabane pe hi wahan le jaate hain
      ({ answer, model, source } = await askAssistant(question, page, screenshot, extraImages));
    } catch (err) {
      answer = err instanceof Error ? err.message : 'Something went wrong. Try again.';
    } finally {
      setLoading(false);
    }

    addMessage({ role: 'assistant', content: answer, model, source });
    // Speaker on hai to jawab bol ke sunao (ref: voice se aaye send mein bhi latest value mile)
    if (speakerOnRef.current && canSpeak) speak(answer);
  }

  // "Show on page": jawab wale hisse tak scroll karke peela highlight
  async function goToSource(id: string, source: AnswerSource) {
    const found = await showSource(source);
    setSourceMissing((prev) => {
      const next = new Set(prev);
      if (found) next.delete(id);
      else next.add(id); // user doosre page/tab pe chala gaya
      return next;
    });
  }

  // ---------- Do mode (agent, background mein chalta hai) ----------

  function doTask(instruction: string) {
    if (tabId === null) {
      addMessage({ role: 'assistant', content: 'No active tab found.' });
      return;
    }
    const runId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: runId, role: 'assistant', content: '', runId }]);
    sendToBackground({ type: 'qp:agent:start', tabId, runId, instruction });
  }

  function answerConfirm(ok: boolean) {
    if (tabId !== null) sendToBackground({ type: 'qp:agent:confirm', tabId, ok });
  }

  function stopAgent() {
    if (tabId !== null) sendToBackground({ type: 'qp:agent:stop', tabId });
  }

  // Pehla click: "Clear chat?" (3s). Dusra click: chat, agent runs aur page ka highlight sab saaf
  function clearChat() {
    if (!confirmClear) {
      setConfirmClear(true);
      clearTimer.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setConfirmClear(false);
    if (canSpeak) stopSpeaking();
    clearSource().catch(() => {});
    setMessages([]);
    setAnnounced([]);
    setSourceMissing(new Set());
    setVoiceError('');
    setChoosing(null);
    setAgent(emptyAgent());
    if (tabId !== null) sendToBackground({ type: 'qp:agent:clear', tabId });
  }

  function closeWidget() {
    if (tabId !== null) sendToBackground({ type: 'qp:overlay:close', tabId });
  }

  // ---------- Common ----------

  async function send(text = input, fromVoice = false) {
    const question = text.trim();
    if (!question || busy) return;

    addMessage({ role: 'user', content: question, voice: fromVoice });
    setInput('');

    // Agent ne sawaal poocha tha: ye uska jawab hai, seedha Do mein bhejo
    if (agent.pending) {
      changeMode('do');
      doTask(question);
      return;
    }

    // Warna har query se pehle poocho: Ask (jawab do) ya Do (page pe kaam karo)
    setChoosing(question);
    if (speakerOnRef.current && canSpeak) speak('Should I answer this, or do it on the page?');
  }

  async function runAs(next: Mode) {
    const question = choosing;
    if (!question) return;
    setChoosing(null);
    changeMode(next); // composer ka rang aakhri chune mode jaisa
    if (canSpeak) stopSpeaking();
    if (next === 'do') doTask(question);
    else await ask(question);
  }

  function cancelChoice() {
    setChoosing(null);
    // Sawaal wapas text box mein, aur chat se hatao
    setInput(choosing ?? '');
    setMessages((prev) => prev.slice(0, -1));
  }

  async function toggleMic() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    setVoiceError('');
    if (!(await hasMicPermission())) {
      openMicPermissionPage();
      setVoiceError('Allow the microphone in the tab that just opened, then tap the mic again.');
      return;
    }

    if (canSpeak) stopSpeaking(); // mic apni hi awaaz na sune

    setInput('');
    setListening(true);
    recognitionRef.current = listen({
      onText: setInput, // bolte waqt text box mein live text
      onEnd: (text) => {
        setListening(false);
        recognitionRef.current = null;
        if (text) send(text, true);
      },
      onError: (err) => {
        if (err instanceof MicPermissionError) openMicPermissionPage();
        setVoiceError(err.message);
      },
    });
  }

  const placeholder = listening
    ? 'Listening…'
    : agentRunning
      ? 'Quick Peek is working on the task… (press Stop to cancel)'
    : loading
      ? 'Quick Peek is answering…'
    : choosing !== null
      ? 'Pick Ask or Do above…'
      : agent.pending
        ? "Answer Quick Peek's question…"
        : 'Ask about this page, or tell me what to do…';

  return (
    <div className="app">
      <header className="header">
        <span className="header-title">Quick Peek</span>
        {messages.length > 0 && (
          <button
            className={`clear-btn ${confirmClear ? 'confirm' : ''}`}
            onClick={clearChat}
            disabled={busy}
            aria-label={confirmClear ? 'Click again to clear the chat' : 'Clear chat'}
            title={busy ? 'Wait for the current task to finish' : 'Clear chat'}
          >
            <TrashIcon />
            {confirmClear && <span>Clear chat?</span>}
          </button>
        )}
        {IN_OVERLAY && (
          <button className="close-btn" onClick={closeWidget} aria-label="Close Quick Peek" title="Close">
            ×
          </button>
        )}
      </header>

      <main className="messages">
        {messages.length === 0 && (
          <p className="empty">
            Ask anything about this page, or tell me what to do.<br />e.g. “Search for wireless mouse”
            {canListen && <><br />Type, or tap the mic to speak.</>}
          </p>
        )}
        {messages.map((m) => {
          if (m.runId) {
            const rec = agent.runs[m.runId];
            const run = rec?.run ?? NEW_RUN; // background ne abhi likha nahi
            return (
              <div key={m.id} className={`bubble assistant run ${run.status}`}>
                <span className="voice-tag"><CursorIcon /> {RUN_LABEL[run.status]}</span>
                {run.plan ? (
                  <ol className="plan">
                    {run.plan.map((p, i) => {
                      const n = i + 1;
                      const state = planState(run, n);
                      const actions = run.steps.filter((s) => (s.planStep ?? 1) === n);
                      return (
                        <li key={i} className={`plan-step ${state}`}>
                          <span className="plan-mark">{state === 'done' ? '✓' : state === 'active' ? '' : n}</span>
                          <div className="plan-body">
                            <span className="plan-text">{p}</span>
                            {actions.length > 0 && <ActionList steps={actions} />}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  run.steps.length > 0 && <ActionList steps={run.steps} />
                )}
                {run.status === 'running' && !run.confirm && (
                  <div className="activity"><span className="spinner" /> {run.activity}</div>
                )}
                {run.confirm && (
                  <div className="confirm">
                    <p>Allow Quick Peek to <strong>{run.confirm}</strong>?</p>
                    <div className="confirm-actions">
                      <button className="allow-btn" onClick={() => answerConfirm(true)}>Allow</button>
                      <button className="deny-btn" onClick={() => answerConfirm(false)}>Deny</button>
                    </div>
                  </div>
                )}
                {rec?.content && <div className="run-result">{rec.content}</div>}
                {run.status === 'running' && (
                  <button className="stop-btn" onClick={stopAgent}>Stop</button>
                )}
              </div>
            );
          }
          return (
            <div key={m.id} className={`bubble ${m.role}`}>
              {m.voice && <span className="voice-tag"><MicIcon /> Voice</span>}
              {m.model === 'vision' && <span className="voice-tag"><EyeIcon /> Looked at the screen</span>}
              {m.content}
              {m.source && (
                <button className="source-btn" onClick={() => goToSource(m.id, m.source!)}>
                  <PinIcon /> {sourceMissing.has(m.id) ? "Couldn't find it on this page" : 'Show on page'}
                </button>
              )}
            </div>
          );
        })}
        {choosing !== null && (
          <div className="bubble assistant choose">
            <p>Is this a question, or a task to do on the page?</p>
            <div className="choose-actions">
              <button className="choose-ask" onClick={() => runAs('ask')} title="Answer it from this page">
                Ask
              </button>
              <button className="choose-do" onClick={() => runAs('do')} title="Click and type on this page">
                Do
              </button>
              <button className="choose-cancel" onClick={cancelChoice} title="Edit the message">
                Cancel
              </button>
            </div>
          </div>
        )}
        {loading && <div className="bubble assistant">Thinking…</div>}
        <div ref={bottomRef} />
      </main>

      {voiceError && (
        <p className="voice-error">
          {voiceError}{' '}
          <button className="link-btn" onClick={openMicPermissionPage}>Test mic</button>
        </p>
      )}

      {/* Mode ke hisaab se rang (Ask = neela, Do = narangi): bhejne se pehle dikhe ki kaunsa mode hai */}
      <footer className={`composer mode-${mode}`}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          readOnly={listening}
          // Agent kaam kar raha hai (ya jawab aa raha hai / Ask-Do chunna baaki hai): nayi command nahi
          disabled={busy}
          rows={2}
        />
        <div className="composer-actions">
          {canListen && (
            <button
              className={`icon-btn ${listening ? 'listening' : ''}`}
              onClick={toggleMic}
              disabled={busy}
              aria-label={listening ? 'Stop listening' : 'Speak your question'}
              title={listening ? 'Stop listening' : 'Speak your question'}
            >
              <MicIcon />
            </button>
          )}
          {canSpeak && (
            <button
              className={`icon-btn ${speakerOn ? 'on' : ''}`}
              onClick={toggleSpeaker}
              disabled={busy}
              aria-label={speakerOn ? 'Turn off spoken replies' : 'Read replies aloud'}
              aria-pressed={speakerOn}
              title={speakerOn ? 'Spoken replies: on' : 'Spoken replies: off'}
            >
              {speakerOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
            </button>
          )}
          <button className="send-btn" onClick={() => send()} disabled={busy || listening || !input.trim()}>
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}

export default App;
