import { setOverlayVisible } from './overlay';
import type { Mark } from './agent/types';

// Tab ke dikh rahe hisse ka screenshot, vision model ke liye.
// Chhota rakhte hain: vision model ka context ~8k tokens hai aur
// 1280px chaudi tasveer ~1000–1500 tokens leti hai.
const MAX_WIDTH = 1280;

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Chhota karo, aur marks hon to har element pe laal box + number banao (agent ke vision model ke liye)
async function downscale(dataUrl: string, maxWidth: number, marks?: Mark[], viewportWidth?: number): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, maxWidth / bitmap.width);
  const draw = !!marks?.length && !!viewportWidth;
  if (scale === 1 && !draw) return dataUrl;

  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (draw) {
    const k = canvas.width / viewportWidth!; // page ke CSS px → tasveer ke px (zoom/retina sab isme)
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e11d48';
    ctx.font = 'bold 11px sans-serif';
    ctx.textBaseline = 'top';
    for (const m of marks!) {
      const x = m.x * k, y = m.y * k;
      ctx.strokeRect(x, y, m.w * k, m.h * k);
      const label = String(m.id);
      const tw = ctx.measureText(label).width + 6;
      ctx.fillStyle = '#e11d48';
      ctx.fillRect(x - 1, y - 1, tw, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 2, y + 1);
    }
  }
  return toDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
}

// Screenshot na mile (jaise browser ke internal pages) to null: tab text model hi jawab dega
// tabId diya ho to sirf tab screenshot lo jab wahi tab saamne khula ho
export async function captureScreenshot(
  { tabId, maxWidth = MAX_WIDTH, marks, viewportWidth }:
    { tabId?: number; maxWidth?: number; marks?: Mark[]; viewportWidth?: number } = {},
): Promise<string | null> {
  try {
    const tab = tabId !== undefined
      ? await browser.tabs.get(tabId)
      : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.active || tab.windowId === undefined || tab.id === undefined) return null;
    // Quick Peek ka overlay card screenshot mein na aaye: ek pal ke liye chhupao
    await setOverlayVisible(tab.id, false);
    let shot: string;
    try {
      await new Promise((r) => setTimeout(r, 60)); // browser card hata ke screen dobara bana le
      shot = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
    } finally {
      await setOverlayVisible(tab.id, true);
    }
    return await downscale(shot, maxWidth, marks, viewportWidth);
  } catch (err) {
    console.warn('[QuickPeek] screenshot failed:', err);
    return null;
  }
}
