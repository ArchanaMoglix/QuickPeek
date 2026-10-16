import { useEffect, useRef, useState } from 'react';
import { askAssistant, type Message } from '@/lib/api';
import { getPageContent, type PageContent } from '@/lib/extract';
import './App.css';

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastPage, setLastPage] = useState<PageContent | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Naya message aane pe neeche scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send() {
    const question = input.trim();
    if (!question || loading) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: question }]);
    setInput('');
    setLoading(true);

    try {
      try {
        const page = await getPageContent(); // har sawaal pe fresh page padho
        setLastPage(page);
        const answer = await askAssistant(question, page);
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: answer }]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Something went wrong.';
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: msg }]);
      } finally {
        setLoading(false);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: 'Something went wrong. Try again.' },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="header">Quick Peek</header>
      {lastPage && (
        <details className="page-preview">
          <summary>📄 {lastPage.title || lastPage.url} · {lastPage.text.length.toLocaleString()} chars</summary>
          <pre>{lastPage.text.slice(0, 3000)}</pre>
        </details>
      )}

      <main className="messages">
        {messages.length === 0 && (
          <p className="empty">Ask anything about this page.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.content}
          </div>
        ))}
        {loading && <div className="bubble assistant">Thinking…</div>}
        <div ref={bottomRef} />
      </main>

      <footer className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Enter your query here."
          rows={2}
        />
        <button onClick={send} disabled={loading || !input.trim()}>
          Send
        </button>
      </footer>
    </div>
  );
}

export default App;