import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AgentView } from '@/lib/contracts';
import { LOCATION_KEYS } from './mapManifest.ts';
import {
  atlasPosition, formatAction, LOCATION_SCENES, portraitPath, rankLocationAgents, relationshipLevel,
} from './locationScenes.ts';

const agent = (agentKey: string, locationKey = 'quay'): AgentView => ({
  agentKey, locationKey, name: agentKey, factionKey: 'unaligned', status: 'alive',
  currentAction: 'watching_the_tide', topClaimKey: null, topConfidence: 0,
});

describe('location scene presentation helpers', () => {
  test('maps atlas cells to edge-safe CSS positions', () => {
    assert.equal(atlasPosition('chapel'), '0% 0%');
    assert.equal(atlasPosition('tavern'), `${(2 / 3) * 100}% 100%`);
    assert.equal(atlasPosition('missing'), '100% 100%');
  });

  test('turns engine actions into readable reasons', () => {
    assert.equal(formatAction('watching_the_tide'), 'watching the tide');
    assert.equal(formatAction(null), 'keeping their own counsel');
  });

  test('clamps relationship values into five visible bonds', () => {
    assert.equal(relationshipLevel(null), 0);
    assert.equal(relationshipLevel({ trust: 0, affinity: -10_000 }), 0);
    assert.equal(relationshipLevel({ trust: 5_000, affinity: 0 }), 2.5);
    assert.equal(relationshipLevel({ trust: 10_000, affinity: 10_000 }), 5);
  });

  test('selects only available local agents in deterministic encounter order', () => {
    const elsewhere = agent('elsewhere', 'chapel');
    const unavailable = { ...agent('detained'), status: 'detained' };
    const first = rankLocationAgents([agent('a'), agent('b'), elsewhere, unavailable], 'quay', 7, 12);
    const second = rankLocationAgents([unavailable, agent('b'), agent('a'), elsewhere], 'quay', 7, 12);
    assert.deepEqual(first.map(({ agentKey }) => agentKey), second.map(({ agentKey }) => agentKey));
    assert.equal(first.length, 2);
  });

  test('covers every published map location with a unique scene cell', () => {
    assert.deepEqual(Object.keys(LOCATION_SCENES).sort(), [...LOCATION_KEYS].sort());
    const cells = Object.values(LOCATION_SCENES).map(({ atlasColumn, atlasRow }) => `${atlasColumn}:${atlasRow}`);
    assert.equal(new Set(cells).size, LOCATION_KEYS.length);
  });

  test('uses seed and epoch to vary a stable encounter order', () => {
    const candidates = Array.from({ length: 8 }, (_, index) => agent(`agent-${index}`));
    const orders = new Set(Array.from({ length: 12 }, (_, epoch) =>
      rankLocationAgents(candidates, 'quay', 42, epoch).map(({ agentKey }) => agentKey).join(',')));
    assert.ok(orders.size > 1);
  });

  test('selects faction and presentation variants for portraits', () => {
    assert.equal(portraitPath({ agentKey: 'maren_aldreth', factionKey: 'aldreth' }), '/assets/hollowmere/portraits/aldreth_female.jpg');
    assert.equal(portraitPath({ agentKey: 'rowan_corvane', factionKey: 'corvane' }), '/assets/hollowmere/portraits/corvane_male.jpg');
    assert.equal(portraitPath({ agentKey: 'morna_dell', factionKey: 'unaligned' }), '/assets/hollowmere/portraits/independent_woman.jpg');
  });
});
