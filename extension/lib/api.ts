// export type Role = 'user' | 'assistant';

// export interface Message {
//   id: string;
//   role: Role;
//   content: string;
// }

// // Abhi fake. Step 5 mein yahan backend call aayega.
// export async function askAssistant(question: string): Promise<string> {
//   await new Promise((r) => setTimeout(r, 800)); // network delay jaisa feel
//   return `You asked: "${question}". (Currently this is a fake reply.)`;
// }




import type { PageContent } from './extract';

export type Role = 'user' | 'assistant';

export interface Message {
  id: string;
  role: Role;
  content: string;
  voice?: boolean; // user message that was spoken, not typed
}

const API_URL = 'http://localhost:3001/api';

export async function askAssistant(question: string, page: PageContent): Promise<string> {
  let res: Response;

  try {
    res = await fetch(`${API_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, page }),
    });
  } catch {
    // fetch throws only when the server is unreachable
    throw new Error('Could not connect to the server. Is it running?');
  }

 if (!res.ok) {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `Server error: ${res.status}`);
}

  const data = (await res.json()) as { answer: string };
  return data.answer;
}