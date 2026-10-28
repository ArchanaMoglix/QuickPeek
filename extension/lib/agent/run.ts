// Agent loop: dekho (page + screenshot) → server se agla action poochho → karo → dobara.

import { askAgentPlan, askAgentReplan, askAgentStep } from '@/lib/api';
import { RESTRICTED } from '@/lib/extract';
import { captureScreenshot } from '@/lib/screenshot';
import { actOnPage, clickedState, hasElement, observePage, waitForQuiet } from './page';
import type { ActionResult, AgentAction, AgentStep, ElementInfo, Observation } from './types';

export const MAX_STEPS = 25;
const MAX_SCROLLS_PER_PAGE = 3; // iske baad user khud scroll kar sakta hai
const MAX_ACTIONS_PER_PLAN_STEP = 6;
const REPLAN_EVERY = 8; // itne actions ke baad planner progress check karta hai (atakne pe turant)
const NOTE_TURNS = 3; // planner ki salaah itni model calls tak bhejte hain

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
  preApproved?: boolean; // user ne cart summary pe "haan" kaha: checkout ke clicks pe dobara mat poochho
}

// Debug logs: service worker console mein dikhte hain
// (chrome://extensions → Quick Peek → "Inspect views: service worker")
const LOG = '%c[QP agent]';
const LOG_STYLE = 'color:#7c3aed;font-weight:bold';
const log = (...args: unknown[]) => console.log(LOG, LOG_STYLE, ...args);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function inTab<A extends unknown[], R>(tabId: number, func: (...args: A) => R, ...args: A): Promise<R> {
  const [res] = await browser.scripting.executeScript({ target: { tabId }, func, args } as never);
  return (res as { result: R }).result;
}

// Click ke baad naya page load ho raha ho to uske poore hone ka intezaar
async function waitForPage(tabId: number) {
  await sleep(300);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === 'complete') break;
    await sleep(250);
  }
  await inTab(tabId, waitForQuiet).catch(() => {}); // JS se aane wala content
}

function describe(action: AgentAction, el?: ElementInfo): string {
  // "ADD" jaise aam naam ke saath product bhi: alag products ke ADD ek jaise na lagen (chakkar ki ginti mein bhi)
  const name = el
    ? `"${el.label}"${el.context && el.label.length <= 25 ? ` (${el.context})` : ''}`
    : `[${'id' in action ? action.id : ''}]`;
  switch (action.type) {
    case 'click': return `Click ${name}`;
    case 'hover': return `Hover over ${name}`;
    case 'inspect': return `Inspect ${name}`;
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

// Screenshot (vision model) sirf tab jab text kaafi na ho. Server pe needsVision() jaisa hi rule:
// har step pe screenshot lena aur bhejna dheema hai, aur text model use dekhta bhi nahi
const VISUAL_GOAL = /\b(image|images|picture|photo|colou?r|logo|icon|chart|graph|map|captcha|screenshot|looks? like)\b/i;
function wantScreenshot(goal: string, obs: Observation, history: AgentStep[], changes: string): boolean {
  if (obs.elements.length < 5 && obs.visibleText.length < 200) return true;
  if (VISUAL_GOAL.test(goal)) return true;
  const last = history.slice(-2);
  if (last.length === 2 && last.every((s) => s.result.startsWith('error'))) return true;
  return history.length > 0 && changes.startsWith('Nothing changed');
}

// Payment page: kam se kam 2 alag payment options dikh rahe hon (UPI, card, net banking...)
const PAYMENT_WORDS = /\b(upi|credit card|debit card|net ?banking|wallets?|cash on delivery|pay on delivery|card number|cvv|paytm|phonepe|google pay|gpay|bhim)\b/gi;
function looksLikePayment(obs: Observation): boolean {
  const text = `${obs.visibleText}\n${obs.elements.map((e) => e.label).join('\n')}`;
  const found = new Set((text.match(PAYMENT_WORDS) ?? []).map((w) => w.toLowerCase().replace(/\s+/g, '')));
  return found.size >= 2;
}

// "To pay ₹245", "Total ₹245", "Pay ₹245": kitna dena hai
function paymentAmount(text: string): string {
  // Pehle "to pay" / "grand total" (asli dena), phir hi "total" (warna "Items total" pakad leta hai)
  for (const label of ['to pay', 'grand total', 'amount payable', 'pay', 'total']) {
    const m = text.match(new RegExp(`${label}[^₹\\d\\n]{0,20}(₹\\s?[\\d,]+(?:\\.\\d+)?)`, 'i'));
    if (m?.[1]) return m[1].replace(/\s+/g, '');
  }
  return '';
}

// "5k" = 5000, "1.5k" = 1500, "2L" / "2 lakh" = 200000: user ke shortcut ko poora number bhi maano
function expandShortNumbers(t: string): string {
  return t.replace(/(\d+(?:\.\d+)?)\s*(k|l|lakh|lakhs|lac)\b/gi, (all, n: string, unit: string) => {
    const mult = unit.toLowerCase() === 'k' ? 1_000 : 100_000;
    return `${all} ${Math.round(Number(n) * mult)}`;
  });
}

// Model ne koi number (pincode, phone...) khud bana ke type kiya? Wo number user ke instruction mein hona chahiye
function madeUpNumber(action: AgentAction, goal: string): string | null {
  if (action.type !== 'type') return null;
  const plain = (t: string) => t.replace(/(\d),(?=\d)/g, '$1'); // "10,000" = "10000"
  const g = plain(expandShortNumbers(goal));
  return (plain(action.text).match(/\d{4,}/g) ?? []).find((n) => !g.includes(n)) ?? null;
}

// "open moglix.com ..." / "go to https://..." : site ka address goal ki shuruaat mein ho to
// model se poochhe bina seedha khol do
function siteToOpen(goal: string): string | null {
  const m = goal.trim().match(/^(?:please\s+)?(?:open|go to|goto|visit|navigate to)\s+((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)/i);
  if (!m) return null;
  const site = (m[1] ?? '').replace(/[.,;!?]+$/, '');
  return /^https?:\/\//i.test(site) ? site : `https://${site}`;
}

export interface RunResult {
  end: RunEnd;
  history: AgentStep[];
  plan: string[];
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { tabId, goal, signal, onStatus, onStep, onPlan, confirm } = opts;
  let checkoutSkips = opts.preApproved ? 2 : 0; // jaise "Proceed" → "Proceed to pay"
  const history: AgentStep[] = [...(opts.history ?? [])];
  let plan: string[] = opts.plan ?? [];
  let planStep = history[history.length - 1]?.planStep ?? 1;
  const stopped = (): RunResult => {
    log('⏹ stopped by user');
    return { end: { kind: 'stopped', message: 'Stopped.' }, history, plan };
  };
  log('▶ run started', { tabId, goal, resumedSteps: history.length });

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
  log('📋 plan:', plan, '| starting at step', planStep);
  onPlan(plan, planStep);

  // Seedha site kholna ho (aur us site pe pehle se nahi hain): bina model ke
  const site = history.length ? null : siteToOpen(goal);
  if (site) {
    const tab = await browser.tabs.get(tabId);
    const host = new URL(site).host.replace(/^www\./, '');
    let onSite = false;
    try {
      onSite = !!tab.url && new URL(tab.url).host.replace(/^www\./, '').endsWith(host);
    } catch { /* chrome:// jaise URL */ }
    if (!onSite) {
      const action: AgentAction = { type: 'goto', url: site };
      const summary = describe(action);
      onStatus(`${summary}…`);
      log('🌐 opening site directly (no model call):', site);
      await browser.tabs.update(tabId, { url: site });
      await waitForPage(tabId);
      const step: AgentStep = { thought: 'Open the site from the goal', action, summary, url: tab.url, planStep: 1, result: 'opened' };
      history.push(step);
      onStep(step);
    }
  }

  let lastTypedSearchish = false; // aakhri baar search box mein type kiya tha?
  let prevObs: Observation | null = null; // pichhle step ki screen
  let warnedStuck = false; // ek baar "tum ghoom rahe ho" bata diya
  let stuckForPlanner = false; // chakkar mila: planner se naya tareeka maango
  let stuckReplans = 0; // chakkar ke baad planner ne kitni baar plan badla
  let lastReplanAt = history.length; // kitne actions par aakhri progress check hua
  let lastReplanOk = true;
  let plannerNote = '';
  let noteTurnsLeft = 0;
  let findText: string | undefined; // model ke "find" ke shabd: agli list mein unke elements
  const scrolls = new Map<string, number>(); // har page pe kitni baar scroll kiya
  const scrollBlocked = new Set<string>(); // in pages pe scroll ki limit bata di gayi hai
  // Jin elements pe do baar click se kuch nahi hua: is page pe model ko dobara nahi dikhate
  const dead = new Map<string, Set<string>>();
  let deadNote = ''; // agle turn model ko batana ki kya hataya

  for (let i = 0; i < MAX_STEPS; i++) {
    if (signal.aborted) return stopped();
    log(`──────── step ${i + 1}/${MAX_STEPS} · plan step ${planStep}: ${plan[planStep - 1] ?? '?'} ────────`);

    // 1. Dekho
    onStatus('Looking at the page…');
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || RESTRICTED.test(tab.url)) {
      return { end: { kind: 'error', message: "I can't control this page (browser internal page)." }, history, plan };
    }
    let obs: Observation;
    let screenshot: string | null = null;
    const t0 = Date.now();
    const timing: Record<string, number> = {};
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
      timing.observe = Date.now() - t0;
      const deadHere = dead.get(obs.url);
      if (deadHere?.size) {
        const keep = obs.elements.filter((e) => !deadHere.has(describe({ type: 'click', id: e.id }, e)));
        if (keep.length < obs.elements.length) {
          log('🚫 hiding elements that did nothing:', [...deadHere].join(' | '));
          const ids = new Set(keep.map((e) => e.id));
          obs = { ...obs, elements: keep, marks: obs.marks?.filter((m) => ids.has(m.id)) };
        }
      }
      if (wantScreenshot(goal, obs, history, screenChanges(prevObs, obs))) {
        const ts = Date.now();
        // Number wale boxes screenshot ki tasveer pe hi bante hain, page pe kabhi nahi
        screenshot = await captureScreenshot({ tabId, maxWidth: 1024, marks: obs.marks, viewportWidth: obs.viewportWidth });
        timing.screenshot = Date.now() - ts;
      }
      console.groupCollapsed(LOG, LOG_STYLE, `👀 observed ${obs.elements.length} elements · ${obs.url} · ${obs.scroll}`);
      console.log('title:', obs.title);
      console.log('elements:\n' + obs.elements.map((e) => e.line).join('\n'));
      console.log('visible text:\n' + obs.visibleText.slice(0, 1500));
      console.log('screenshot:', screenshot ? `${Math.round(screenshot.length / 1024)} KB` : 'none');
      console.groupEnd();
    } catch (err) {
      return { end: { kind: 'error', message: `Couldn't read the page: ${(err as Error).message}` }, history, plan };
    }

    // Payment page aa gaya: yahin ruko. Payment hamesha user khud karta hai
    if (history.length && looksLikePayment(obs)) {
      const amount = paymentAmount(obs.visibleText);
      log('💳 payment page reached, stopping');
      return {
        end: {
          kind: 'done',
          message: `Your order is ready for payment${amount ? ` (${amount})` : ''}. Please choose a payment method and complete the payment yourself; I don't make payments.`,
        },
        history,
        plan,
      };
    }

    // 2. Planner se progress check: har kuch actions, ya kaam atke to
    const sinceReplan = history.length - lastReplanAt;
    const lastTwo = history.slice(-2);
    let onThisStep = history.filter((h) => h.planStep === planStep).length;
    const replanReason =
      stuckForPlanner && sinceReplan >= 1 ? 'the navigator is going in circles, repeating the same actions'
      : sinceReplan >= 2 && lastTwo.length === 2 && lastTwo.every((h) => h.result.startsWith('error')) ? 'the last 2 actions failed'
      : sinceReplan >= 3 && onThisStep >= MAX_ACTIONS_PER_PLAN_STEP ? `${onThisStep} actions spent on plan step ${planStep} without finishing it`
      : sinceReplan >= REPLAN_EVERY ? 'regular progress check'
      : '';
    if (replanReason) {
      const tr = Date.now();
      onStatus('Checking progress…');
      log('🧭 progress check:', replanReason);
      const r = await askAgentReplan(
        {
          goal, plan, planStep, reason: replanReason, history,
          url: obs.url, title: obs.title, visibleText: obs.visibleText, elements: obs.elements.map((e) => e.line),
        },
        signal,
      ).catch(() => null);
      if (signal.aborted) return stopped();
      lastReplanAt = history.length;
      lastReplanOk = !!r;
      timing.replan = Date.now() - tr;
      if (r) {
        log('🧭 new plan:', r.steps, '| step', r.current, '| note:', r.note);
        plan = r.steps;
        planStep = r.current;
        plannerNote = r.note;
        noteTurnsLeft = r.note ? NOTE_TURNS : 0;
        onPlan(plan, planStep);
        onThisStep = history.filter((h) => h.planStep === planStep).length;
      }
      if (stuckForPlanner) {
        stuckForPlanner = false;
        // Naye plan ke saath ek aur mauka; dobara chakkar mein phase to run band
        if (r && stuckReplans++ < 1) warnedStuck = false;
      }
    }

    // 3. Socho
    onStatus('Deciding the next step…');
    let decision: Awaited<ReturnType<typeof askAgentStep>>;
    // Ek plan step pe bahut actions ho gaye aur planner nahi mila: aage badhne ko bolo
    const changes =
      screenChanges(prevObs, obs) +
      (deadNote ? ` | ${deadNote}` : '') +
      (!lastReplanOk && onThisStep >= MAX_ACTIONS_PER_PLAN_STEP && planStep < plan.length
        ? ` | You have spent ${onThisStep} actions on plan step ${planStep} without finishing it. Stop trying it: skip it or do it another way, and move to plan step ${planStep + 1}.`
        : '');
    deadNote = '';
    if (changes) log('🔄 changes since last action:', changes);
    const note = noteTurnsLeft-- > 0 ? plannerNote : undefined;
    const askedAt = Date.now();
    try {
      prevObs = obs;
      decision = await askAgentStep({ goal, plan, history, observation: { ...obs, marks: undefined, viewportWidth: undefined }, screenshot, changes, note }, signal);
    } catch (err) {
      if (signal.aborted) return stopped();
      log('❌ model call failed:', err);
      return { end: { kind: 'error', message: (err as Error).message }, history, plan };
    }
    if (signal.aborted) return stopped();
    timing.model = Date.now() - askedAt;
    const { thought, step: nextPlanStep } = decision;
    log(`🧠 model (${Date.now() - askedAt}ms) → plan step ${nextPlanStep ?? '-'}`, { thought, actions: decision.actions ?? [decision.action] });

    // Model ne bataya ki ab plan ke kis step pe hai
    if (nextPlanStep && nextPlanStep !== planStep) {
      planStep = nextPlanStep;
      onPlan(plan, planStep);
    }

    const actions = decision.actions?.length ? decision.actions : [decision.action];
    for (let k = 0; k < actions.length; k++) {
      const action = actions[k]!;
      if (k > 0) {
        // Baaki actions tabhi jab pichhla kaam kiya, page wahi hai aur agla element abhi bhi hai
        const prev = history[history.length - 1];
        if (!prev || prev.result.startsWith('error')) break;
        const now = await browser.tabs.get(tabId).catch(() => null);
        if (!now || now.url !== obs.url) {
          log('⏭ page changed, skipping the rest of the batch');
          break;
        }
        if ('id' in action && !(await inTab(tabId, hasElement, action.id).catch(() => false))) {
          log(`⏭ element [${action.id}] is gone, skipping the rest of the batch`);
          break;
        }
        if (signal.aborted) return stopped();
      }
      if (action.type === 'done') log('✅ done:', action.message);
      if (action.type === 'ask_user') log('❓ ask user:', action.question);
      if (action.type === 'done') return { end: { kind: 'done', message: action.message }, history, plan };
      if (action.type === 'ask_user') return { end: { kind: 'ask_user', message: action.question }, history, plan };

      const el = 'id' in action ? obs.elements.find((e) => e.id === action.id) : undefined;
      const summary = describe(action, el);
      let result: ActionResult;

      // Atakna: same action (naam se, id se nahi) 3 baar lagataar, ya 2–3 actions ka chakkar.
      // Scroll/wait dohrana normal hai (lambi list), unhe nahi ginte.
      // Type: element ka label badalta rehta hai (jaise ghoomta placeholder), isliye sirf text se milao
      const same = (s?: AgentStep) =>
        s && s.url === obs.url &&
        (s.summary === summary ||
          (action.type === 'type' && s.action.type === 'type' && s.action.text === action.text && s.result.startsWith('error')));
      const repeatable = action.type === 'scroll' || action.type === 'wait';
      // Sirf har jawab ka pehla action: ek hi jawab mein "+" do baar (quantity 2) chakkar nahi hai
      const looping =
        k === 0 && !repeatable &&
        ((same(history[history.length - 1]) && same(history[history.length - 2])) || inCycle(history, summary, obs.url));
      if (looping && warnedStuck) {
        log('🛑 stuck in a loop again, ending run');
        return {
          end: { kind: 'error', message: "I got stuck repeating the same steps, so I stopped. Try a more specific instruction." },
          history,
          plan,
        };
      }

      let needsConfirm =
        (action.type === 'click' && el?.risky) ||
        (action.type === 'type' && action.submit && !el?.enterSafe) ||
        (action.type === 'press' && action.key === 'Enter' && !lastTypedSearchish);
      if (action.type === 'type') lastTypedSearchish = !!el?.enterSafe;
      // User ne cart summary confirm kar di: checkout/proceed ke click pe dobara nahi poochhna
      // (payment page pe run khud ruk jaata hai; "Pay now" jaise button pe hamesha poochhte hain)
      if (needsConfirm && action.type === 'click' && el && checkoutSkips > 0 &&
          /checkout|check out|proceed|place order|continue/i.test(el.label) && !/^pay\b|pay now|make payment/i.test(el.label)) {
        needsConfirm = false;
        checkoutSkips--;
        log('✅ cart already confirmed by the user, no extra prompt for:', el.label);
      }

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
        k === 0 && !repeatable && same(history[history.length - 1]) && changes.startsWith('Nothing changed on the screen.');

      if (looping) {
        warnedStuck = true;
        stuckForPlanner = true;
        result = {
          ok: false,
          message: `Not done: you are going in circles (${summary} again). This isn't working. Skip this plan step or do it another way, and move on.`,
        };
      } else if (noEffectRepeat) {
        // Do baar click, kuch nahi badla: is page pe ye element list se hata do
        if ((action.type === 'click' || action.type === 'hover') && el) {
          const key = describe({ type: 'click', id: el.id }, el);
          if (!dead.has(obs.url)) dead.set(obs.url, new Set());
          dead.get(obs.url)!.add(key);
          deadNote = `${key} did nothing twice, so it is removed from the list. Use a different element.`;
        }
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
      } else if (needsConfirm && (log('🙋 asking user to confirm:', summary), !(await confirm(summary)))) {
        log('🚫 user denied:', summary);
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
            // Exact nahi mila to page.ts milte-julte deta hai: "(similar, ...)" / "(similar to ...)"
            const similar = seen.elements.filter((e) => /\(similar(, | to ")/.test(e.line));
            if (offScreenHits || similar.length) findText = query;
            const names = similar
              .map((e) => `"${e.context && e.context !== e.label ? `${e.label} in ${e.context}` : e.label}"`)
              .join(', ');
            result = offScreenHits
              ? { ok: true, message: `found ${offScreenHits} match(es) not on screen; they are in the element list now, marked (found, ...)` }
              : onScreenHits
                ? { ok: true, message: `"${query}" is already on screen; use it from the element list` }
                : similar.length
                  ? {
                      ok: true,
                      message: `no exact "${query}" on this page, but ${similar.length} close match(es): ${names}. They are marked (similar...) in the element list. Check if one fits the goal (see the closest-match rules).`,
                    }
                  : { ok: false, message: `nothing with "${query}" or anything close on this page; try another word` };
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
        if (action.type !== 'find' && action.type !== 'inspect') {
          const tw = Date.now();
          await waitForPage(tabId); // ye page nahi badalte
          timing.wait = (timing.wait ?? 0) + Date.now() - tw;
        }
        // ADD dabaya: button ab quantity dikha raha hai? Model ko seedha batao, taaki dobara ADD na kare
        if (action.type === 'click' && result.ok && el && /^(add|add to (cart|bag|basket))$/i.test(el.label)) {
          const now = await inTab(tabId, clickedState).catch(() => null);
          if (now && /^\d+$/.test(now)) {
            result = { ok: true, message: `clicked. The ADD button now shows quantity ${now}: this item is in the cart. Don't add it again.` };
          } else if (now && /^add/i.test(now)) {
            result = { ok: true, message: 'clicked, but it still shows ADD: the item may not be in the cart (look for a popup or message).' };
          }
        }
      }

      log(`${result.ok ? '✔' : '⚠'} ${summary} →`, result.message, el ? `(element: ${el.line})` : '');

      const step: AgentStep = {
        thought: k === 0 ? thought : '',
        action,
        summary,
        url: obs.url,
        planStep,
        result: result.ok ? result.message : `error: ${result.message}`,
      };
      history.push(step);
      onStep(step);
    }
    // Kahan time lag raha hai (ms): observe, screenshot, replan, model, action ke baad page ka wait
    log('⏱ step timing (ms):', { ...timing, total: Date.now() - t0 });
  }

  log(`🛑 hit MAX_STEPS (${MAX_STEPS})`);
  return {
    end: { kind: 'error', message: `Stopped after ${MAX_STEPS} steps without finishing. Try a smaller, more specific instruction.` },
    history,
    plan,
  };
}
