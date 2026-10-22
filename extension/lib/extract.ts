export interface PageContent {
  title: string;
  url: string;
  text: string;
  selection: string; // user ne jo text select kiya ho
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


  return {
    title: document.title,
    url: location.href,
    text: clean(root),
    selection: window.getSelection()?.toString().trim() ?? '',
  };
}

// Browser ke internal pages pe extensions script inject nahi kar sakte
const RESTRICTED =
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