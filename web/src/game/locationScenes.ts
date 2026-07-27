import type { AgentView } from '@/lib/contracts';

export interface LocationSceneCopy {
  kicker: string;
  description: string;
  ambience: string;
  atlasColumn: number;
  atlasRow: number;
}

export const LOCATION_SCENES: Record<string, LocationSceneCopy> = {
  chapel: {
    kicker: 'Candle smoke & old vows',
    description: 'Stone keeps every whisper. Even the rain lowers its voice at the chapel door.',
    ambience: 'Wax gutters in the nave while the bell rope shifts without a hand.',
    atlasColumn: 0, atlasRow: 0,
  },
  fields: {
    kicker: 'Beyond the last wall',
    description: 'Barley bends toward the sea, exposing every lone figure against the storm.',
    ambience: 'Wind combs the crop in dark waves. Somewhere, a gate knocks twice.',
    atlasColumn: 1, atlasRow: 0,
  },
  granary: {
    kicker: 'The town\'s winter counted',
    description: 'Every sack is a promise, every missing measure a reason for suspicion.',
    ambience: 'Timbers settle under their load and grain dust hangs in the lantern light.',
    atlasColumn: 2, atlasRow: 0,
  },
  high_row: {
    kicker: 'Above the common roofs',
    description: 'Blue banners watch a street built to make visitors feel observed.',
    ambience: 'Rain shines on dressed stone. A shutter closes before you look up.',
    atlasColumn: 3, atlasRow: 0,
  },
  low_row: {
    kicker: 'Where the walls lean close',
    description: 'Work, hunger, and rumor share the same narrow lanes.',
    ambience: 'Water threads between the cobbles beneath a hundred curtained windows.',
    atlasColumn: 0, atlasRow: 1,
  },
  market_square: {
    kicker: 'Hollowmere\'s open ledger',
    description: 'News changes hands faster than coin beneath the dripping awnings.',
    ambience: 'Canvas snaps overhead. Traders lower their voices as you pass.',
    atlasColumn: 1, atlasRow: 1,
  },
  mill: {
    kicker: 'The wheel never forgets',
    description: 'Water and timber turn the town\'s labor into power, one groaning tooth at a time.',
    ambience: 'The great wheel makes conversation private, if not entirely safe.',
    atlasColumn: 2, atlasRow: 1,
  },
  plaza: {
    kicker: 'A stage for public truth',
    description: 'Proclamations, bargains, and accusations all sound official here.',
    ambience: 'Rain beads on the empty plinth while footsteps cross the colonnade.',
    atlasColumn: 3, atlasRow: 1,
  },
  quay: {
    kicker: 'Where the tide brings stories',
    description: 'Lanterns divide the fog into small islands of certainty.',
    ambience: 'Rope strains, hulls knock softly, and black water folds beneath the piers.',
    atlasColumn: 0, atlasRow: 2,
  },
  shipyard: {
    kicker: 'Keels, sparks & hard bargains',
    description: 'Half-built vessels loom like ribs around the orange work fires.',
    ambience: 'Mallets answer one another across the slips as pitch smokes in the rain.',
    atlasColumn: 1, atlasRow: 2,
  },
  tavern: {
    kicker: 'Warmth with witnesses',
    description: 'The hearth welcomes everyone. The room remembers who sat with whom.',
    ambience: 'A log breaks in the fire; cups pause, then conversation resumes.',
    atlasColumn: 2, atlasRow: 2,
  },
};

export function atlasPosition(locationKey: string): string {
  const scene = LOCATION_SCENES[locationKey] ?? { atlasColumn: 3, atlasRow: 2 };
  return `${(scene.atlasColumn / 3) * 100}% ${(scene.atlasRow / 2) * 100}%`;
}

export function formatAction(action: string | null): string {
  if (!action) return 'keeping their own counsel';
  return action.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
}

export function relationshipLevel(relationship: {
  trust: number; affinity: number;
} | null | undefined): number {
  if (!relationship) return 0;
  const normalized = ((relationship.trust / 10_000) + ((relationship.affinity + 10_000) / 20_000)) / 2;
  return Math.max(0, Math.min(5, normalized * 5));
}

export function rankLocationAgents(
  agents: readonly AgentView[],
  locationKey: string,
  seed: number,
  epoch: number,
): AgentView[] {
  return agents
    .filter((agent) => agent.locationKey === locationKey && ['alive', 'injured'].includes(agent.status))
    .map((agent) => ({
      agent,
      score: stableHash(`${seed}:${epoch}:${locationKey}:${agent.agentKey}`),
    }))
    .sort((left, right) => left.score - right.score || left.agent.agentKey.localeCompare(right.agent.agentKey))
    .map(({ agent }) => agent);
}

export function portraitPath(agent: Pick<AgentView, 'agentKey' | 'factionKey'>): string {
  const female = FEMALE_AGENT_KEYS.has(agent.agentKey);
  if (agent.factionKey === 'aldreth') return `/assets/hollowmere/portraits/aldreth_${female ? 'female' : 'male'}.jpg`;
  if (agent.factionKey === 'corvane') return `/assets/hollowmere/portraits/corvane_${female ? 'female' : 'male'}.jpg`;
  return `/assets/hollowmere/portraits/independent_${female ? 'woman' : 'priest'}.jpg`;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

const FEMALE_AGENT_KEYS = new Set([
  'maren_aldreth', 'sella_dorn', 'oriel_faskin', 'annet_pike', 'mabel_thorn', 'tamsin_vye',
  'edda_lyle', 'veranne_thule', 'hester_lowe', 'widow_sable', 'morna_dell', 'jenna_ryle',
]);
