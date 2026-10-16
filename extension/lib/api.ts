// export type Role = 'user' | 'assistant';

// export interface Message {
//   id: string;
//   role: Role;
//   content: string;
// }

// // Abhi fake. Step 5 mein yahan backend call aayega.
// export async function askAssistant(question: string): Promise<string> {
//   await new Promise((r) => setTimeout(r, 800)); // network delay jaisa feel
//   return `You asked: "${question}". (Currently this is a fake reply.)`;
// }




import type { PageContent } from './extract';

// Abhi fake: dikhata hai ki page se kya mila.
export async function askAssistant(question: string, page: PageContent): Promise<string> {
  await new Promise((r) => setTimeout(r, 500));
  return [
    `Question: ${question}`,
    `Page: ${page.title}`,
    `URL: ${page.url}`,
    `Text length: ${page.text.length.toLocaleString()} characters`,
    page.selection ? `Selected text: "${page.selection.slice(0, 200)}"` : '',
    '',
    `initial 300 characters:\n${page.text.slice(0, 300)}…`,
  ].filter(Boolean).join('\n');
}