// Agent ("Do" mode) background mein chalta hai: click se page badle aur overlay mit jaaye,
// tab bhi kaam chalta rahe. Har badlav storage mein jaata hai, overlay wahan se dikhata hai.

import { agentKey, chatKey, emptyAgent, type AgentState, type RunRecord } from '@/lib/session';
import { runAgent } from './run';
import type { RunView } from './types';

interface LiveRun {
  abort: AbortController;
  confirm?: (ok: boolean) => void;
  record: RunRecord;
}

const live = new Map<number, LiveRun>(); // tabId → chal raha run
const states = new Map<number, AgentState>();

async function load(tabId: number): Promise<AgentState> {
  let state = states.get(tabId);
  if (!state) {
    const stored = await browser.storage.session.get(agentKey(tabId));
    state = (stored[agentKey(tabId)] as AgentState | undefined) ?? emptyAgent();
    states.set(tabId, state);
  }
  return state;
}

function save(tabId: number) {
  const state = states.get(tabId);
  if (state) browser.storage.session.set({ [agentKey(tabId)]: state }).catch(console.error);
}

// Service worker 30s chup rahe to Chrome use band kar deta hai (jaise user ke Allow/Deny ka
// intezaar karte waqt). Run ke dauraan har 20s ek chhota API call usse jagaaye rakhta hai.
function keepAlive(): () => void {
  const timer = setInterval(() => browser.runtime.getPlatformInfo().catch(() => {}), 20_000);
  return () => clearInterval(timer);
}

// Sawaal ka jawab chhota hota hai ("9811914193", "Delhi", "yes"). Purana sawaal (15 min+),
// ya kaam jaisa lamba message ("now add pepsi 2L to cart"): naya kaam maano, purana plan nahi
const PENDING_TTL = 15 * 60_000;
const TASK_START = /^(now |please |pls |also |then )?(add|order|buy|open|go|search|find|book|show|get|put|remove|navigate|visit|check|compare|select|tell|apply|login|log in|sign in)\b/i;
function looksLikeNewTask(message: string, askedAt?: number): boolean {
  if (askedAt && Date.now() - askedAt > PENDING_TTL) return true;
  const m = message.trim();
  return TASK_START.test(m) && m.split(/\s+/).length >= 4;
}

const CART_QUESTION = /cart|order|checkout|confirm|place|total/i;
const YES = /^(yes|y|yeah|yep|ok|okay|sure|confirm(ed)?|go ahead|proceed|place( it| the order)?|order( it)?|haan|haa|ha|han|ji|theek hai|thik hai|kar do)\b/i;

export async function startRun(tabId: number, runId: string, instruction: string): Promise<void> {
  if (live.has(tabId)) return; // ek tab mein ek hi kaam

  const state = await load(tabId);
  const record: RunRecord = { run: { status: 'running', activity: 'Starting…', steps: [] }, content: '' };
  state.runs[runId] = record;
  // Agent ka sawaal pending ho to naya message uska jawab hai, ya bilkul naya kaam?
  const pending = state.pending && !looksLikeNewTask(instruction, state.pending.at) ? state.pending : null;
  state.pending = null;
  const goal = pending
    ? `${pending.goal}\n\n${pending.question ? `You asked the user: "${pending.question}"\n` : ''}User's answer: ${instruction}`
    : instruction;

  // Agent ne cart summary dikha ke poocha tha aur user ne "haan" kaha: checkout ke clicks pe dobara Allow/Deny nahi
  const preApproved = !!pending?.question && CART_QUESTION.test(pending.question) && YES.test(instruction.trim());

  const run: LiveRun = { abort: new AbortController(), record };
  live.set(tabId, run);
  save(tabId);
  const update = (fn: (r: RunView) => RunView) => {
    record.run = fn(record.run);
    save(tabId);
  };

  const stopKeepAlive = keepAlive();
  let status: RunView['status'];
  try {
    const { end, history, plan } = await runAgent({
      tabId,
      goal,
      history: pending?.history,
      plan: pending?.plan,
      preApproved,
      signal: run.abort.signal,
      onStatus: (activity) => update((r) => ({ ...r, activity })),
      onStep: (step) => update((r) => ({ ...r, steps: [...r.steps, step] })),
      onPlan: (plan, planStep) => update((r) => ({ ...r, plan, planStep })),
      confirm: (what) =>
        new Promise<boolean>((resolve) => {
          run.confirm = resolve;
          update((r) => ({ ...r, confirm: what }));
        }),
    });
    status = end.kind;
    record.content = end.message;
    if (end.kind === 'ask_user') state.pending = { goal, history, plan, question: end.message, at: Date.now() };
  } catch (err) {
    status = 'error';
    record.content = err instanceof Error ? err.message : 'Something went wrong.';
  } finally {
    stopKeepAlive();
    live.delete(tabId);
  }
  update((r) => ({ ...r, status, confirm: undefined }));
}

export function answerConfirm(tabId: number, ok: boolean) {
  const run = live.get(tabId);
  if (!run?.confirm) return;
  run.confirm(ok);
  run.confirm = undefined;
  run.record.run = { ...run.record.run, confirm: undefined };
  save(tabId);
}

export function stopRun(tabId: number) {
  const run = live.get(tabId);
  if (!run) return;
  run.abort.abort();
  run.confirm?.(false); // permission ka intezaar ho raha ho to bhi ruk jaaye
}

// Chat clear: is tab ke agent runs aur pending sawaal bhi hatao (kaam chal raha ho to nahi)
export async function clearAgent(tabId: number) {
  if (live.has(tabId)) return;
  states.set(tabId, emptyAgent());
  save(tabId);
}

// Tab band: uski saari halat hata do
export function forgetTab(tabId: number) {
  stopRun(tabId);
  states.delete(tabId);
  browser.storage.session.remove([agentKey(tabId), chatKey(tabId)]).catch(() => {});
}
