// Screen ke bahar (scroll ke upar/neeche) wali images: sawaal kis image ke baare mein hai,
// ye dhoondh ke uski file vision model ko bhejte hain, taaki user ko scroll na karna pade.

import type { PageImage } from './extract';

export interface ExtraImage {
  image: string; // data:image/jpeg;base64,...
  label: string; // model ko batane ke liye: alt / caption / aas-paas ka text
  src: string; // page pe image ka URL: jawab isse aaye to wahan scroll karte hain
}

const MAX_IMAGES = 2; // vision model ka context ~8k tokens: screenshot + 2 chhoti images
const MAX_SIDE = 512;
const FETCH_TIMEOUT_MS = 4000;

// Sawaal ke ye shabd kisi image ko pehchaanne mein madad nahi karte
const STOP = new Set(
  ('the and for with this that what which who whom whose how why when where are was were is its from about into ' +
   'there their them they you your can could would should does did have has had will show tell give explain describe look looks like ' +
   'image images picture pictures photo photos pic pics screen page bottom below last end down top above first ' +
   'kya hai hain kaun kaunsa kaunsi kaisa kaisi kaise kahan kab mein mai par pe isme iska iski iske uska uski uske ' +
   'wala wali wale yeh woh aur bhi nahi tasveer dikh dikhta dikhti dikhao batao bata niche neeche upar aakhri akhri').split(' '),
);

const words = (t: string) =>
  t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));

const BOTTOM = /\b(bottom|below|last|end|niche|neeche|nichay|aakhri|akhri)\b/i;
const TOP = /\b(top|above|upar|pehli|pehle wali)\b/i;

// Screen pe dikh rahi images to screenshot mein hain hi; baaki mein se sawaal se milti-julti chuno
export function pickImages(question: string, images: PageImage[]): PageImage[] {
  const offScreen = images.filter((img) => img.position !== 'on screen');
  if (!offScreen.length) return [];

  const q = new Set(words(question));
  const docs = offScreen.map((img) => {
    // Image ke URL ka file naam bhi kaam aata hai: ".../mona-lisa-detail.jpg"
    const file = img.src.split(/[?#]/)[0]?.split('/').pop() ?? '';
    return { own: new Set(words(`${img.alt} ${img.caption} ${file}`)), near: new Set(words(img.context)) };
  });
  // Jo shabd lagbhag har image ke paas hai (jaise page ka topic "mona lisa") wo kam batata hai;
  // jo sirf ek-do ke paas hai (jaise "prado") wo zyada
  const weight = (w: string) => {
    const df = docs.filter((d) => d.own.has(w) || d.near.has(w)).length;
    return df ? Math.log(1 + offScreen.length / df) : 0;
  };
  const scored = offScreen
    .map((img, i) => {
      let score = 0;
      for (const w of q) {
        if (docs[i]!.own.has(w)) score += 2 * weight(w); // image ka apna alt/caption zyada pakka hai
        else if (docs[i]!.near.has(w)) score += weight(w);
      }
      return { img, i, score };
    })
    .filter((s) => s.score > 0);

  if (scored.length) {
    return scored
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, MAX_IMAGES)
      .map((s) => s.img);
  }

  // Koi shabd match nahi hua, par user ne jagah batayi: "neeche wali image", "last photo"
  if (BOTTOM.test(question)) return offScreen.filter((i) => i.position === 'below').slice(-MAX_IMAGES);
  if (TOP.test(question)) return offScreen.filter((i) => i.position === 'above').slice(0, MAX_IMAGES);
  return [];
}

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Image download karke chhoti JPEG banao (side panel ke paas <all_urls> permission hai)
async function loadImage(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;

    const bitmap = await createImageBitmap(blob); // SVG yahan fail hota hai: chhod do
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // transparent PNG ka background kaala na ho
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await toDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
  } catch (err) {
    console.warn('[QuickPeek] could not load image', src, err);
    return null;
  }
}

function labelFor(img: PageImage): string {
  const parts = [img.alt, img.caption, img.context].filter(Boolean);
  const where = img.position === 'below' ? 'further down the page' : 'further up the page';
  return `Image ${where}${parts.length ? `: ${[...new Set(parts)].join(' | ').slice(0, 300)}` : ''}`;
}

export async function getExtraImages(question: string, images: PageImage[]): Promise<ExtraImage[]> {
  const picked = pickImages(question, images);
  const loaded = await Promise.all(picked.map((img) => loadImage(img.src)));
  return picked
    .map((img, i) => (loaded[i] ? { image: loaded[i]!, label: labelFor(img), src: img.src } : null))
    .filter((x): x is ExtraImage => x !== null);
}
