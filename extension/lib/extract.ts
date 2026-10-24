export interface PageContent {
  title: string;
  url: string;
  text: string;
  selection: string; // user ne jo text select kiya ho
  imageCoverage: number; // screen ka kitna hissa (0–1) images se dhaka hai: model routing ke liye
  images: PageImage[]; // poore page ki badi images (screen ke bahar wali bhi)
}

export interface PageImage {
  src: string;
  alt: string;
  caption: string; // figcaption / title
  context: string; // aas-paas ka text (product card, heading...)
  position: 'above' | 'on screen' | 'below'; // screen ke hisaab se kahan hai
}

// ⚠️ Ye function website ke andar chalta hai. Bahar ka kuch bhi use mat karna.
function extractPage(): PageContent {
  const clean = (s: string) =>
    s.replace(/[ \t]+\n/g, '\n')   // line ke end ke extra spaces
     .replace(/\n{3,}/g, '\n\n')   // bahut saari khaali lines
     .trim();

  const main = document.querySelector<HTMLElement>('main, [role="main"], article');
  const mainText = main?.innerText ?? '';
  const root = mainText.length > 500 ? mainText : document.body?.innerText ?? '';

  // Screen ka kitna hissa images se dhaka hai. Sirf dikh rahi aur badi (80x80+) images:
  // icons, logos, tracking pixels aur scroll ke neeche wali images nahi ginte.
  const vw = innerWidth;
  const vh = innerHeight;
  let imageArea = 0;
  const visuals = document.querySelectorAll<HTMLElement>('img, video, canvas, svg, [style*="background-image"]');
  for (const el of Array.from(visuals)) {
    if (el.parentElement?.closest('svg')) continue; // badi SVG ke andar ka hissa: dobara mat gino
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) continue;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) continue; // screen ke bahar
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
    imageArea += w * h;
  }
  const imageCoverage = Math.min(1, imageArea / (vw * vh)); // overlap ho to 1 se upar na jaaye

  // Poore page ki badi <img> images: inka URL + aas-paas ka text. Screen ke bahar wali image
  // ke baare mein sawaal ho to side panel inme se sahi image dhoondh ke vision model ko bhejta hai.
  const short = (t: string | null | undefined, n: number) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const images: PageImage[] = [];
  const seen = new Set<string>();
  for (const img of Array.from(document.images)) {
    if (images.length >= 40) break;
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) continue;
    const style = getComputedStyle(img);
    if (style.visibility === 'hidden' || style.display === 'none') continue;

    // Lazy-load wali images ka asli URL aksar data-src mein hota hai
    let src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) {
      src = img.dataset.src || img.dataset.lazySrc || img.dataset.original ||
        (img.getAttribute('srcset') ?? img.dataset.srcset ?? '').split(',')[0]?.trim().split(' ')[0] || '';
    }
    if (!src || src.startsWith('data:')) continue;
    try { src = new URL(src, location.href).href; } catch { continue; }
    if (!/^https?:/.test(src) || seen.has(src)) continue;
    seen.add(src);

    // Aas-paas ka text: upar ke parents mein jahan pehli baar kuch text mile
    let context = '';
    let p: HTMLElement | null = img.parentElement;
    for (let i = 0; p && i < 4 && context.length < 20; i++, p = p.parentElement) context = short(p.innerText, 200);

    images.push({
      src,
      alt: short(img.alt, 150),
      caption: short(img.closest('figure')?.querySelector('figcaption')?.textContent || img.title, 200),
      context,
      position: r.bottom <= 0 ? 'above' : r.top >= vh ? 'below' : 'on screen',
    });
  }


  return {
    title: document.title,
    url: location.href,
    text: clean(root),
    selection: window.getSelection()?.toString().trim() ?? '',
    imageCoverage: Math.round(imageCoverage * 100) / 100,
    images,
  };
}

// Browser ke internal pages pe extensions script inject nahi kar sakte
export const RESTRICTED =
  /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/chromewebstore\.google\.com/;

export async function getPageContent(): Promise<PageContent> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

if (!tab?.id || !tab.url) throw new Error('No active tab found.');
if (RESTRICTED.test(tab.url)) {
  throw new Error('This is a browser internal page; the extension cannot read it.');
}

  const [res] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPage,
  });

 if (!res?.result) throw new Error('Could not read the page content.');
  return res.result as PageContent;
}