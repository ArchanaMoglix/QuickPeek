// ⚠️ Ye functions website ke andar chalte hain (scripting.executeScript).
// Inke andar bahar ka kuch bhi use mat karna: imports, helpers, constants sab andar hi hone chahiye.

import type { ActionResult, AgentAction, Observation } from './types';

// Screen pe dikh rahe clickable/typeable elements dhoondho, unhe number do,
// aur (drawMarks ho to) screenshot pe number ke label banane ke liye unki jagah bhi do.
// Screen ke bahar wale elements bhi (bina scroll kiye, seedha DOM se):
//   hint: jinke shabd plan ke abhi wale step se milte hain
//   find: jinke text mein ye shabd hain (model ka "find" action)
export function observePage(drawMarks: boolean, opts: { hint?: string; find?: string } = {}): Observation {
  document.getElementById('__quickpeek_marks')?.remove(); // purane version ka bacha hua layer

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]',
    '[role=textbox]', '[role=searchbox]', '[contenteditable=""]', '[contenteditable=true]',
    '[onclick]',
  ].join(',');
  const RISKY = /\b(buy|pay|purchase|order|checkout|send|delete|remove|confirm|submit|sign ?up|register|subscribe|unsubscribe|post|publish|transfer|book|log ?out|sign ?out)\b/i;
  const SECRET = /passw|card|cvv|cvc|otp|pin\b|ssn|security.?code/i;
  const SEARCH = /search|query|^q$|find|khoj/i;
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  // Kuch elements (jaise <form>) pe .name/.value string nahi hote, isliye check
  const clean = (s: unknown) => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();

  const vw = innerWidth;
  const vh = innerHeight;
  const elements: Observation['elements'] = [];
  const boxes: { id: number; r: DOMRect }[] = [];

  const CLOSE_HINT = /close|cross|dismiss|cancel/i;

  const lookOffScreen = !!(opts.hint || opts.find);
  const offScreen: { el: HTMLElement; native: boolean; r: DOMRect; inner: boolean }[] = [];

  // Saare elements, web components (open shadow root) ke andar wale bhi
  const allElements = (root: ParentNode, out: HTMLElement[] = []) => {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, out);
    }
    return out;
  };
  // elementFromPoint web component pe ruk jaata hai: uske andar tak jao
  const deepElementFromPoint = (x: number, y: number) => {
    let t = document.elementFromPoint(x, y);
    while (t?.shadowRoot) {
      const inner = t.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === t) break;
      t = inner;
    }
    return t;
  };
  // contains() shadow root ki deewar paar nahi karta
  const containsDeep = (a: Node, b: Node | null) => {
    for (let n = b; n; n = n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)) if (n === a) return true;
    return false;
  };

  // Sirf icon wale button (text nahi, jaise Blinkit ke stepper ka − / +): class se pehchaano
  const BUY_BUTTON = /^(add|add to (cart|bag|basket)|buy( now)?)$/i;
  // Tasveer ka file jaisa naam ("image-preview-2", "thumb_3"): ye naam nahi, model ko bas "photo" batao
  const PHOTO_NAME = /^[\w-]*(image|img|thumb|thumbnail|preview|photo|pic|picture|slide|banner|carousel)[\w-]*$/i;
  const ICON_MINUS = /minus|decrement|subtract/i;
  const ICON_PLUS = /plus|increment/i;
  const iconLabel = (el: HTMLElement) => {
    const classes = [el, ...Array.from(el.querySelectorAll('*')).slice(0, 4)]
      .map((e) => `${e.getAttribute('class') ?? ''} ${e.getAttribute('data-icon') ?? ''}`)
      .join(' ');
    return ICON_MINUS.test(classes) ? '−' : ICON_PLUS.test(classes) ? '+' : '';
  };

  // Clickable card ke andar ke buttons (ADD, +, −, Buy now...): inhe alag element maano
  const CONTROL_WORDS = /^(add|add to (cart|bag|basket)|buy( now)?|plus|minus|remove|delete|notify( me)?|select|choose|view|edit|save|wishlist|qty|quantity)\b|^[+\-−–]$/i;
  const CONTROL_CLASS = /btn|button|add(?!ress)|cart|qty|quantity|plus|minus|increment|decrement|stepper|counter/i;
  const innerControl = (el: HTMLElement, r: DOMRect) => {
    const own = clean(el.getAttribute('aria-label')) || clean(el.innerText) || iconLabel(el);
    if (!own || own.length > 25) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    const looksLikeButton = ['button', 'input', 'select', 'textarea'].includes(tag) ||
      /^(button|checkbox|radio|switch|tab)$/.test(el.getAttribute('role') ?? '') ||
      CONTROL_WORDS.test(own) || CONTROL_CLASS.test(cls);
    if (!looksLikeButton) return false;
    // Parent ka bhi yahi text hai aur wo bhi clickable: asli button parent hai, ye uske andar ka span
    const parent = el.parentElement;
    if (parent && clean(parent.innerText) === clean(el.innerText) && getComputedStyle(parent).cursor === 'pointer') return false;
    // Card se kaafi chhota hona chahiye (warna ye khud card ka wrapper hai)
    let owner: HTMLElement | null = null;
    for (let p = el.parentElement, i = 0; p && p !== document.body && i < 10; p = p.parentElement, i++) {
      if (p.hasAttribute('data-qp-id') || p.matches(SELECTOR) || getComputedStyle(p).cursor === 'pointer') owner = p;
    }
    const o = owner?.getBoundingClientRect();
    return !o || r.width * r.height < 0.6 * o.width * o.height;
  };
  // Element kis card/section ka hai (jaise product ka naam): pehle poora card (clickable
  // parent), warna upar ke parents mein pehla text jisme koi shabd ho (sirf "₹21 · ₹25" nahi)
  const NOISE_LINE = /^(\d+\s*%\s*off|\d+\s*mins?|add|[+\-−–]|\d+)$/i;
  const contextOf = (el: HTMLElement, label: string) => {
    const linesOf = (p: HTMLElement) =>
      (p.innerText ?? '').split('\n').map(clean).filter((l) => l.length > 1 && l !== label && !NOISE_LINE.test(l));
    const card = el.parentElement?.closest<HTMLElement>(`${SELECTOR}, [data-qp-id]`);
    if (card && card !== document.body) {
      const text = linesOf(card).slice(0, 4).join(' · ');
      if (/\p{L}{3,}/u.test(text)) return clip(text, 100);
    }
    for (let p = el.parentElement, i = 0; p && p !== document.body && i < 8; p = p.parentElement, i++) {
      const text = linesOf(p).slice(0, 4).join(' · ');
      if (/\p{L}{3,}/u.test(text)) return clip(text, 100);
    }
    return '';
  };

  // Pichhli baar (isi page pe) kaun se elements the: naye wale * se dikhayenge
  const memo = window as unknown as { __qpSeen?: { url: string; keys: string[] } };
  const prevSeen = memo.__qpSeen?.url === location.href ? new Set(memo.__qpSeen.keys) : null;
  const keys: string[] = [];

  // Ek element ko number do aur model ke liye uski line banao
  const add = (el: HTMLElement, native: boolean, r: DOMRect, note: string, inner = false) => {
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const role = el.getAttribute('role') ?? '';
    const type = tag === 'input' ? (input.type || 'text') : '';
    const placeholder = clean(el.getAttribute('placeholder'));
    const aria = clean(el.getAttribute('aria-label'));
    const text = clean(el.innerText);
    const classHint = `${typeof el.className === 'string' ? el.className : ''} ${el.id}`;
    let label = clip(
      aria || text || clean(el.getAttribute('title')) || placeholder ||
        clean(el.getAttribute('alt')) || clean(el.querySelector('img')?.alt) ||
        clean(el.querySelector('[aria-label]')?.getAttribute('aria-label')) ||
        clean(el.querySelector('title')?.textContent) || clean(input.name) || iconLabel(el) ||
        (CLOSE_HINT.test(classHint) ? '× close' : ''),
      60,
    );
    // Link ke bahar ki photo (product page ke thumbnails): click se sirf badi photo badalti hai
    let photoOnly = false;
    if (PHOTO_NAME.test(label)) {
      label = 'photo';
      photoOnly = !el.closest('a');
    }
    const idName = `${input.name ?? ''} ${el.id} ${el.getAttribute('autocomplete') ?? ''}`;
    const secret = type === 'password' || /cc-|one-time-code|password/.test(el.getAttribute('autocomplete') ?? '') ||
      (['input', 'textarea'].includes(tag) && SECRET.test(idName));
    const looksSearch = type === 'search' || role === 'searchbox' || role === 'combobox' ||
      SEARCH.test(`${input.name ?? ''} ${el.id} ${placeholder} ${aria}`) ||
      // Nakli search box (div/a jiska text '! Search "milk"' hai; "!" icon ka akshar hai)
      (!['input', 'textarea', 'button'].includes(tag) && /\bsearch\b/i.test(label));
    // Type karke Enter: aam taur pe safe (search, filter, pincode...). Permission sirf jahan Enter
    // kuch bhej sakta hai: message/comment box, login form, ya form jiska button Pay/Order/Send ho
    const form = input.form ?? el.closest('form');
    const formRisky = !!form && (
      !!form.querySelector('input[type=password]') ||
      Array.from(form.querySelectorAll<HTMLElement>('button, input[type=submit]'))
        .some((b) => RISKY.test(clean(b.innerText) || clean((b as HTMLInputElement).value)))
    );
    const composer = tag === 'textarea' || el.isContentEditable ||
      /message|comment|reply|post|tweet|write|chat|review|feedback/i.test(`${placeholder} ${aria} ${input.name ?? ''}`);
    const enterSafe = !secret && !formRisky && (looksSearch || !composer);
    const risky = RISKY.test(label) || RISKY.test(clean((el as HTMLInputElement).value));

    const id = elements.length + 1;
    el.setAttribute('data-qp-id', String(id));
    if (native) el.setAttribute('data-qp-native', '');

    let line = `[${id}] ${tag}${type ? ` type=${type}` : ''}${role ? ` role=${role}` : ''}`;
    if (label) line += ` "${label}"`;
    if (placeholder && placeholder !== label) line += ` placeholder="${clip(placeholder, 40)}"`;
    if (['input', 'textarea'].includes(tag) && !['checkbox', 'radio', 'submit', 'button'].includes(type)) {
      line += secret ? ' value=<hidden>' : ` value="${clip(input.value ?? '', 40)}"`;
    }
    if (type === 'checkbox' || type === 'radio') line += input.checked ? ' (checked)' : ' (unchecked)';
    // Custom checkbox: asli input chhupa hota hai, label dikhta hai
    const control = tag === 'label' ? (el as HTMLLabelElement).control : null;
    if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) {
      line += control.checked ? ' (checked)' : ' (unchecked)';
    }
    if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.options).slice(0, 8).map((o) => clip(clean(o.text), 25));
      line += ` selected="${clip(clean(sel.selectedOptions[0]?.text), 30)}" options=[${opts.join(' | ')}]`;
    }
    if (tag === 'a') {
      const href = (el as HTMLAnchorElement).href;
      try {
        const u = new URL(href);
        line += ` → ${u.host === location.host ? '' : u.host}${clip(u.pathname, 40)}`;
      } catch { /* javascript: links etc. */ }
    }
    if ((el as HTMLButtonElement).disabled) line += ' (disabled)';

    // Quantity stepper (ADD dabane ke baad "− 1 +"): number pe click se kuch nahi hota
    const sibText = clean(el.parentElement?.innerText);
    const buttonsIn = (e: HTMLElement | null) => e?.querySelectorAll('button, [role=button]').length ?? 0;
    if (/^\d+$/.test(label) && (buttonsIn(el) >= 2 || buttonsIn(el.parentElement) >= 3 || (/[+]/.test(sibText) && /[−\-–]/.test(sibText)))) {
      line += ` (quantity stepper: ${label} already in cart; use the + / − buttons to change it)`;
    } else if (/^[−\-–]\s*\d+\s*\+$/.test(label)) {
      line += ` (quantity stepper: ${label.replace(/\D/g, '')} in cart)`;
    }
    // Card ke andar ka button, ya "ADD"/"Buy now" jaisa aam naam: kis product ka hai
    let context = '';
    if (inner || CONTROL_WORDS.test(label) || /^\d+$/.test(label)) {
      context = contextOf(el, label);
      if (context) line += ` in "${context}"`;
    }
    if (photoOnly) line += ' (picture only: clicking it just changes the photo, it does not add or open anything)';
    if (note) line += ` (${note})`;

    const key = `${tag}|${label}`;
    keys.push(key);
    if (prevSeen && !prevSeen.has(key)) line = '*' + line;

    elements.push({ id, line, label: label || tag, context: clip(context.split(' · ')[0] ?? '', 40) || undefined, secret, risky, enterSafe });
    if (!note) boxes.push({ id, r }); // screenshot pe number sirf screen wale elements pe
  };

  // Document order mein saare elements: asli buttons/links/inputs, aur woh div/span
  // jinpe cursor "pointer" ho (Angular/React sites aise clickable div bahut banati hain)
  for (const el of allElements(document.body)) {
    // Pichhli baar ke number hatao (parent pehle aata hai, isliye closest() neeche sahi kaam karta hai)
    if (el.hasAttribute('data-qp-id')) {
      el.removeAttribute('data-qp-id');
      el.removeAttribute('data-qp-native');
    }
    if (el.id === '__quickpeek_overlay' || el.closest('#__quickpeek_overlay')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const onScreen = !(r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw);
    // 250 ke baad bhi ADD / Add to cart jaise button lo: lambe product page pe wahi chahiye
    if (onScreen ? elements.length >= 250 && !BUY_BUTTON.test(clean(el.innerText)) : !lookOffScreen) continue;

    const native = el.matches(SELECTOR);
    const style = getComputedStyle(el);
    let inner = false;
    if (!native) {
      if (style.cursor !== 'pointer') continue;
      const parent = el.parentElement;
      // Clickable box ke andar ka hissa (cursor parent se aata hai): sirf apne button (ADD, +) chahiye
      const nested = (parent && getComputedStyle(parent).cursor === 'pointer') || el.closest('[data-qp-id]');
      if (nested) {
        if (!innerControl(el, r)) continue;
        inner = true;
      }
    } else if (el.parentElement?.closest(onScreen ? '[data-qp-native]' : SELECTOR)) {
      // Jaise <a> product card ke andar <button>ADD</button>; <button> ke andar <span role=button> nahi
      if (!innerControl(el, r)) continue;
      inner = true;
    }
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

    if (!onScreen) {
      offScreen.push({ el, native, r, inner }); // baad mein: sirf kaam wale chunenge
      continue;
    }

    // Kisi popup/overlay ke neeche chhupa hai to skip
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const top = deepElementFromPoint(cx, cy);
    // Quick Peek ka apna overlay card "dhakna" nahi ginte (screenshot mein wo chhup jaata hai)
    if (top && !containsDeep(el, top) && !containsDeep(top, el) && !top.closest('#__quickpeek_overlay')) continue;

    add(el, native, r, '', inner);
  }

  // Screen ke bahar wale: "find" ke shabd wale, phir plan step se milte-julte
  if (lookOffScreen) {
    const STOP = new Set(
      'the and for with this that from into your you are was were have has will can all any its our out not but what which then than them they these those page site click open apply select check find show only more less make sure item items results result'.split(' '),
    );
    const words = (t: string) =>
      t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w));
    const labelOf = (el: HTMLElement) =>
      clean(el.getAttribute('aria-label')) || clean(el.innerText) || clean(el.getAttribute('title')) ||
      clean(el.getAttribute('placeholder')) || clean(el.querySelector('img')?.alt);
    const where = (r: DOMRect) =>
      r.bottom < 0 ? 'above screen' : r.top > vh ? 'below screen' : 'off screen';

    const findText = clean(opts.find).toLowerCase();
    const hintWords = new Set(words(opts.hint ?? ''));
    const found: typeof offScreen = [];
    const related: ((typeof offScreen)[number] & { score: number })[] = [];
    for (const c of offScreen) {
      const label = labelOf(c.el);
      if (!label) continue;
      if (findText && label.toLowerCase().includes(findText)) {
        found.push(c);
        continue;
      }
      // Card ke andar ka button ("ADD"): card ke text se milao, jaise "Coca Cola 2 L"
      const lw = words(c.inner || CONTROL_WORDS.test(label) ? `${label} ${contextOf(c.el, label)}` : label);
      const hits = new Set(lw.filter((w) => hintWords.has(w))).size;
      // Lambe label (jaise product ke naam) apne aap zyada shabd match karte hain: thoda kam number
      if (hits) related.push({ ...c, score: hits / Math.sqrt(lw.length) });
    }
    for (const c of found.slice(0, 15)) add(c.el, c.native, c.r, `found, ${where(c.r)}`, c.inner);

    // Exact match kahin nahi mila: milte-julte dikhao ("2 litre" ≈ "2L", "pepsi black" ≈ "Pepsi No Sugar")
    const exactOnScreen = findText && elements.some((e) => e.label.toLowerCase().includes(findText));
    if (findText && !found.length && !exactOnScreen) {
      // Units ek jaise likho: "2 litre" / "2 ltr" / "2L" → "2l"
      const norm = (t: string) =>
        t.toLowerCase()
          .replace(/(\d),(?=\d{3})/g, '$1')
          .replace(/(\d+(?:\.\d+)?)\s*(litres?|liters?|ltrs?|lt|l)\b/g, '$1l')
          .replace(/(\d+(?:\.\d+)?)\s*(millilitres?|milliliters?|ml)\b/g, '$1ml')
          .replace(/(\d+(?:\.\d+)?)\s*(kilograms?|kgs?)\b/g, '$1kg')
          .replace(/(\d+(?:\.\d+)?)\s*(grams?|gms?|gm|g)\b/g, '$1g')
          .replace(/(\d+(?:\.\d+)?)\s*(pieces?|pcs?)\b/g, '$1pc')
          .replace(/(\d+(?:\.\d+)?)\s*(millimet(?:er|re)s?|mm)\b/g, '$1mm')
          .replace(/(\d+(?:\.\d+)?)\s*(inch(?:es)?|in|")(?=\s|$)/g, '$1in');
      const tokens = (t: string) =>
        norm(t).split(/[^\p{L}\p{N}.]+/u).map((w) => w.replace(/^\.+|\.+$/g, ''))
          .filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w));
      const grams = (w: string) => {
        const s = `  ${w} `;
        const out = new Set<string>();
        for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
        return out;
      };
      const dice = (a: string, b: string) => {
        const ga = grams(a), gb = grams(b);
        let common = 0;
        for (const g of ga) if (gb.has(g)) common++;
        return (2 * common) / (ga.size + gb.size);
      };
      // Ek shabd ka sabse acha match: same = 1, shuru same ("choco" / "chocolate") = 0.8,
      // spelling ki galti = trigram. Number/size bilkul same hone chahiye.
      const wordScore = (q: string, label: string[]) => {
        let best = 0;
        for (const w of label) {
          if (w === q) return 1;
          if (/\d/.test(q) || /\d/.test(w)) continue;
          if (q.length >= 3 && w.length >= 3 && (w.startsWith(q) || q.startsWith(w))) best = Math.max(best, 0.8);
          else best = Math.max(best, dice(q, w) >= 0.45 ? dice(q, w) * 0.8 : 0);
        }
        return best;
      };
      const qTokens = tokens(findText);
      const qJoined = qTokens.join('');
      const similarity = (text: string) => {
        const lt = tokens(text);
        if (!qTokens.length || !lt.length) return 0;
        const perWord = qTokens.reduce((s, q) => s + wordScore(q, lt), 0) / qTokens.length;
        // "cocacola" vs "Coca Cola": poore string ko bhi milao
        const whole = qJoined.length >= 4 ? dice(qJoined, lt.join('')) * 0.9 : 0;
        return Math.max(perWord, whole);
      };
      const MIN_SIMILAR = 0.5;

      // Screen wale: unki line pe hi nishaan laga do. Sirf naam + card se milao, poori line se nahi:
      // line mein "(quantity stepper: 1 already in cart)" jaise note hote hain, "cart" dhoondhne pe "+" mil jaata tha
      const screenHits = elements
        .map((e) => ({ e, score: similarity(`${e.label} ${e.context ?? ''}`) }))
        .filter((h) => h.score >= MIN_SIMILAR)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      for (const h of screenHits) h.e.line += ` (similar to "${clip(findText, 30)}")`;

      // Screen ke bahar wale
      const offHits = offScreen
        .map((c) => {
          const label = labelOf(c.el);
          if (!label) return null;
          const text = c.inner || CONTROL_WORDS.test(label) ? `${label} ${contextOf(c.el, label)}` : label;
          return { c, score: similarity(text) };
        })
        .filter((h): h is NonNullable<typeof h> => !!h && h.score >= MIN_SIMILAR)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      for (const { c } of offHits) {
        if (!c.el.hasAttribute('data-qp-id')) add(c.el, c.native, c.r, `similar, ${where(c.r)}`, c.inner);
      }
    }

    related.sort((a, b) => b.score - a.score);
    for (const c of related.slice(0, 20)) {
      if (!c.el.hasAttribute('data-qp-id')) add(c.el, c.native, c.r, where(c.r), c.inner);
    }
  }

  // Screen pe dikh rahe text ka chhota hissa, taaki model jawab padh sake
  let visibleText = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && visibleText.length < 5000) {
    const node = walker.currentNode;
    const t = clean(node.textContent);
    const parent = node.parentElement;
    if (!t || !parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
    const r = parent.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
    visibleText += t + '\n'; // alag lines: pichhli screen se farak nikalne ke liye
  }

  // Agent ki apni "dekho" call (drawMarks) ke liye yaad rakho; find/plan wali chhoti calls ke liye nahi
  if (drawMarks) memo.__qpSeen = { url: location.href, keys };

  const maxScroll = document.documentElement.scrollHeight - vh;
  const scroll = maxScroll <= 0
    ? 'whole page visible'
    : scrollY <= 0 ? 'top of page (more below)'
    : scrollY >= maxScroll - 2 ? 'bottom of page'
    : `${Math.round((scrollY / maxScroll) * 100)}% down (more below)`;

  // Laal boxes page pe nahi banate (user ko dikhte the): sirf unki jagah bhejte hain, background screenshot pe banata hai
  const marks = drawMarks
    ? boxes.map(({ id, r }) => ({ id, x: r.left, y: r.top, w: r.width, h: r.height }))
    : undefined;
  return {
    url: location.href, title: document.title, scroll, visibleText: visibleText.trim(), elements,
    marks, viewportWidth: innerWidth,
  };
}

// Ek action page pe karo
export function actOnPage(action: AgentAction): ActionResult {
  const find = (id: number) => {
    const sel = `[data-qp-id="${id}"]`;
    // Web components (shadow root) ke andar bhi dhoondho
    const search = (root: ParentNode): HTMLElement | null => {
      const hit = root.querySelector<HTMLElement>(sel);
      if (hit) return hit;
      for (const e of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
        const inShadow = e.shadowRoot && search(e.shadowRoot);
        if (inShadow) return inShadow;
      }
      return null;
    };
    const el = search(document);
    // Website ke apne console mein (page ka DevTools): kaunsa asli element mila
    console.log('%c[QP agent]', 'color:#7c3aed;font-weight:bold', `${action.type} → [${id}]`, el ?? 'NOT FOUND');
    return el;
  };

  // Asli mouse jaisa "upar aana": hover se khulne wale menus ke liye.
  // mouseenter bubble nahi karta, isliye har parent pe bhi bhejo (browser bhi aisa hi karta hai)
  const hoverOn = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
      node.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
      node.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    }
    el.dispatchEvent(new PointerEvent('pointermove', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
  };

  const pressEnter = (el: HTMLElement) => {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    // Nakli Enter se form submit nahi hota, isliye khud submit karo (agar site ne rok na diya ho)
    const form = (el as HTMLInputElement).form;
    if (notCancelled && form) form.requestSubmit();
  };

  switch (action.type) {
    case 'click': {
      const el = find(action.id);
      if (!el) return { ok: false, message: `Element [${action.id}] not found. The page may have changed.` };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      // Naye tab mein khulne wale link ko isi tab mein kholo, taaki agent dekh sake
      if (el instanceof HTMLAnchorElement && el.target === '_blank') el.target = '_self';
      (window as unknown as { __qpLastClicked?: HTMLElement }).__qpLastClicked = el; // ADD ke baad kya dikha, ye dekhne ke liye
      hoverOn(el); // asli user click se pehle mouse wahan le jaata hai
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.focus();
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      const textBox =
        (el instanceof HTMLInputElement && !['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset'].includes(el.type)) ||
        el instanceof HTMLTextAreaElement || el.isContentEditable;
      if (textBox) return { ok: true, message: 'clicked the text box, it is focused. Now use "type" on it to enter text.' };
      return { ok: true, message: 'clicked' };
    }

    case 'hover': {
      const el = find(action.id);
      if (!el) return { ok: false, message: `Element [${action.id}] not found. The page may have changed.` };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      hoverOn(el);
      return { ok: true, message: 'hovered (menus that open on hover should now be visible)' };
    }

    case 'inspect': {
      const el = find(action.id);
      if (!el) return { ok: false, message: `Element [${action.id}] not found. The page may have changed.` };
      const one = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
      const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '…' : t);
      // Sirf opening tag (andar ka poora HTML bahut lamba hota hai) + text
      const openTag = (e: Element) =>
        `<${e.tagName.toLowerCase()}${Array.from(e.attributes)
          .filter((a) => a.name !== 'style' && !a.name.startsWith('data-qp') && !a.name.startsWith('_ng'))
          .slice(0, 12)
          .map((a) => (a.value === '' ? ` ${a.name}` : ` ${a.name}="${clip(one(a.value), 150)}"`))
          .join('')}>`;
      // Upar ke 2 parents bhi: product card wagairah pehchaanne ke liye
      const parents: string[] = [];
      for (let p = el.parentElement, i = 0; p && p !== document.body && i < 2; p = p.parentElement, i++) parents.push(openTag(p));
      const html = `${openTag(el)}${clip(one(el.innerText), 80)}</${el.tagName.toLowerCase()}>`;
      return { ok: true, message: `HTML: ${html} | parents: ${parents.join(' > ') || 'none'}`.slice(0, 900) };
    }

    case 'type': {
      const el = find(action.id);
      if (!el) return { ok: false, message: `Element [${action.id}] not found. The page may have changed.` };
      el.scrollIntoView({ block: 'center' });
      const isTextBox = (e: Element | null): boolean =>
        (e instanceof HTMLInputElement && !['button', 'submit', 'checkbox', 'radio', 'file', 'image', 'reset', 'hidden'].includes(e.type)) ||
        e instanceof HTMLTextAreaElement || (e instanceof HTMLElement && e.isContentEditable);
      const fill = (box: HTMLElement) => {
        box.focus();
        if (box instanceof HTMLInputElement || box instanceof HTMLTextAreaElement) {
          // React jaise frameworks ke liye native setter use karo, warna wo value ignore kar dete hain
          const proto = box instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(box, action.text);
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          document.getSelection()?.selectAllChildren(box);
          document.execCommand('insertText', false, action.text);
        }
        if (action.submit) pressEnter(box);
        return { ok: true, message: action.submit ? 'typed and pressed Enter' : 'typed' };
      };

      // Asli text box, ya uske andar chhupa hua input
      const inner = isTextBox(el) ? el : el.querySelector('input, textarea, [contenteditable=""], [contenteditable=true]');
      if (isTextBox(inner)) return fill(inner as HTMLElement);

      // Nakli search box (jaise Blinkit: div jisme "Search milk" ghoomta hai): click karne pe
      // asli input khulta hai. Click karo; turant focus mein input aa gaya to usi mein type karo.
      // Baaki (category, link...) pe click nahi: galat element pe type maanga hai
      const hint = `${el.innerText} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${typeof el.className === 'string' ? el.className : ''}`;
      if (!/search/i.test(hint)) {
        return { ok: false, message: `[${action.id}] is not a text field. Type into an input (search box) from the element list.` };
      }
      el.click();
      if (isTextBox(document.activeElement)) return fill(document.activeElement as HTMLElement);
      return {
        ok: true,
        message: `[${action.id}] is not a text box, so I clicked it instead (nothing typed yet). It probably opened the real search box: look at the new element list and type into the input there.`,
      };
    }

    case 'select': {
      const el = find(action.id);
      if (!el) return { ok: false, message: `Element [${action.id}] not found. The page may have changed.` };
      if (!(el instanceof HTMLSelectElement)) {
        // Custom dropdown (div wala): khol do, agle step mein model option pe click karega
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, message: `[${action.id}] is a custom dropdown, so I clicked it to open it. Now click the "${action.option}" option.` };
      }
      const want = action.option.toLowerCase();
      const opt = Array.from(el.options).find(
        (o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want,
      ) ?? Array.from(el.options).find((o) => o.text.toLowerCase().includes(want));
      if (!opt) return { ok: false, message: `No option "${action.option}" in [${action.id}].` };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, message: `selected "${opt.text.trim()}"` };
    }

    case 'press': {
      const el = (document.activeElement as HTMLElement | null) ?? document.body;
      if (action.key === 'Enter') {
        pressEnter(el);
      } else {
        const init = { key: action.key, code: action.key, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
      }
      return { ok: true, message: `pressed ${action.key}` };
    }

    case 'scroll': {
      const amount = (action.direction === 'down' ? 1 : -1) * innerHeight * 0.8;
      const before = scrollY;
      window.scrollBy({ top: amount, behavior: 'instant' });
      if (scrollY !== before) return { ok: true, message: `scrolled ${action.direction}` };

      // Kuch sites (apps) poora page nahi, andar ka ek box scroll karti hain
      const boxes = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((e) => {
        const s = getComputedStyle(e).overflowY;
        return (s === 'auto' || s === 'scroll') && e.scrollHeight > e.clientHeight + 20;
      });
      const biggest = boxes.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
      if (biggest) {
        const prev = biggest.scrollTop;
        biggest.scrollBy({ top: amount, behavior: 'instant' });
        if (biggest.scrollTop !== prev) return { ok: true, message: `scrolled ${action.direction}` };
      }
      return { ok: false, message: `Can't scroll ${action.direction} any more.` };
    }

    default:
      return { ok: false, message: `Unsupported page action: ${action.type}` };
  }
}

// Page ka DOM badalna band ho jaaye (ya max 4s) tab tak ruko.
// Angular/React sites URL badle bina naya content laati hain, isliye sirf "page load" kaafi nahi.
export function waitForQuiet(): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, 500);
    const max = setTimeout(done, 4000);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, 500);
    });
    // attributes nahi: animation/carousel class badalte rehte hain, page "shant" hi nahi hota
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(max);
      resolve();
    }
  });
}

// Batch ke agle action se pehle: kya [id] wala element abhi bhi page pe hai?
export function hasElement(id: number): boolean {
  const sel = `[data-qp-id="${id}"]`;
  const search = (root: ParentNode): HTMLElement | null => {
    const hit = root.querySelector<HTMLElement>(sel);
    if (hit) return hit;
    for (const e of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const inShadow = e.shadowRoot && search(e.shadowRoot);
      if (inShadow) return inShadow;
    }
    return null;
  };
  return !!search(document)?.isConnected;
}

// Aakhri click wala element ab kya dikha raha hai (ADD → "1" matlab cart mein aa gaya). Hata diya gaya ho to null
export function clickedState(): string | null {
  const el = (window as unknown as { __qpLastClicked?: HTMLElement }).__qpLastClicked;
  if (!el?.isConnected) return null;
  return (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
