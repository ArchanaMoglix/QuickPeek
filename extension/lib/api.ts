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
import type { ExtraImage } from './images';
import type { AnswerSource } from './highlight';
import type { AgentAction, AgentStep, Observation, RunView } from './agent/types';

export type Role = 'user' | 'assistant';
export type ModelKind = 'text' | 'vision';

export interface Message {
  id: string;
  role: Role;
  content: string;
  voice?: boolean; // user message that was spoken, not typed
  model?: ModelKind; // which model answered (assistant messages)
  runId?: string; // "Do" mode: agent ka kaam (steps background se aate hain, session.ts)
  source?: AnswerSource; // jawab page pe kahan hai ("Show on page" button)
}

export interface AssistantReply {
  answer: string;
  model: ModelKind;
  source?: AnswerSource; // jawab page pe kahan hai: wahan scroll + highlight
}

const API_URL = 'http://localhost:3001/api';

export async function askAssistant(
  question: string,
  page: PageContent,
  screenshot: string | null,
  extraImages: ExtraImage[] = [],
): Promise<AssistantReply> {
  let res: Response;

  try {
    res = await fetch(`${API_URL}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        page,
        screenshot: screenshot ?? undefined,
        extraImages: extraImages.length ? extraImages : undefined,
      }),
    });
  } catch {
    // fetch throws only when the server is unreachable
    throw new Error('Could not connect to the server. Is it running?');
  }

 if (!res.ok) {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `Server error: ${res.status}`);
}

  const data = (await res.json()) as AssistantReply;
  return { answer: data.answer, model: data.model ?? 'text', source: data.source };
}

// ---------- Agent ("Do" mode) ----------

export interface AgentDecision {
  thought: string;
  action: AgentAction;
  step?: number; // plan ka kaunsa step
  model: ModelKind;
}

// Task ko chhote steps mein todo (server pe plan na bane to poora goal hi ek step)
export async function askAgentPlan(
  body: { goal: string; url: string; title: string; visibleText?: string },
  signal?: AbortSignal,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/agent/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, visibleText: body.visibleText?.slice(0, 20000) }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Could not connect to the server. Is it running?');
  }
  if (!res.ok) return [body.goal];
  const data = (await res.json()) as { steps?: string[] };
  return data.steps?.length ? data.steps : [body.goal];
}

// Server se agla step poochho
export async function askAgentStep(
  body: {
    goal: string;
    plan: string[];
    history: AgentStep[];
    observation: Observation;
    screenshot: string | null;
    changes?: string; // pichhle action ke baad screen pe kya naya aaya
  },
  signal?: AbortSignal,
): Promise<AgentDecision> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/agent/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, screenshot: body.screenshot ?? undefined }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Could not connect to the server. Is it running?');
  }

  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Server error: ${res.status}`);
  }
  return (await res.json()) as AgentDecision;
}
