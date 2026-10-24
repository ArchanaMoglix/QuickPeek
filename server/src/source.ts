// Jawab page ke kis hisse se aaya: extension wahan scroll karke use peela highlight karta hai.

export type Source = { text: string } | { imageSrc: string };

// Model se kehte hain jawab ke end mein ek line de: SOURCE: <page se copy kiya tukda>
export const SOURCE_RULE = `- After your answer, add one last line: SOURCE: <a short phrase (5-20 words) copied exactly, word for word, from the page where the answer is>. If there is no such phrase, write SOURCE: none`;

// Jawab mein se SOURCE wali line nikaal do (user ko nahi dikhni chahiye)
export function splitSource(raw: string): { answer: string; quote?: string } {
  const m = raw.match(/\n?[ \t*_]*SOURCE[*_]*\s*:\s*(.*)\s*$/i);
  if (!m) return { answer: raw.trim() };
  const quote = m[1]!.trim().replace(/^["'“”‘’`*_]+|["'“”‘’`*_.]+$/g, '').trim();
  return {
    answer: raw.slice(0, m.index).trim(),
    quote: quote && !/^none$/i.test(quote) ? quote : undefined,
  };
}

// Spaces aur quotes ka farak hata do: page ka text (innerText) aur model ka copy
// thoda alag ho sakta hai
const squash = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, '');

const STOP = new Set(
  'the and for with this that what which who are was were is its from about into there their they you your can has have had will been not but also than then them its of to in on at by an a or as be it'.split(' '),
);
const words = (t: string) =>
  t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2 && !STOP.has(w));

// Model ka SOURCE na mile to: page ki wo line/sentence jisme jawab ke sabse zyada shabd hain
function bestMatchingSentence(pageText: string, answer: string): string | undefined {
  const answerWords = new Set(words(answer));
  if (answerWords.size < 2) return undefined;

  let best: string | undefined;
  let bestScore = 0;
  for (const line of pageText.split(/\n+/)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s.length < 12 || s.length > 400) continue;
      const own = new Set(words(s));
      let hits = 0;
      for (const w of own) if (answerWords.has(w)) hits++;
      // Lambi sentence apne aap zyada shabd match karti hai: thoda kam number do
      const score = hits / Math.sqrt(own.size);
      if (hits >= 3 && score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
  }
  return best;
}

export function findSource(
  pageText: string,
  answer: string,
  quote: string | undefined,
  images: { src?: string }[] = [],
): Source | undefined {
  // Vision model ne kaha "SOURCE: image 2" = screen ke bahar wali doosri image
  const img = quote?.match(/^(?:extra\s+)?image\s*#?(\d+)\b/i);
  if (img) {
    const src = images[Number(img[1]) - 1]?.src;
    if (src) return { imageSrc: src };
  }
  if (quote && quote.length >= 8 && squash(pageText).includes(squash(quote))) return { text: quote };
  const sentence = bestMatchingSentence(pageText, answer);
  return sentence ? { text: sentence } : undefined;
}
