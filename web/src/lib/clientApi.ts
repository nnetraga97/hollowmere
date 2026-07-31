import type {
  AgentDetail, Bootstrap, ChronicleEntry, Conversation, ConversationTurn, DebugTruth, GameSnapshot, GameSync,
  RomanceChoiceResult,
  SocialGraph, TensionPoint,
} from './contracts';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function decode<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(body.error ?? `request failed (${response.status})`, response.status);
  }
  return body;
}

export interface PlayerEntry {
  playerName?: string;
  background?: string;
  sympathyFactionKey?: 'aldreth' | 'corvane' | 'unaligned' | null;
  inferenceProfile?: 'azure_sol' | 'azure_terra';
  seed?: number;
}

export interface WorldChoice {
  worldId: string;
  status: string;
  ending: string | null;
  currentTick: number;
  day: number;
  stage: string;
  seed: number;
  inferenceProfile: 'stub' | 'azure_sol' | 'azure_terra' | 'bedrock_sonnet';
  createdAt: string;
}

export async function listWorlds(): Promise<WorldChoice[]> {
  const result = await decode<{ worlds: WorldChoice[] }>(await fetch('/api/session', {
    cache: 'no-store',
  }));
  return result.worlds;
}

export async function startSession(
  entry: PlayerEntry = {},
  options: { newWorld?: boolean; worldId?: string } = {},
): Promise<Bootstrap> {
  return decode(await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...entry, ...options }),
  }));
}

export async function loadGame(signal?: AbortSignal): Promise<GameSnapshot> {
  return decode(await fetch('/api/game', { cache: 'no-store', signal }));
}

export async function loadGameSync(signal?: AbortSignal): Promise<GameSync> {
  return decode(await fetch('/api/game/sync', { cache: 'no-store', signal }));
}

export async function movePlayer(locationKey: string, idempotencyKey: string) {
  return decode<{
    commandId: string; replayed: boolean; locationKey: string; appliedTick: number;
  }>(await fetch('/api/move', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ locationKey, idempotencyKey }),
  }));
}

export async function loadChronicle(sinceTick = 0, limit = 100): Promise<ChronicleEntry[]> {
  const params = new URLSearchParams({ sinceTick: String(sinceTick), limit: String(limit) });
  return decode(await fetch(`/api/chronicle?${params}`, { cache: 'no-store' }));
}

export async function loadGraph(): Promise<SocialGraph> {
  return decode(await fetch('/api/graph', { cache: 'no-store' }));
}

export async function loadTension(): Promise<TensionPoint[]> {
  return decode(await fetch('/api/tension', { cache: 'no-store' }));
}

export async function loadAgent(agentKey: string, signal?: AbortSignal): Promise<AgentDetail> {
  return decode(await fetch(`/api/agent/${encodeURIComponent(agentKey)}`, { cache: 'no-store', signal }));
}

export async function loadTruth(): Promise<DebugTruth> {
  return decode(await fetch('/api/debug/truth', { cache: 'no-store' }));
}

export async function chooseRomance(input: {
  agentKey: string; sceneKey: string; choiceKey: string; locationKey: string;
}): Promise<RomanceChoiceResult> {
  return decode(await fetch('/api/romance', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, idempotencyKey: crypto.randomUUID() }),
  }));
}

export interface PlantRumorResult {
  commandId: string;
  replayed: boolean;
  claimKey: string;
  listenerKey: string;
  confidenceBefore: number;
  confidenceAfter: number;
  reaction: 'believes' | 'uncertain' | 'rejects';
  usedManufacturedEvidence: boolean;
  response: string;
}

export async function plantRumor(input: {
  listenerAgentKey: string;
  subjectAgentKey?: string;
  text?: string;
  claimKey?: string;
  evidenceId?: string;
}): Promise<PlantRumorResult> {
  return decode(await fetch('/api/deception', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'plant', ...input, idempotencyKey: crypto.randomUUID() }),
  }));
}

export interface ManufactureEvidenceResult {
  commandId: string;
  replayed: boolean;
  claimKey: string;
  outcome: 'created' | 'failed' | 'exposed';
  chance: number;
  quality: number;
  evidenceId: string | null;
  response: string;
}

export async function manufactureEvidence(claimKey: string): Promise<ManufactureEvidenceResult> {
  return decode(await fetch('/api/deception', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'manufacture', claimKey, idempotencyKey: crypto.randomUUID() }),
  }));
}

export async function control(body: Record<string, unknown>) {
  return decode<Record<string, unknown>>(await fetch('/api/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

export async function startConversation(agentKey: string): Promise<Conversation> {
  return decode(await fetch('/api/converse', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start', agentKey, idempotencyKey: crypto.randomUUID() }),
  }));
}

export async function closeConversation(conversationId: string): Promise<Conversation> {
  return decode(await fetch('/api/converse', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'close', conversationId, idempotencyKey: crypto.randomUUID() }),
  }));
}

export async function streamConversationTurn(
  input: { conversationId: string; text: string; idempotencyKey: string },
  onToken: (token: string) => void,
): Promise<{ turn: ConversationTurn; conversation: Conversation }> {
  const response = await fetch('/api/converse', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'turn', ...input }),
  });
  if (!response.ok || !response.body) return decode(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let final: { turn: ConversationTurn; conversation: Conversation } | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const raw = frame.match(/^data: (.+)$/m)?.[1];
      if (event && raw) {
        const data = JSON.parse(raw) as {
          token?: string; error?: string; turn?: ConversationTurn; conversation?: Conversation;
        };
        if (event === 'token' && data.token) onToken(data.token);
        if (event === 'result' && data.turn && data.conversation) {
          final = { turn: data.turn, conversation: data.conversation };
        }
        if (event === 'error') throw new Error(data.error ?? 'conversation failed');
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (!final) throw new Error('conversation ended without a result');
  if (final.turn.fallback) {
    console.warn('[Hollowmere] conversation fallback', {
      conversationId: final.conversation.conversationId,
      agentKey: final.conversation.agentKey,
      agentName: final.conversation.agentName,
      turnId: final.turn.turnId,
      speechAct: final.turn.speechAct,
    });
  }
  return final;
}
