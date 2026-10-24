// Agent loop: dekho (page + screenshot) → server se agla action poochho → karo → dobara.

import { askAgentPlan, askAgentStep } from '@/lib/api';
import { RESTRICTED } from '@/lib/extract';
import { captureScreenshot } from '@/lib/screenshot';
import { actOnPage, clearMarks, observePage, waitForQuiet } from './page';
import type { ActionResult, AgentAction, AgentStep, ElementInfo, Observation } from './types';

export const MAX_STEPS = 25;
const MAX_SCROLLS_PER_PAGE = 3; // iske baad user khud scroll kar sakta hai
const MAX_ACTIONS_PER_PLAN_STEP = 6;

// Pichhle action ke baad screen pe kya naya aaya (jaise "Cart 1", "Product added"):
// model ko pata chale ki action kaam kiya ya nahi
function screenChanges(prev: Observation | null, now: Observation): string {
  if (!prev) return '';
  if (prev.url !== now.url) return `Moved to a new page: ${now.title}`;
  const lines = (o: Observation) => [
    ...o.visibleText.split('\n'),
    ...o.elements.map((e) => e.label),
  ].map((l) => l.trim()).filter((l) => l.length > 0);
  const before = new Set(lines(prev));
  const added = [...new Set(lines(now))].filter((l) => !before.has(l));
  if (!added.length) return 'Nothing changed on the screen.';
  return `New on the screen: ${added.join(' | ')}`.slice(0, 500);
}

// Same page pe 2–3 actions ka chakkar (A B A B A / A B C A B C A) = model atak gaya
// Ids har turn badalte hain, isliye action ko uske naam se pehchaante hain: Click "Up to ₹1,100"
function inCycle(history: AgentStep[], summary: string, url: string): boolean {
  for (const p of [2, 3]) {
    const recent = history.slice(-2 * p);
    if (recent.length < 2 * p || recent.some((s) => s.url !== url)) continue;
    const seq = [...recent.map((s) => s.summary), summary];
    if (seq.every((k, i) => i < p || k === seq[i - p]) && new Set(seq).size > 1) return true;
  }
  return false;
}

export type RunEnd =
  | { kind: 'done'; message: string }
  | { kind: 'ask_user'; message: string }
  | { kind: 'stopped'; message: string }
  | { kind: 'error'; message: string };

export interface RunOptions {
  tabId: number;
  goal: string;
  history?: AgentStep[]; // pichhla run user ke jawab ke baad aage badhe to
  plan?: string[]; // pichhle run ka plan (user ke jawab ke baad aage badhe to)
  signal: AbortSignal; // Stop button
  onStatus: (status: string) => void; // "Looking at the page…"
  onStep: (step: AgentStep) => void;
  onPlan: (plan: string[], current: number) => void; // plan bana / agla plan step shuru hua
  confirm: (what: string) => Promise<boolean>; // risky action se pehle user se poochho
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inTab<A extends unknown[], R>(tabId: number, func: (...args: A) => R, ...args: A): Promise<R> {
  const [res] = await browser.scripting.executeScript({ target: { tabId }, func, args } as never);
  return (res as { result: R }).result;
}

// Click ke baad naya page load ho raha ho to uske poore hone ka intezaar
async function waitForPage(tabId: number) {
  await sleep(600);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') break;
    await sleep(250);
  }
  await inTab(tabId, waitForQuiet).catch(() => {}); // JS se aane wala content
}

function describe(action: AgentAction, el?: ElementInfo): string {
  const name = el ? `"${el.label}"` : `[${'id' in action ? action.id : ''}]`;
  switch (action.type) {
    case 'click': return `Click ${name}`;
    case 'hover': return `Hover over ${name}`;
    case 'type': return `Type "${action.text}" in ${name}${action.submit ? ' and press Enter' : ''}`;
    case 'select': return `Choose "${action.option}" in ${name}`;
    case 'press': return `Press ${action.key}`;
    case 'scroll': return `Scroll ${action.direction}`;
    case 'find': return `Find "${action.text}" on the page`;
    case 'goto': return `Open ${action.url}`;
    case 'back': return 'Go back';
    case 'wait': return 'Wait for the page';
    case 'done': return 'Done';
    case 'ask_user': return 'Ask you';
  }
}

// Site koi link naye tab mein khole to wo tab band karke URL isi tab mein kholo,
// kyunki agent (aur side panel) sirf isi tab mein kaam karta hai
async function withNewTabsRedirected<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const opened: number[] = [];
  const { windowId } = await browser.tabs.get(tabId);
  // "noopener" wale links pe openerTabId nahi hota, isliye isi window mein
  // action ke dauraan khula koi bhi naya tab pakdo
  const onCreated = (tab: { id?: number; openerTabId?: number; windowId?: number }) => {
    if (tab.id === undefined) return;
    if (tab.openerTabId === tabId || tab.windowId === windowId) opened.push(tab.id);
  };
  browser.tabs.onCreated.addListener(onCreated);
  try {
    const result = await fn();
    await sleep(700);
    for (const id of opened) {
      const t = await browser.tabs.get(id).catch(() => null);
      const url = t?.pendingUrl || t?.url;
      await browser.tabs.remove(id).catch(() => {});
      if (url && /^https?:/.test(url)) await browser.tabs.update(tabId, { url, active: true });
    }
    return result;
  } finally {
    browser.tabs.onCreated.removeListener(onCreated);
  }
}

// Model ne koi number (pincode, phone...) khud bana ke type kiya? Wo number user ke instruction mein hona chahiye
function madeUpNumber(action: AgentAction, goal: string): string | null {
  if (action.type !== 'type') return null;
  const plain = (t: string) => t.replace(/(\d),(?=\d)/g, '$1'); // "10,000" = "10000"
  const g = plain(goal);
  return (plain(action.text).match(/\d{4,}/g) ?? []).find((n) => !g.includes(n)) ?? null;
}

export interface RunResult {
  end: RunEnd;
  history: AgentStep[];
  plan: string[];
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { tabId, goal, signal, onStatus, onStep, onPlan, confirm } = opts;
  const history: AgentStep[] = [...(opts.history ?? [])];
  let plan: string[] = opts.plan ?? [];
  let planStep = history[history.length - 1]?.planStep ?? 1;
  const stopped = (): RunResult => ({ end: { kind: 'stopped', message: 'Stopped.' }, history, plan });

  // 0. Pehle task ko chhote steps mein todo
  if (!plan.length) {
    onStatus('Breaking the task into steps…');
    try {
      const tab = await browser.tabs.get(tabId);
      const obs = tab.url && !RESTRICTED.test(tab.url) ? await inTab(tabId, observePage, false).catch(() => null) : null;
      plan = await askAgentPlan(
        { goal, url: tab.url ?? '', title: tab.title ?? '', visibleText: obs?.visibleText },
        signal,
      );
    } catch {
      if (signal.aborted) return stopped();
      plan = [goal]; // plan na bane to bhi kaam karo
    }
  }
  onPlan(plan, planStep);

  let lastTypedSearchish = false; // aakhri baar search box mein type kiya tha?
  let prevObs: Observation | null = null; // pichhle step ki screen
  let warnedStuck = false; // ek baar "tum ghoom rahe ho" bata diya
  let findText: string | undefined; // model ke "find" ke shabd: agli list mein unke elements
  const scrolls = new Map<string, number>(); // har page pe kitni baar scroll kiya
  const scrollBlocked = new Set<string>(); // in pages pe scroll ki limit bata di gayi hai

  for (let i = 0; i < MAX_STEPS; i++) {
    if (signal.aborted) return stopped();

    // 1. Dekho
    onStatus('Looking at the page…');
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || RESTRICTED.test(tab.url)) {
      return { end: { kind: 'error', message: "I can't control this page (browser internal page)." }, history, plan };
    }
    let obs: Observation;
    let screenshot: string | null = null;
    try {
      // Screen ke bahar wale kaam ke elements bhi: plan ke abhi wale step se milte-julte, aur "find" wale
      const lookFor = { hint: `${plan[planStep - 1] ?? ''} ${goal}`, find: findText };
      findText = undefined; // sirf ek turn ke liye
      obs = await inTab(tabId, observePage, true, lookFor);
      // Page abhi khaali hai (load ho raha hai)? Thoda ruk ke dobara dekho
      for (let tries = 0; tries < 3 && obs.elements.length < 3 && obs.visibleText.length < 50; tries++) {
        onStatus('Waiting for the page to load…');
        await sleep(2000);
        obs = await inTab(tabId, observePage, true, lookFor);
      }
      screenshot = await captureScreenshot({ tabId, maxWidth: 1024 });
    } catch (err) {
      return { end: { kind: 'error', message: `Couldn't read the page: ${(err as Error).message}` }, history, plan };
    } finally {
      await inTab(tabId, clearMarks).catch(() => {});
    }

    // 2. Socho
    onStatus('Deciding the next step…');
    let thought: string;
    let action: AgentAction;
    let nextPlanStep: number | undefined;
    // Ek plan step pe bahut actions ho gaye: aage badhne ko bolo
    const onThisStep = history.filter((h) => h.planStep === planStep).length;
    const changes =
      screenChanges(prevObs, obs) +
      (onThisStep >= MAX_ACTIONS_PER_PLAN_STEP && planStep < plan.length
        ? ` | You have spent ${onThisStep} actions on plan step ${planStep} without finishing it. Stop trying it: skip it or do it another way, and move to plan step ${planStep + 1}.`
        : '');
    try {
      prevObs = obs;
      ({ thought, action, step: nextPlanStep } = await askAgentStep(
        { goal, plan, history, observation: obs, screenshot, changes },
        signal,
      ));
    } catch (err) {
      if (signal.aborted) return stopped();
      return { end: { kind: 'error', message: (err as Error).message }, history, plan };
    }
    if (signal.aborted) return stopped();

    // Model ne bataya ki ab plan ke kis step pe hai
    if (nextPlanStep && nextPlanStep !== planStep) {
      planStep = nextPlanStep;
      onPlan(plan, planStep);
    }

    if (action.type === 'done') return { end: { kind: 'done', message: action.message }, history, plan };
    if (action.type === 'ask_user') return { end: { kind: 'ask_user', message: action.question }, history, plan };

    const el = 'id' in action ? obs.elements.find((e) => e.id === action.id) : undefined;
    const summary = describe(action, el);
    let result: ActionResult;

    // Atakna: same action (naam se, id se nahi) 3 baar lagataar, ya 2–3 actions ka chakkar.
    // Scroll/wait dohrana normal hai (lambi list), unhe nahi ginte.
    const same = (s?: AgentStep) => s && s.url === obs.url && s.summary === summary;
    const repeatable = action.type === 'scroll' || action.type === 'wait';
    const looping =
      !repeatable &&
      ((same(history[history.length - 1]) && same(history[history.length - 2])) || inCycle(history, summary, obs.url));
    if (looping && warnedStuck) {
      return {
        end: { kind: 'error', message: "I got stuck repeating the same steps, so I stopped. Try a more specific instruction." },
        history,
        plan,
      };
    }

    const needsConfirm =
      (action.type === 'click' && el?.risky) ||
      (action.type === 'type' && action.submit && !el?.searchish) ||
      (action.type === 'press' && action.key === 'Enter' && !lastTypedSearchish);
    if (action.type === 'type') lastTypedSearchish = !!el?.searchish;

    // Scroll ki limit: utna kaafi hai, aage user khud scroll kar sakta hai
    const overScrollLimit = action.type === 'scroll' && (scrolls.get(obs.url) ?? 0) >= MAX_SCROLLS_PER_PAGE;
    if (overScrollLimit && scrollBlocked.has(obs.url)) {
      // Mana karne ke baad bhi scroll maanga: yahin ruk jao, list screen pe khuli hai
      return {
        end: { kind: 'done', message: "I've opened the results on the page. Scroll down to see more." },
        history,
        plan,
      };
    }
    if (action.type === 'scroll' && !overScrollLimit) scrolls.set(obs.url, (scrolls.get(obs.url) ?? 0) + 1);

    // Pichhli baar bilkul yahi kiya aur screen pe kuch nahi badla: dobara mat karo
    const noEffectRepeat =
      !repeatable && same(history[history.length - 1]) && changes.startsWith('Nothing changed on the screen.');

    if (looping) {
      warnedStuck = true;
      result = {
        ok: false,
        message: `Not done: you are going in circles (${summary} again). This isn't working. Skip this plan step or do it another way, and move on.`,
      };
    } else if (noEffectRepeat) {
      result = {
        ok: false,
        message: 'Not done: you just did exactly this and nothing changed on the screen. Try something different (hover, another element, or the search box).',
      };
    } else if (overScrollLimit) {
      scrollBlocked.add(obs.url);
      result = {
        ok: false,
        message: `Scroll limit reached (${MAX_SCROLLS_PER_PAGE} scrolls on this page). Don't scroll again. Finish now with "done": give what you have found so far (e.g. the list you have seen); the user can scroll for more.`,
      };
    } else if ('id' in action && !el) {
      result = { ok: false, message: `There is no element [${action.id}] on screen. Use an id from the list.` };
    } else if (action.type === 'type' && el?.secret) {
      result = {
        ok: false,
        message: 'Not allowed: Quick Peek never types passwords, card numbers or OTPs. Use ask_user so the user fills it in.',
      };
    } else if (madeUpNumber(action, goal)) {
      result = {
        ok: false,
        message: `Not allowed: "${madeUpNumber(action, goal)}" is not in the user's instructions. Never make up values the user didn't give. Use ask_user if you need it.`,
      };
    } else if (needsConfirm && !(await confirm(summary))) {
      return { end: { kind: 'stopped', message: `Stopped: you didn't allow "${summary}".` }, history, plan };
    } else {
      onStatus(`${summary}…`);
      try {
        if (action.type === 'find') {
          // Poore DOM mein dhoondho (bina scroll). Mile to agle turn ki list mein aayenge
          const query = action.text;
          const seen = await inTab(tabId, observePage, false, { find: query });
          const offScreenHits = seen.elements.filter((e) => /\(found, /.test(e.line)).length;
          const onScreenHits = seen.elements.filter(
            (e) => !/ screen\)$/.test(e.line) && e.label.toLowerCase().includes(query.toLowerCase()),
          ).length;
          if (offScreenHits) findText = query;
          result = offScreenHits
            ? { ok: true, message: `found ${offScreenHits} match(es) not on screen; they are in the element list now, marked (found, ...)` }
            : onScreenHits
              ? { ok: true, message: `"${query}" is already on screen; use it from the element list` }
              : { ok: false, message: `nothing with "${query}" on this page; try another word` };
        } else if (action.type === 'goto') {
          if (!/^https?:\/\//i.test(action.url)) {
            result = { ok: false, message: 'Only http(s) URLs can be opened.' };
          } else {
            await browser.tabs.update(tabId, { url: action.url });
            result = { ok: true, message: 'opened' };
          }
        } else if (action.type === 'back') {
          await browser.tabs.goBack(tabId);
          result = { ok: true, message: 'went back' };
        } else if (action.type === 'wait') {
          await sleep(1500);
          result = { ok: true, message: 'waited' };
        } else {
          result = await withNewTabsRedirected(tabId, () => inTab(tabId, actOnPage, action));
        }
      } catch (err) {
        // Click se page badal gaya to script beech mein band ho jaati hai: ye galti nahi hai
        const msg = (err as Error).message ?? '';
        result = /frame|navigat|removed|closed/i.test(msg)
          ? { ok: true, message: 'page changed' }
          : { ok: false, message: msg };
      }
      if (action.type !== 'find') await waitForPage(tabId); // find page nahi badalta
    }

    const step: AgentStep = {
      thought,
      action,
      summary,
      url: obs.url,
      planStep,
      result: result.ok ? result.message : `error: ${result.message}`,
    };
    history.push(step);
    onStep(step);
  }

  return {
    end: { kind: 'error', message: `Stopped after ${MAX_STEPS} steps without finishing. Try a smaller, more specific instruction.` },
    history,
    plan,
  };
}
