import { useEffect, useRef, useState } from 'react';
import { askAssistant, type Message } from '@/lib/api';
import { getPageContent } from '@/lib/extract';
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

const SpeakerOffIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="m22 9-6 6M16 9l6 6" />
  </svg>
);

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false); // jawab bol ke sunana: default band
  const speakerOnRef = useRef(false);
  const [voiceError, setVoiceError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  // Naya message aane pe neeche scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Panel band ho to mic aur awaaz dono band
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      if (canSpeak) stopSpeaking();
    };
  }, []);

  function toggleSpeaker() {
    const on = !speakerOn;
    setSpeakerOn(on);
    speakerOnRef.current = on;

    if (!on) return stopSpeaking();
    // On karte hi aakhri jawab suna do
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (last) speak(last.content);
  }

  async function send(text = input, fromVoice = false) {
    const question = text.trim();
    if (!question || loading) return;

    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: question, voice: fromVoice },
    ]);
    setInput('');
    setLoading(true);

    let answer: string;
    try {
      const page = await getPageContent(); // har sawaal pe fresh page padho
      answer = await askAssistant(question, page);
    } catch (err) {
      answer = err instanceof Error ? err.message : 'Something went wrong. Try again.';
    } finally {
      setLoading(false);
    }

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: answer }]);

    // Speaker on hai to jawab bol ke sunao (ref: voice se aaye send mein bhi latest value mile)
    if (speakerOnRef.current && canSpeak) speak(answer);
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

  return (
    <div className="app">
      <header className="header">Quick Peek</header>

      <main className="messages">
        {messages.length === 0 && (
          <p className="empty">
            Ask anything about this page.
            {canListen && <><br />Type, or tap the mic to speak.</>}
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.voice && <span className="voice-tag"><MicIcon /> Voice</span>}
            {m.content}
          </div>
        ))}
        {loading && <div className="bubble assistant">Thinking…</div>}
        <div ref={bottomRef} />
      </main>

      {voiceError && (
        <p className="voice-error">
          {voiceError}{' '}
          <button className="link-btn" onClick={openMicPermissionPage}>Test mic</button>
        </p>
      )}

      <footer className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={listening ? 'Listening…' : 'Enter your query here.'}
          readOnly={listening}
          rows={2}
        />
        <div className="composer-actions">
          {canListen && (
            <button
              className={`icon-btn ${listening ? 'listening' : ''}`}
              onClick={toggleMic}
              disabled={loading}
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
              aria-label={speakerOn ? 'Turn off spoken replies' : 'Read replies aloud'}
              aria-pressed={speakerOn}
              title={speakerOn ? 'Spoken replies: on' : 'Spoken replies: off'}
            >
              {speakerOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
            </button>
          )}
          <button className="send-btn" onClick={() => send()} disabled={loading || listening || !input.trim()}>
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}

export default App;
