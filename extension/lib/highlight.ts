// Jawab page ke jis hisse se aaya, wahan scroll karke use peela highlight karo.
// Text ke liye CSS Highlight API: page ka HTML nahi badalta, isliye site ka kuch nahi tootta.

import { RESTRICTED } from './extract';

export type AnswerSource = { text: string } | { imageSrc: string };

// ⚠️ Ye dono functions website ke andar chalte hain. Bahar ka kuch bhi use mat karna.

function clearPageHighlight() {
  (CSS as any).highlights?.delete('quickpeek');
  document.querySelectorAll('.__quickpeek_hl_img').forEach((el) => el.classList.remove('__quickpeek_hl_img'));
}

function highlightOnPage(source: { text?: string; imageSrc?: string }): boolean {
  (CSS as any).highlights?.delete('quickpeek');
  document.querySelectorAll('.__quickpeek_hl_img').forEach((el) => el.classList.remove('__quickpeek_hl_img'));

  if (!document.getElementById('__quickpeek_hl_style')) {
    const style = document.createElement('style');
    style.id = '__quickpeek_hl_style';
    style.textContent =
      '::highlight(quickpeek){background-color:#ffeb3b;color:#000}' +
      '.__quickpeek_hl_img{outline:4px solid #ffeb3b !important;outline-offset:2px;box-shadow:0 0 0 10px rgba(255,235,59,.45) !important}';
    (document.head || document.documentElement).appendChild(style);
  }

  const scrollTo = (el: Element | null) => el?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // ----- Image -----
  if (source.imageSrc) {
    const img = Array.from(document.images).find(
      (i) => i.currentSrc === source.imageSrc || i.src === source.imageSrc ||
        Object.values(i.dataset).some((v) => v && source.imageSrc!.endsWith(v)),
    );
    if (!img) return false;
    img.classList.add('__quickpeek_hl_img');
    scrollTo(img);
    return true;
  }

  // ----- Text -----
  if (!source.text || !(CSS as any).highlights || typeof (window as any).Highlight !== 'function') return false;

  // Page ke saare text nodes jod ke ek lamba string, bina spaces ke (innerText aur DOM ke
  // spaces alag hote hain), aur har character kis node ke kis jagah se aaya
  const norm = (c: string) => {
    const l = c.toLowerCase();
    return l.length === 1 ? l.replace(/[‘’]/, "'").replace(/[“”]/, '"') : c;
  };
  let flat = '';
  const map: [Text, number][] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('script, style, noscript, template, #__quickpeek_marks')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const d = n.data;
    for (let i = 0; i < d.length; i++) {
      if (/\s/.test(d[i]!)) continue;
      flat += norm(d[i]!);
      map.push([n, i]);
    }
  }

  // Pehli jagah jo sach mein dikhti ho (chhupe menu ka text nahi)
  const findRange = (needle: string): Range | null => {
    if (needle.length < 6) return null;
    for (let at = flat.indexOf(needle); at !== -1; at = flat.indexOf(needle, at + 1)) {
      const [sn, so] = map[at]!;
      const [en, eo] = map[at + needle.length - 1]!;
      const range = document.createRange();
      range.setStart(sn, so);
      range.setEnd(en, eo + 1);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return range;
    }
    return null;
  };

  const words = source.text.split(/\s+/).filter(Boolean);
  const squash = (ws: string[]) => ws.join('').split('').map(norm).join('');
  let range = findRange(squash(words));
  // Poora tukda na mile (model ne thoda badal diya) to shuru ke kam shabd try karo
  for (let n = words.length - 1; !range && n >= 4; n--) range = findRange(squash(words.slice(0, n)));
  if (!range) return false;

  (CSS as any).highlights.set('quickpeek', new (window as any).Highlight(range));
  scrollTo(range.startContainer.parentElement);
  return true;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id && tab.url && !RESTRICTED.test(tab.url) ? tab.id : null;
}

export async function showSource(source: AnswerSource): Promise<boolean> {
  const tabId = await activeTabId();
  if (!tabId) return false;
  try {
    const [res] = await browser.scripting.executeScript({ target: { tabId }, func: highlightOnPage, args: [source] });
    return !!res?.result;
  } catch (err) {
    console.warn('[QuickPeek] highlight failed:', err);
    return false;
  }
}

export async function clearSource(): Promise<void> {
  const tabId = await activeTabId();
  if (!tabId) return;
  await browser.scripting.executeScript({ target: { tabId }, func: clearPageHighlight }).catch(() => {});
}
