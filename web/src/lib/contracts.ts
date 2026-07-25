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
  genuine?: boolean;
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

export interface GameSnapshot {
  world: {
    worldId: string; status: string; ending: string | null; currentTick: number;
    day: number; phase: string; stage: string; globalTension: number;
    peaceStreak: number; seed: number; timeScale: number; agentsAlive: number;
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
  hearings: HearingView[];
  cognition: {
    tick: number; agentKey: string; modelId: string; promptVersion: string;
    decision: Record<string, unknown>; latencyMs: number;
  }[];
  metrics: { tick: number; durationMs: number; retryCount: number }[];
  capabilities: { instigator: boolean; hearings: boolean; evidence: boolean };
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
