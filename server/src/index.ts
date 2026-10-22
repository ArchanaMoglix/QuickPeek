import Fastify from 'fastify';
import { askLLM } from './llm.js';

interface AskBody {
  question: string;
  page: {
    title: string;
    url: string;
    text: string;
    selection?: string;
  };
}

const PORT = 3001;

const app = Fastify({
  logger: true,
  bodyLimit: 5 * 1024 * 1024, // 5 MB, large pages exceed the 1 MB default
});

// Request body validation: Fastify returns 400 automatically if this fails
const askSchema = {
  body: {
    type: 'object',
    required: ['question', 'page'],
    properties: {
      question: { type: 'string', minLength: 1 },
      page: {
        type: 'object',
        required: ['url', 'text'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          text: { type: 'string' },
          selection: { type: 'string' },
        },
      },
    },
  },
};

// All API routes live under /api so the same server can serve a web app later
app.register(
  async (api) => {
    api.get('/health', async () => ({ ok: true }));

    api.post<{ Body: AskBody }>('/ask', { schema: askSchema }, async (req, reply) => {
  const { question, page } = req.body;
  req.log.info({ url: page.url, chars: page.text.length }, 'ask received');

  try {
    const started = Date.now();
    const answer = await askLLM(question, page);
    req.log.info({ ms: Date.now() - started }, 'llm answered');
    return { answer };
  } catch (err) {
    req.log.error(err, 'llm call failed');
    return reply.code(502).send({ error: 'The AI model is not reachable right now.' });
  }
});

    // api.post<{ Body: AskBody }>('/ask', { schema: askSchema }, async (req) => {
    //   const { question, page } = req.body;

    //   // Log metadata only, never page content (privacy)
    //   req.log.info({ url: page.url, chars: page.text.length }, 'ask received');

    //   return {
    //     answer: [
    //       'Server received the request ✅',
    //       `Question: ${question}`,
    //       `Page: ${page.title}`,
    //       `Text: ${page.text.length.toLocaleString()} characters`,
    //     ].join('\n'),
    //   };
    // });
  },
  { prefix: '/api' },
);

app.listen({ port: PORT, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});