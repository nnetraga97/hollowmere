export interface TownLocation {
  key: string;
  name: string;
  districtKey: string;
  x: number;
  y: number;
  gossipBonus: number;
  controllingFactionKey: string | null;
}

export interface TownRoute { from: string; to: string; cost: number }

export interface TownMap {
  scenarioVersion: string;
  locations: TownLocation[];
  routes: TownRoute[];
}

export interface AgentView {
  agentKey: string;
  name: string;
  factionKey: string;
  locationKey: string;
  status: string;
  currentAction: string | null;
  topClaimKey: string | null;
  topConfidence: number;
}

export interface EvidenceView {
  evidenceId: string;
  kind: 'provenance' | 'contradiction' | 'record';
  accusedKey: string | null;
  claimKey: string | null;
  foundTick: number;
  manufactured: boolean;
  credibility: number;
  discoveredTick: number | null;
  genuine?: boolean;
}

export interface PlayerRumor {
  claimKey: string;
  text: string;
  subjectKey: string;
  createdTick: number;
  status: 'active' | 'discredited';
  heat: number;
  reach: number;
  evidenceId: string | null;
  evidenceCredibility: number | null;
  fabricationOutcome: 'created' | 'failed' | 'exposed' | null;
}

export interface HearingView {
  hearingId: string;
  locationKey: string;
  dueTick: number;
  status: string;
  revealClaimKey: string | null;
  announcedTick: number;
  resolvedTick: number | null;
  commitments: { agentKey: string; response: string; status: string; dueTick: number }[];
}

export interface ConversationTurn {
  turnId: string; ordinal: number; playerText: string; reply: string;
  speechAct: string; referencedClaimKeys: string[];
  recalledMemories: {
    memoryId: string; candidatePaths: ('ann' | 'importance' | 'recency' | 'pinned_anchor')[];
  }[];
  fallback: boolean;
}

export interface Conversation {
  conversationId: string; agentKey: string; agentName: string; status: string;
  openedTick: number; turnCount: number; timeCostTicks: number;
  participants: { agentKey: string; name: string; role: 'target' | 'observer' }[];
  turns: ConversationTurn[];
}

export interface GameSnapshot {
  world: {
    worldId: string; status: string; ending: string | null; currentTick: number;
    day: number; phase: string; stage: string; globalTension: number;
    peaceStreak: number; seed: number; inferenceProfile: 'stub' | 'azure_terra' | 'bedrock_sonnet';
    timeScale: number; timeDebtTicks: number; agentsAlive: number;
    inferenceCalls: number; estCostMicros: number;
  };
  player: {
    playerId: string; name: string; background: string; sympathyFactionKey: string | null;
    locationKey: string;
    reputation: { factionKey: string; value: number }[];
    pendingMove: { commandId: string; locationKey: string } | null;
  };
  agents: AgentView[];
  factions: {
    factionKey: string; name: string; belligerent: boolean; tension: number;
    willingToNegotiate: boolean; leaderKey: string | null; members: number;
  }[];
  claims: {
    claimKey: string; text: string; truth: string; severity: number; subjectKey: string;
    heat: number; believers: number; deniers: number; averageConfidence: number; reached: number;
  }[];
  evidence: EvidenceView[];
  playerRumors: PlayerRumor[];
  hearings: HearingView[];
  cognition: {
    tick: number; agentKey: string; modelId: string; promptVersion: string;
    decision: Record<string, unknown>; latencyMs: number;
  }[];
  metrics: { tick: number; durationMs: number; retryCount: number }[];
  conversation: Conversation | null;
  romances: RomanceArc[];
  capabilities: { instigator: boolean; hearings: boolean; evidence: boolean };
}

export interface GameSync {
  world: {
    worldId: string; status: string; ending: string | null; currentTick: number;
  };
  player: {
    locationKey: string;
    pendingMove: { commandId: string; locationKey: string } | null;
  };
}

export type RomanceStatus = 'open' | 'growing' | 'courting' | 'committed'
  | 'platonic' | 'complicated' | 'strained';

export interface RomanceProfile {
  routeTitle: string; role: string; publicFace: string; privateSelf: string;
  centralWound: string; deepestWant: string; contradiction: string; humor: string;
  affectionStyle: string; conflictStyle: string; boundaries: string[]; tells: string[];
  plotRole: string; actionLogic: string[];
}

export interface RomanceMoment {
  sceneKey: string; chapter: number; chapterCount: number; title: string; kicker: string;
  setting: string; narration: string; callbacks: string[]; opening: string;
  choices: { key: string; label: string; intent: string }[];
}

export interface RomanceHistory {
  tick: number; sceneKey: string; title: string; choiceKey: string; choiceLabel: string;
  response: string; aftermath: string; statusAfter: RomanceStatus; revealedClaimKeys: string[];
}

export interface RomanceArc {
  agentKey: string; name: string; shortName: string; factionKey: string;
  agentStatus: string; agentLocationKey: string; routeTitle: string; profile: RomanceProfile;
  stage: number; chapterCount: number; status: RomanceStatus;
  bond: { trust: number; affinity: number; fear: number; respect: number };
  flags: string[]; revealedClaimKeys: string[]; history: RomanceHistory[];
  available: boolean; availabilityReason: string | null; moment: RomanceMoment | null;
  epilogue: string;
}

export interface RomanceChoiceResult {
  eventId: string; replayed: boolean; agentKey: string; sceneKey: string; choiceKey: string;
  response: string; aftermath: string; effectSummary: string[]; arc: RomanceArc;
}

export interface Bootstrap {
  session: { worldId: string };
  map: TownMap;
  game: GameSnapshot;
}

export interface AgentDetail {
  agent: AgentView;
  summary: string;
  traits: string[];
  beliefs: { claimKey: string; confidence: number; updatedTick: number }[];
  relationships: { agentKey: string; sentiment: number; trust: number }[];
  cognition: GameSnapshot['cognition'];
  recentDialogue: { tick: number; text: string }[];
  memoryTrace: {
    memoryId: string; formedTick: number; lastAccessedTick: number | null;
    kind: string; excerpt: string; claimKey: string | null;
    sourceKind: 'turn' | 'event'; sourceId: string;
    recalledByTurnId: string | null;
    candidatePaths: ('ann' | 'importance' | 'recency' | 'pinned_anchor')[];
  }[];
  personality: { kindness: number; engagement: number; honesty: number };
  playerRelationship: {
    trust: number; affinity: number; fear: number; respect: number; impression: string | null;
  } | null;
}

export interface DebugTruth {
  available: boolean;
  culprit: { agentKey: string; motiveKey: string; exposedTick: number | null } | null;
  scheme: {
    posture: string; currentTactic: string | null; targetAgentKey: string | null;
    claimKey: string | null; nextStrategyTick: number;
  } | null;
  evidence: EvidenceView[];
}

export interface ChronicleEntry {
  tick: number; seq: number; kind: string; description: string;
  actorKey: string | null; locationKey: string | null;
}

export interface SocialGraph {
  nodes: { key: string; name: string; factionKey: string; status: string }[];
  edges: { src: string; dst: string; sentiment: number; trust: number }[];
}

export interface TensionPoint { tick: number; globalTension: number; stage: string }
