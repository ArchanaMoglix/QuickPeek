// ⚠️ Ye functions website ke andar chalte hain (scripting.executeScript).
// Inke andar bahar ka kuch bhi use mat karna: imports, helpers, constants sab andar hi hone chahiye.

import type { ActionResult, AgentAction, Observation } from './types';

// Screen pe dikh rahe clickable/typeable elements dhoondho, unhe number do,
// aur (drawMarks ho to) screenshot ke liye unpe number ke label bana do.
// Screen ke bahar wale elements bhi (bina scroll kiye, seedha DOM se):
//   hint: jinke shabd plan ke abhi wale step se milte hain
//   find: jinke text mein ye shabd hain (model ka "find" action)
export function observePage(drawMarks: boolean, opts: { hint?: string; find?: string } = {}): Observation {
  document.getElementById('__quickpeek_marks')?.remove();
  document.querySelectorAll('[data-qp-id]').forEach((e) => {
    e.removeAttribute('data-qp-id');
    e.removeAttribute('data-qp-native');
  });

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
  const offScreen: { el: HTMLElement; native: boolean; r: DOMRect }[] = [];

  // Ek element ko number do aur model ke liye uski line banao
  const add = (el: HTMLElement, native: boolean, r: DOMRect, note: string) => {
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const role = el.getAttribute('role') ?? '';
    const type = tag === 'input' ? (input.type || 'text') : '';
    const placeholder = clean(el.getAttribute('placeholder'));
    const aria = clean(el.getAttribute('aria-label'));
    const text = clean(el.innerText);
    const classHint = `${typeof el.className === 'string' ? el.className : ''} ${el.id}`;
    const label = clip(
      aria || text || clean(el.getAttribute('title')) || placeholder ||
        clean(el.getAttribute('alt')) || clean(el.querySelector('img')?.alt) ||
        clean(el.querySelector('[aria-label]')?.getAttribute('aria-label')) ||
        clean(el.querySelector('title')?.textContent) || clean(input.name) ||
        (CLOSE_HINT.test(classHint) ? '× close' : ''),
      60,
    );
    const idName = `${input.name ?? ''} ${el.id} ${el.getAttribute('autocomplete') ?? ''}`;
    const secret = type === 'password' || /cc-|one-time-code|password/.test(el.getAttribute('autocomplete') ?? '') ||
      (['input', 'textarea'].includes(tag) && SECRET.test(idName));
    const searchish = type === 'search' || role === 'searchbox' || role === 'combobox' ||
      SEARCH.test(`${input.name ?? ''} ${el.id} ${placeholder} ${aria}`);
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

    if (note) line += ` (${note})`;

    elements.push({ id, line, label: label || tag, secret, risky, searchish });
    if (!note) boxes.push({ id, r }); // screenshot pe number sirf screen wale elements pe
  };

  // Document order mein saare elements: asli buttons/links/inputs, aur woh div/span
  // jinpe cursor "pointer" ho (Angular/React sites aise clickable div bahut banati hain)
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
    if (el.id === '__quickpeek_overlay' || el.closest('#__quickpeek_overlay')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const onScreen = !(r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw);
    if (onScreen ? elements.length >= 150 : !lookOffScreen) continue;

    const native = el.matches(SELECTOR);
    const style = getComputedStyle(el);
    if (!native) {
      if (style.cursor !== 'pointer') continue;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === 'pointer') continue; // clickable box ka andar wala hissa
      if (el.closest('[data-qp-id]')) continue; // pehle se gine element ke andar
    } else if (el.parentElement?.closest(onScreen ? '[data-qp-native]' : SELECTOR)) {
      continue; // jaise <button> ke andar <span role=button>
    }
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

    if (!onScreen) {
      offScreen.push({ el, native, r }); // baad mein: sirf kaam wale chunenge
      continue;
    }

    // Kisi popup/overlay ke neeche chhupa hai to skip
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    const top = document.elementFromPoint(cx, cy);
    // Quick Peek ka apna overlay card "dhakna" nahi ginte (screenshot mein wo chhup jaata hai)
    if (top && !el.contains(top) && !top.contains(el) && !top.closest('#__quickpeek_overlay')) continue;

    add(el, native, r, '');
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
      const lw = words(label);
      const hits = new Set(lw.filter((w) => hintWords.has(w))).size;
      // Lambe label (jaise product ke naam) apne aap zyada shabd match karte hain: thoda kam number
      if (hits) related.push({ ...c, score: hits / Math.sqrt(lw.length) });
    }
    for (const c of found.slice(0, 15)) add(c.el, c.native, c.r, `found, ${where(c.r)}`);
    related.sort((a, b) => b.score - a.score);
    for (const c of related.slice(0, 20)) {
      if (!c.el.hasAttribute('data-qp-id')) add(c.el, c.native, c.r, where(c.r));
    }
  }

  // Screen pe dikh rahe text ka chhota hissa, taaki model jawab padh sake
  let visibleText = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && visibleText.length < 2500) {
    const node = walker.currentNode;
    const t = clean(node.textContent);
    const parent = node.parentElement;
    if (!t || !parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
    const r = parent.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
    visibleText += t + '\n'; // alag lines: pichhli screen se farak nikalne ke liye
  }

  if (drawMarks) {
    const layer = document.createElement('div');
    layer.id = '__quickpeek_marks';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    for (const { id, r } of boxes) {
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid #e11d48;`;
      const tag = document.createElement('span');
      tag.textContent = String(id);
      tag.style.cssText = 'position:absolute;left:-2px;top:-2px;background:#e11d48;color:#fff;font:bold 11px/14px sans-serif;padding:0 3px;border-radius:2px;';
      box.appendChild(tag);
      layer.appendChild(box);
    }
    document.documentElement.appendChild(layer);
  }

  const maxScroll = document.documentElement.scrollHeight - vh;
  const scroll = maxScroll <= 0
    ? 'whole page visible'
    : scrollY <= 0 ? 'top of page (more below)'
    : scrollY >= maxScroll - 2 ? 'bottom of page'
    : `${Math.round((scrollY / maxScroll) * 100)}% down (more below)`;

  return { url: location.href, title: document.title, scroll, visibleText: visibleText.trim(), elements };
}

export function clearMarks() {
  document.getElementById('__quickpeek_marks')?.remove();
}

// Ek action page pe karo
export function actOnPage(action: AgentAction): ActionResult {
  const find = (id: number) => document.querySelector<HTMLElement>(`[data-qp-id="${id}"]`);

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

    case 'type': {
      const el = find(action.id);
      if (!el) return { ok: false, message: `Element [${action.id}] not found. The page may have changed.` };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        // React jaise frameworks ke liye native setter use karo, warna wo value ignore kar dete hain
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, action.text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        document.getSelection()?.selectAllChildren(el);
        document.execCommand('insertText', false, action.text);
      } else {
        return { ok: false, message: `Element [${action.id}] is not a text field.` };
      }
      if (action.submit) pressEnter(el);
      return { ok: true, message: action.submit ? 'typed and pressed Enter' : 'typed' };
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

// Page ka DOM badalna band ho jaaye (ya max 6s) tab tak ruko.
// Angular/React sites URL badle bina naya content laati hain, isliye sirf "page load" kaafi nahi.
export function waitForQuiet(): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, 700);
    const max = setTimeout(done, 6000);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, 700);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    function done() {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(max);
      resolve();
    }
  });
}
