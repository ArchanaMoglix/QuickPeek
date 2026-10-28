import Fastify from 'fastify';
import { askTextModel, askVisionModel, chooseModel, visionEnabled, type ExtraImage } from './llm.js';
import { makePlan, nextAgentStep, replan, type AgentStepInput, type PlanInput, type ReplanInput } from './agent.js';

interface AskBody {
  question: string;
  page: {
    title: string;
    url: string;
    text: string;
    selection?: string;
    imageCoverage?: number;
    images?: { src: string; alt: string; caption: string; context: string; position: string }[];
  };
  screenshot?: string; // data:image/... URL of the visible part of the tab
  extraImages?: ExtraImage[]; // screen ke bahar wali images jo sawaal se match hui
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
          html: { type: 'string', maxLength: 40000 },
          imageCoverage: { type: 'number', minimum: 0, maximum: 1 },
          images: {
            type: 'array',
            maxItems: 60,
            items: {
              type: 'object',
              properties: {
                src: { type: 'string', maxLength: 4000 },
                alt: { type: 'string', maxLength: 500 },
                caption: { type: 'string', maxLength: 500 },
                context: { type: 'string', maxLength: 500 },
                position: { type: 'string', enum: ['above', 'on screen', 'below'] },
              },
            },
          },
        },
      },
      screenshot: { type: 'string', pattern: '^data:image/(jpeg|png|webp);base64,', maxLength: 4000000 },
      extraImages: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          required: ['image', 'label'],
          properties: {
            image: { type: 'string', pattern: '^data:image/(jpeg|png|webp);base64,', maxLength: 1000000 },
            label: { type: 'string', maxLength: 500 },
            src: { type: 'string', maxLength: 4000 },
          },
        },
      },
    },
  },
};

const agentStepSchema = {
  body: {
    type: 'object',
    required: ['goal', 'history', 'observation'],
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: 4000 },
      history: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['summary', 'result'],
          properties: {
            thought: { type: 'string' },
            summary: { type: 'string' },
            result: { type: 'string' },
            planStep: { type: 'integer', minimum: 1, maximum: 20 },
          },
        },
      },
      plan: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 300 } },
      changes: { type: 'string', maxLength: 2000 },
      note: { type: 'string', maxLength: 1000 },
      observation: {
        type: 'object',
        required: ['url', 'title', 'scroll', 'visibleText', 'elements'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          scroll: { type: 'string' },
          visibleText: { type: 'string' },
          elements: {
            type: 'array',
            maxItems: 300,
            items: { type: 'object', required: ['line'], properties: { line: { type: 'string' } } },
          },
        },
      },
      screenshot: { type: 'string', pattern: '^data:image/(jpeg|png|webp);base64,', maxLength: 4000000 },
    },
  },
};

const agentReplanSchema = {
  body: {
    type: 'object',
    required: ['goal', 'plan', 'planStep', 'reason', 'history', 'url', 'title'],
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: 4000 },
      plan: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 300 } },
      planStep: { type: 'integer', minimum: 1, maximum: 20 },
      reason: { type: 'string', maxLength: 500 },
      history: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          required: ['summary', 'result'],
          properties: { summary: { type: 'string' }, result: { type: 'string' }, planStep: { type: 'integer' } },
        },
      },
      url: { type: 'string', maxLength: 4000 },
      title: { type: 'string', maxLength: 1000 },
      visibleText: { type: 'string', maxLength: 20000 },
      elements: { type: 'array', maxItems: 300, items: { type: 'string', maxLength: 1000 } },
    },
  },
};

const agentPlanSchema = {
  body: {
    type: 'object',
    required: ['goal', 'url', 'title'],
    properties: {
      goal: { type: 'string', minLength: 1, maxLength: 4000 },
      url: { type: 'string', maxLength: 4000 },
      title: { type: 'string', maxLength: 1000 },
      visibleText: { type: 'string', maxLength: 20000 },
    },
  },
};

// All API routes live under /api so the same server can serve a web app later
app.register(
  async (api) => {
    api.get('/health', async () => ({ ok: true }));

    api.post<{ Body: AskBody }>('/ask', { schema: askSchema }, async (req, reply) => {
      const { question, page, screenshot, extraImages = [] } = req.body;
      // Sirf metadata log karo, page ka content kabhi nahi (privacy)
      req.log.info(
        { url: page.url, chars: page.text.length, screenshot: !!screenshot, extraImages: extraImages.length },
        'ask received',
      );
      const hasImages = !!screenshot || extraImages.length > 0;

      const started = Date.now();
      const route = chooseModel(question, page, hasImages);
      req.log.info({ ...route, ms: Date.now() - started }, 'model chosen');

      const tryVision = async (why: string) => {
        try {
          const res = await askVisionModel(question, page, screenshot, extraImages);
          req.log.info({ model: 'vision', why, source: !!res.source, ms: Date.now() - started }, 'llm answered');
          return { ...res, model: 'vision' as const };
        } catch (err) {
          req.log.warn(err, 'vision model failed');
        }
        // Kai images thi? Vision server ek prompt mein kam images leta ho to sirf
        // sabse milti-julti screen ke bahar wali image ke saath dobara
        if (extraImages.length && (screenshot || extraImages.length > 1)) {
          try {
            const res = await askVisionModel(question, page, undefined, extraImages.slice(0, 1));
            req.log.info({ model: 'vision', why, images: 1, ms: Date.now() - started }, 'llm answered');
            return { ...res, model: 'vision' as const };
          } catch (err) {
            req.log.warn(err, 'vision model failed with one image too');
          }
        }
        return null;
      };

      if (route.model === 'vision' && hasImages) {
        const res = await tryVision(route.reason);
        if (res) return res; // fail hua to text model se jawab do
      }

      try {
        const text = await askTextModel(question, page);
        req.log.info({ model: 'text', found: text.found, source: !!text.source, ms: Date.now() - started }, 'llm answered');

        // Text mein jawab nahi mila: shayad sawaal screen pe dikh rahi cheez ke baare mein hai
        if (!text.found && route.model === 'text' && hasImages && visionEnabled) {
          const res = await tryVision('text model could not find the answer');
          if (res) return res;
        }
        return { answer: text.answer, source: text.source, model: 'text' };
      } catch (err) {
        req.log.error(err, 'text model failed');
        // Text model band ho to vision se jawab do (agar pehle try nahi hua)
        if (route.model === 'text' && hasImages && visionEnabled) {
          const res = await tryVision('text model failed');
          if (res) return res;
        }
        return reply.code(502).send({ error: 'The AI model is not reachable right now.' });
      }
    });

    // Agent ("Do" mode): pehle task ko chhote steps mein todo
    api.post<{ Body: PlanInput }>('/agent/plan', { schema: agentPlanSchema }, async (req) => {
      const started = Date.now();
      try {
        const steps = await makePlan(req.body);
        req.log.info({ steps: steps.length, ms: Date.now() - started }, 'agent plan');
        return { steps };
      } catch (err) {
        // Plan na bane to bhi kaam ruke nahi: poora goal hi ek step
        req.log.warn(err, 'agent plan failed, using the goal as one step');
        return { steps: [req.body.goal.slice(0, 300)] };
      }
    });

    // Agent ("Do" mode): beech mein progress check, plan sudhaaro
    api.post<{ Body: ReplanInput }>('/agent/replan', { schema: agentReplanSchema }, async (req, reply) => {
      const started = Date.now();
      try {
        const result = await replan(req.body);
        req.log.info({ reason: req.body.reason, steps: result.steps.length, current: result.current, note: result.note, ms: Date.now() - started }, 'agent replan');
        return result;
      } catch (err) {
        req.log.warn(err, 'agent replan failed');
        return reply.code(502).send({ error: 'replan failed' });
      }
    });

    // Agent ("Do" mode): agla action (ya 2–3 actions)
    api.post<{ Body: AgentStepInput }>('/agent/step', { schema: agentStepSchema }, async (req, reply) => {
      const { observation, history, screenshot } = req.body;
      req.log.info(
        { url: observation.url, elements: observation.elements.length, step: history.length + 1, screenshot: !!screenshot },
        'agent step',
      );
      try {
        const started = Date.now();
        const decision = await nextAgentStep(req.body, req.log);
        req.log.info({ actions: decision.actions.map((a) => a.type), step: decision.step, model: decision.model, ms: Date.now() - started }, 'agent decided');
        return decision;
      } catch (err) {
        req.log.error(err, 'agent step failed');
        // Wajah bhi bhejo (jaise "model unreachable: Connection error"), taaki chat mein dikhe
        const reason = err instanceof Error ? err.message.slice(0, 200) : '';
        return reply.code(502).send({ error: `The AI model couldn't decide the next step.${reason ? ` (${reason})` : ''}` });
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

app.log.info({ visionEnabled }, 'models configured');

app.listen({ port: PORT, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});