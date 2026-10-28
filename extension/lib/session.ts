// Har tab ki Quick Peek halat, chrome.storage.session mein (browser band hone tak).
// Overlay website ke andar hai, isliye page badalte hi wo mit jaata hai; dobara lagne pe
// chat aur agent ke steps yahin se wapas aate hain.

import type { Message } from './api';
import type { AgentStep, RunView } from './agent/types';

export type Mode = 'ask' | 'do';

// Overlay (UI) likhta hai
export interface ChatState {
  messages: Message[];
  mode: Mode;
  speakerOn: boolean;
  announced: string[]; // in runs ka nateeja bol ke suna diya / dikhaya ja chuka hai
}

// Background (agent) likhta hai
export interface RunRecord {
  run: RunView;
  content: string; // aakhri message: "Done…", "Couldn't finish…"
}
export interface AgentState {
  runs: Record<string, RunRecord>;
  // Agent ne user se sawaal poochha: agla "Do" message usi kaam ko aage badhata hai
  // Agent ne user se kuch poocha tha: agla message uska jawab ho sakta hai
  pending: { goal: string; history: AgentStep[]; plan: string[]; question?: string; at?: number } | null;
}

export const chatKey = (tabId: number) => `qp:chat:${tabId}`;
export const agentKey = (tabId: number) => `qp:agent:${tabId}`;
export const OPEN_TABS_KEY = 'qp:open-tabs';

export const emptyChat = (): ChatState => ({ messages: [], mode: 'ask', speakerOn: false, announced: [] });
export const emptyAgent = (): AgentState => ({ runs: {}, pending: null });

// UI → background messages
export type BgMessage =
  | { type: 'qp:agent:start'; tabId: number; runId: string; instruction: string }
  | { type: 'qp:agent:confirm'; tabId: number; ok: boolean }
  | { type: 'qp:agent:stop'; tabId: number }
  | { type: 'qp:agent:clear'; tabId: number }
  | { type: 'qp:overlay:close'; tabId: number };
