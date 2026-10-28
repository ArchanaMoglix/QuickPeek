// Agent ("Do" mode) ke shared types

export type AgentAction =
  | { type: 'click'; id: number }
  | { type: 'hover'; id: number }
  | { type: 'inspect'; id: number } // element ka asli HTML (class, id, attributes) padho
  | { type: 'type'; id: number; text: string; submit?: boolean }
  | { type: 'select'; id: number; option: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'find'; text: string } // poore page (screen ke bahar bhi) mein ye text dhoondho
  | { type: 'goto'; url: string }
  | { type: 'back' }
  | { type: 'wait' }
  | { type: 'done'; message: string }
  | { type: 'ask_user'; question: string };

export interface ElementInfo {
  id: number;
  line: string; // model ke liye ek line ka description
  label: string; // user ko dikhane ke liye chhota naam
  context?: string; // kis card ka hai (jaise "ADD" kis product ka), chhota
  secret: boolean; // password / card / OTP field: kabhi type nahi karna
  risky: boolean; // buy, pay, delete, send... : pehle user se poochho
  enterSafe: boolean; // type karke Enter dabana safe hai (search/filter); message box, login/payment form pe nahi
}

export interface Observation {
  url: string;
  title: string;
  scroll: string; // "top of page" / "40% down" ...
  visibleText: string;
  elements: ElementInfo[];
  // Screenshot pe number wale boxes banane ke liye (viewport ke CSS px mein). Server ko nahi bhejte
  marks?: Mark[];
  viewportWidth?: number;
}

export interface Mark {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AgentStep {
  thought: string;
  action: AgentAction;
  summary: string; // user ko dikhne wala: Clicked "Search"
  url?: string; // ye step kis page pe hua (atakne ka pata lagane ke liye)
  planStep?: number; // plan ka kaunsa step (1 se shuru) ye action kar raha tha
  result: string; // ok / error message, model ko wapas jaata hai
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

// Chat mein ek agent run kaisa dikhe
export interface RunView {
  status: 'running' | 'done' | 'ask_user' | 'stopped' | 'error';
  activity: string; // abhi kya ho raha hai
  steps: AgentStep[];
  plan?: string[]; // task ke chhote steps
  planStep?: number; // abhi plan ka kaunsa step chal raha hai (1 se shuru)
  confirm?: string; // ye action karne se pehle user ki permission chahiye
}
