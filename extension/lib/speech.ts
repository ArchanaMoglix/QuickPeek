// Voice input (speech → text) and voice output (text → speech) using the
// browser's built-in Web Speech API. No server or API key needed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Recognition: any =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export const canListen = !!Recognition;
export const canSpeak = 'speechSynthesis' in globalThis;

// ---------- Microphone permission ----------

export async function hasMicPermission(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    console.info('[QuickPeek] microphone permission:', status.state);
    return status.state === 'granted';
  } catch (err) {
    console.warn('[QuickPeek] could not check microphone permission:', err);
    return true; // can't check here; let speech recognition report it
  }
}

// The side panel can't show Chrome's permission prompt, so we ask for it
// once from a normal extension tab. After that the side panel can use the mic.
export function openMicPermissionPage() {
  browser.tabs.create({ url: browser.runtime.getURL('/mic-permission.html') });
}

// ---------- Speech → text ----------

export class MicPermissionError extends Error {}

export interface ListenOptions {
  onText: (text: string) => void; // live transcript while speaking
  onEnd: (text: string) => void; // final transcript when listening stops
  onError: (error: Error) => void;
}

export function listen({ onText, onEnd, onError }: ListenOptions): { stop: () => void } {
  const rec = new Recognition();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false; // stop automatically when the user pauses

  let text = '';

  rec.onresult = (e: any) => {
    text = Array.from(e.results as ArrayLike<any>)
      .map((r) => r[0].transcript)
      .join('')
      .trim();
    onText(text);
  };

  rec.onerror = (e: any) => {
    console.warn('[QuickPeek] speech recognition error:', e.error, e.message);
    switch (e.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        onError(new MicPermissionError('Microphone access is needed for voice input.'));
        break;
      case 'no-speech':
        onError(new Error("Didn't hear anything. Check that the right microphone is selected and try again."));
        break;
      case 'audio-capture':
        onError(new Error('No microphone found. On Mac, allow Chrome in System Settings → Privacy & Security → Microphone.'));
        break;
      case 'network':
        onError(new Error("Couldn't reach the speech service. Check your internet / VPN. (Brave and Opera don't support voice input.)"));
        break;
      case 'language-not-supported':
        onError(new Error(`Voice input doesn't support your browser language (${rec.lang}).`));
        break;
      case 'aborted':
        break;
      default:
        onError(new Error(`Voice input failed (${e.error}).`));
    }
  };

  rec.onend = () => onEnd(text);

  try {
    rec.start();
  } catch (err) {
    console.warn('[QuickPeek] speech recognition failed to start:', err);
    onError(new Error('Voice input could not start. Try again.'));
    onEnd('');
  }

  return { stop: () => rec.stop() };
}

// ---------- Text → speech ----------

// Chrome stops long utterances after ~15s, so speak in short chunks.
function chunk(text: string, max = 200): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > max && current) {
      chunks.push(current);
      current = '';
    }
    current += s;
  }
  if (current.trim()) chunks.push(current);
  return chunks.filter((c) => c.trim());
}

export function speak(text: string, onDone?: () => void) {
  speechSynthesis.cancel();
  const parts = chunk(text);
  if (parts.length === 0) return onDone?.();

  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    if (i === parts.length - 1) {
      u.onend = () => onDone?.();
      u.onerror = () => onDone?.();
    }
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  speechSynthesis.cancel();
}
