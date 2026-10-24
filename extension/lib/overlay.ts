// Quick Peek ka widget website ke upar overlay card ki tarah (side panel ki jagah).
// Card ek iframe hai jisme extension ka hi page (sidepanel.html) khulta hai, isliye
// website ka layout nahi badalta aur website ka CSS/JS widget ko chhoo nahi sakta.

export const OVERLAY_ID = '__quickpeek_overlay';

// ⚠️ Ye functions website ke andar chalte hain. Bahar ka kuch bhi use mat karna.

function mountOverlay(url: string, animate: boolean) {
  const ID = '__quickpeek_overlay';
  if (document.getElementById(ID)) return;

  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = [
    'all:initial',
    'position:fixed',
    'top:12px',
    'right:12px',
    'width:min(400px, calc(100vw - 24px))',
    'height:min(640px, calc(100vh - 24px))',
    'z-index:2147483647',
    'border-radius:16px',
    'overflow:hidden',
    'background:#0b0d14',
    'box-shadow:0 18px 50px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08)',
    'transition:transform .32s cubic-bezier(.2,.9,.3,1.05), opacity .2s ease',
    // Upar se neeche aata hai
    animate ? 'transform:translateY(calc(-100% - 24px))' : 'transform:none',
    animate ? 'opacity:0' : 'opacity:1',
  ].join(';');

  const frame = document.createElement('iframe');
  frame.src = url;
  frame.title = 'Quick Peek';
  frame.allow = 'microphone; autoplay; clipboard-write';
  frame.style.cssText = 'all:initial;display:block;width:100%;height:100%;border:0;';
  host.appendChild(frame);
  document.documentElement.appendChild(host);

  if (animate) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        host.style.transform = 'translateY(0)';
        host.style.opacity = '1';
      }),
    );
  }
}

function unmountOverlay() {
  const host = document.getElementById('__quickpeek_overlay');
  if (!host) return;
  host.style.transform = 'translateY(calc(-100% - 24px))';
  host.style.opacity = '0';
  setTimeout(() => host.remove(), 320);
}

// Screenshot lete waqt card chhupao, taaki model ko poora page dikhe
function setOverlayHidden(hidden: boolean) {
  const host = document.getElementById('__quickpeek_overlay');
  if (host) host.style.visibility = hidden ? 'hidden' : 'visible';
}

// ---------- Extension ki taraf se ----------

export async function showOverlay(tabId: number, animate: boolean): Promise<boolean> {
  const url = browser.runtime.getURL(`/sidepanel.html?tabId=${tabId}` as '/sidepanel.html');
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: mountOverlay, args: [url, animate] });
    return true;
  } catch {
    return false; // jaise chrome:// pages, ya page abhi load ho raha hai
  }
}

export async function hideOverlay(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, func: unmountOverlay }).catch(() => {});
}

export async function setOverlayVisible(tabId: number, visible: boolean): Promise<void> {
  await browser.scripting
    .executeScript({ target: { tabId }, func: setOverlayHidden, args: [!visible] })
    .catch(() => {});
}
