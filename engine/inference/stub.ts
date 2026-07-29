/**
 * Deterministic inference stub.
 *
 * This is not a mock that returns constants. It is a real, if crude,
 * implementation whose outputs are reproducible from a seed, so that the whole
 * rule engine can be exercised — and its determinism asserted — without any
 * network call or model spend.
 *
 * Embeddings deserve particular attention: a random vector per text would be
 * deterministic but semantically meaningless, and every retrieval test written
 * against it would be vacuous. Instead this uses a signed hashing vectoriser
 * over tokens, so texts that share vocabulary genuinely land near each other
 * under cosine distance. Retrieval relevance is therefore testable offline.
 */

import { createRng, deriveSeed } from '../core/rng.ts';
import {
  InferenceError,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingResponse,
  type InferenceClient,
  type StreamUsage,
} from './types.ts';

export const STUB_MODEL_ID = 'stub-reasoning-v1';
export const STUB_EMBEDDING_ID = 'stub-embedding-v1';

/** 32-bit FNV-1a, matching engine/rng.ts so hashing is consistent engine-wide. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Function words carry no topical signal but appear in nearly every sentence.
 * In a short bag-of-words text they dominate the vector, so two unrelated
 * sentences sharing "the" and "at" score as similar — which would make
 * retrieval tests pass for the wrong reason. Real embedding models do not
 * behave this way, so the stub should not either.
 */
const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'nor', 'not', 'are', 'was', 'were', 'been', 'being',
  'has', 'had', 'have', 'his', 'her', 'hers', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'there', 'here', 'then', 'than', 'with',
  'from', 'into', 'onto', 'upon', 'about', 'over', 'under', 'again', 'once',
  'who', 'whom', 'whose', 'what', 'which', 'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'very', 'can', 'will', 'just', 'should', 'would',
  'could', 'you', 'your', 'yours', 'our', 'ours', 'him', 'she', 'himself',
  'herself', 'itself', 'did', 'does', 'doing', 'done',
]);

/** Dimensions each token is hashed into. See stubEmbed for why this is not 1. */
const HASHES_PER_TOKEN = 3;

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((token) => token.length > 1);

  const content = words.filter((token) => !STOPWORDS.has(token));
  // A phrase made entirely of function words still needs a vector; falling back
  // to the raw tokens is better than returning nothing.
  return content.length > 0 ? content : words;
}

/**
 * Signed hashing vectoriser with L2 normalisation.
 *
 * Cross-platform determinism holds here even though the output is float: the
 * accumulation order is fixed, and IEEE-754 requires addition, multiplication,
 * and sqrt to be correctly rounded. (This is precisely why the decay tables
 * avoid Math.exp, which carries no such guarantee.)
 */
export function stubEmbed(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    // Each token is spread across several dimensions. With a single hash, one
    // accidental collision between a short memory and the query is enough to
    // rank an unrelated memory as highly similar — measured, not theoretical.
    // Spreading the weight means a lone collision contributes only 1/HASHES of
    // the token, so false similarity drops sharply while true overlap is
    // unaffected.
    for (let k = 0; k < HASHES_PER_TOKEN; k++) {
      const hash = hashToken(k === 0 ? token : `${token}#${k}`);
      const index = hash % dimensions;
      // The top bit picks a sign, which keeps unrelated collisions from always
      // reinforcing one another.
      const sign = (hash & 0x8000_0000) !== 0 ? -1 : 1;
      vector[index] = (vector[index] as number) + sign;
    }
  }

  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;

  if (sumSquares === 0) {
    // An empty or punctuation-only string still needs a unit vector, or cosine
    // distance against it is undefined.
    vector[0] = 1;
    return vector;
  }

  const norm = Math.sqrt(sumSquares);
  for (let i = 0; i < dimensions; i++) {
    vector[i] = (vector[i] as number) / norm;
  }
  return vector;
}

// ---------------------------------------------------------------------------
// Task responders
// ---------------------------------------------------------------------------

const INTENTIONS = [
  'carry on with the day\'s work',
  'find someone to talk to about the death',
  'keep clear of the plaza for now',
  'look for whoever was near the steps that night',
  'settle a debt before it is called in',
  'listen for what the other house is saying',
];

const ACTIONS = [
  'works quietly, listening',
  'mutters to a neighbour',
  'watches the road',
  'sets down their tools and looks up',
  'crosses the square without stopping',
  'lingers where the talk is loudest',
];

const DIALOGUE_OPENERS = [
  'I have heard what you have heard, and no more than that.',
  'You are new here, so I will say it plainly.',
  'I would not repeat that where the wrong ear could catch it.',
  'Ask me again when the magistrate has spoken.',
  'That is not a thing to say in the open.',
  'There are two stories in this town and neither one fits.',
];

const SPEECH_ACTS = [
  'accuse', 'defend', 'corroborate', 'dispute', 'reconcile',
  'threaten', 'inform', 'inquire', 'summon', 'smalltalk',
];

/**
 * Cue words for each speech act, in priority order.
 *
 * Ordered rather than scored, because an utterance that both threatens and asks
 * a question is a threat. The first list whose cue appears wins.
 */
const CUES: readonly (readonly [act: string, cues: readonly string[]])[] = [
  ['summon', ['summon', 'hearing', 'meet me at', 'come to the plaza', 'gather at']],
  ['threaten', ['burn', 'kill you', 'ruin you', 'regret', 'or else', 'watch yourself']],
  ['reconcile', ['peace', 'terms', 'forgive', 'settle this', 'lay it down', 'no more blood',
                 'talk to them', 'come to the table', 'end this']],
  // Denials outrank accusations deliberately. Someone rejecting a rumor almost
  // always quotes it first — "that Corvane ordered it is a lie" contains every
  // cue an accusation has, plus the one that says it is being denied.
  ['dispute', ['not true', 'untrue', 'a lie', 'nonsense', 'no proof', 'never happened']],
  ['defend', ['innocent', 'would never', 'defend', 'not their doing', 'wrongly']],
  ['accuse', ['killed', 'murdered', 'guilty', 'you did it', 'they did it', 'to blame',
              'ordered the', 'paid to']],
  ['corroborate', ['i saw', 'i heard it too', 'true', 'confirm', 'so it is']],
  ['inform', ['you should know', 'i have news', 'word from', 'let me tell you']],
  ['inquire', ['?']],
];

function classifyByCue(text: string): string | null {
  const lowered = text.toLowerCase();
  for (const [act, cues] of CUES) {
    if (cues.some((cue) => lowered.includes(cue))) return act;
  }
  return null;
}

function pickFromChoices(
  request: CompletionRequest,
  key: string,
  rng: ReturnType<typeof createRng>,
): string | null {
  const options = request.choices?.[key];
  if (!options || options.length === 0) return null;
  return rng.pick(options);
}

function respond(request: CompletionRequest): string {
  // Seeding from the caller's seed *and* the task keeps two different tasks at
  // the same tick from producing correlated answers.
  const rng = createRng(deriveSeed(request.seed, request.task, request.promptVersion));

  switch (request.task) {
    case 'plan': {
      const target = pickFromChoices(request, 'locations', rng);
      const acts = request.choices?.acts ?? [];
      const claims = request.choices?.claims ?? [];
      const hasRecalledEvidence = request.user.includes('Recalled memory evidence:');
      const act = hasRecalledEvidence && claims.length > 0 && acts.length > 0
        ? rng.pick(acts)
        : 'none';
      return JSON.stringify({
        intention: rng.pick(INTENTIONS),
        targetLocationKey: target,
        action: rng.pick(ACTIONS),
        act,
        claimKey: act === 'accuse' ? rng.pick(claims) : null,
      });
    }

    case 'classify': {
      // Cue words first, then a seeded pick.
      //
      // A purely random classifier would make every scripted test vacuous: a
      // transcript written to reconcile the two Houses would be classified as
      // an accusation a third of the time, and the peace-path acceptance test
      // could never be written. Matching obvious cues is crude, but it means
      // the stub answers the question that was actually asked, which is the
      // standard the rest of this file is held to.
      const cued = classifyByCue(request.user);
      const type = cued ?? pickFromChoices(request, 'types', rng) ?? rng.pick(SPEECH_ACTS);
      return JSON.stringify({ type });
    }

    case 'dialogue':
      return rng.pick(DIALOGUE_OPENERS);

    case 'conversation_turn': {
      const playerText = latestConversationUtterance(request.user);
      const cued = classifyByCue(playerText);
      const type = playerText.includes('?') && cued !== 'summon' && cued !== 'threaten'
        ? 'inquire' : (cued ?? 'smalltalk');
      return JSON.stringify({
        reply: rng.pick(DIALOGUE_OPENERS),
        speechAct: type,
        disclosure: type === 'inquire'
          ? (pickFromChoices(request, 'disclosures', rng) ?? 'deflect')
          : null,
        hearingResponse: type === 'summon'
          ? (pickFromChoices(request, 'hearingResponses', rng) ?? 'come')
          : null,
        referencedClaimKeys: [],
      });
    }

    case 'npc_conversation':
      return JSON.stringify({
        turns: [
          { speaker: 'sender', text: rng.pick(DIALOGUE_OPENERS) },
          { speaker: 'listener', text: rng.pick(DIALOGUE_OPENERS) },
        ],
      });

    case 'reflect': {
      const refs = [...(request.choices?.memories ?? [])];
      if (refs.length < 2) return JSON.stringify({ memoryRefs: [] });
      const first = rng.pick(refs);
      const second = rng.pick(refs.filter((ref) => ref !== first));
      return JSON.stringify({ memoryRefs: [first, second] });
    }

    case 'distort': {
      // The telephone effect: the stub degrades wording without inventing
      // meaning, which is enough to make distortion observable in tests.
      const source = request.user.trim();
      const hedges = ['They say ', 'Word is ', 'I heard tell that ', 'Some are saying '];
      const truncated = source.length > 90 ? `${source.slice(0, 90).trimEnd()}...` : source;
      return `${rng.pick(hedges)}${truncated.charAt(0).toLowerCase()}${truncated.slice(1)}`;
    }

    case 'strategy':
      return JSON.stringify({
        tactic: pickFromChoices(request, 'tactics', rng),
        target: pickFromChoices(request, 'targets', rng),
        claim: pickFromChoices(request, 'claims', rng),
        posture: pickFromChoices(request, 'postures', rng) ?? 'press',
      });

    case 'attendance':
      return JSON.stringify({
        response: pickFromChoices(request, 'responses', rng) ?? 'come',
      });

    case 'inquire':
      return JSON.stringify({
        disclosure: pickFromChoices(request, 'disclosures', rng) ?? 'deflect',
      });

    default: {
      const exhaustive: never = request.task;
      throw new InferenceError(exhaustive, 'no stub responder defined');
    }
  }
}

function latestConversationUtterance(prompt: string): string {
  try {
    const value = JSON.parse(prompt) as { latestPlayerUtterance?: unknown };
    if (typeof value.latestPlayerUtterance === 'string') return value.latestPlayerUtterance;
  } catch {
    // Older recordings used a plain-text prompt. Keep replay fixtures readable.
  }
  return prompt.split(/\nPlayer: /).at(-1) ?? prompt;
}

export interface StubOptions {
  dimensions?: number;
  /** Simulated latency, for exercising timeout and concurrency paths. */
  latencyMs?: number;
}

export function createStubClient(options: StubOptions = {}): InferenceClient {
  const dimensions = options.dimensions ?? 1024;
  const latencyMs = options.latencyMs ?? 0;

  const delay = async (): Promise<void> => {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  };

  return {
    mode: 'stub',
    reasoningModelId: STUB_MODEL_ID,
    embeddingModelId: STUB_EMBEDDING_ID,
    dimensions,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      await delay();
      const text = respond(request);
      return {
        text,
        // Rough but stable token accounting, so budget logic is exercised.
        tokensIn: Math.ceil((request.system.length + request.user.length) / 4),
        tokensOut: Math.ceil(text.length / 4),
        modelId: STUB_MODEL_ID,
        latencyMs,
      };
    },

    async *stream(request: CompletionRequest): AsyncGenerator<string, StreamUsage, void> {
      await delay();
      const text = respond(request);
      // Chunked by word so consumers exercise real incremental assembly.
      for (const word of text.split(' ')) {
        yield `${word} `;
      }
      // Counted the same way `complete` counts, so budget logic is exercised on
      // the streamed path too. Priced at zero, like all stub usage.
      return {
        tokensIn: Math.ceil((request.system.length + request.user.length) / 4),
        tokensOut: Math.ceil(text.length / 4),
        modelId: STUB_MODEL_ID,
        latencyMs,
      };
    },

    async embed(texts: readonly string[]): Promise<EmbeddingResponse> {
      await delay();
      return {
        vectors: texts.map((text) => stubEmbed(text, dimensions)),
        tokensIn: texts.reduce((total, text) => total + Math.ceil(text.length / 4), 0),
        modelId: STUB_EMBEDDING_ID,
        latencyMs,
      };
    },
  };
}
