import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { AgentView, TownMap } from '../lib/contracts.ts';
import {
  areAdjacent, interpolateRoute, LOCATION_KEYS, MAP_VERSION, npcOffset, shouldSuppressGameInput,
  validateTownMap, withinInteractionRange,
} from './mapManifest.ts';

const routes = [
  ['market_square', 'quay'], ['market_square', 'shipyard'], ['market_square', 'plaza'],
  ['market_square', 'tavern'], ['market_square', 'low_row'], ['market_square', 'granary'],
  ['quay', 'shipyard'], ['plaza', 'chapel'], ['granary', 'mill'], ['mill', 'fields'],
  ['granary', 'fields'], ['tavern', 'low_row'], ['low_row', 'high_row'], ['high_row', 'plaza'],
] as const;

const map: TownMap = {
  scenarioVersion: 'hollowmere-v4',
  locations: LOCATION_KEYS.map((key, index) => ({
    key, name: key, districtKey: 'test', x: index, y: index,
    gossipBonus: 0, controllingFactionKey: null,
  })),
  routes: routes.flatMap(([from, to]) => [{ from, to, cost: 1 }, { from: to, to: from, cost: 1 }]),
};

const agent = (agentKey: string): AgentView => ({
  agentKey, name: agentKey, factionKey: 'unaligned', locationKey: 'plaza',
  status: 'alive', currentAction: null, topClaimKey: null, topConfidence: 0,
});

test('the Hollowmere map manifest covers the published location graph', () => {
  assert.deepEqual(validateTownMap(map), []);
  assert.equal(areAdjacent(map, 'plaza', 'chapel'), true);
  assert.equal(areAdjacent(map, 'chapel', 'fields'), false);
});

test('the map supports the authored scenario version', async () => {
  const scenario = JSON.parse(
    await readFile(new URL('../../../scenario/hollowmere-v2.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(MAP_VERSION, scenario.version);
});

test('NPC offsets are deterministic regardless of API row order', () => {
  const agents = [agent('maren'), agent('alric'), agent('veranne')];
  assert.deepEqual(npcOffset('maren', agents), npcOffset('maren', [...agents].reverse()));
  assert.notDeepEqual(npcOffset('maren', agents), npcOffset('alric', agents));
});

test('route interpolation follows an edge and clamps overshoot', () => {
  assert.deepEqual(interpolateRoute({ x: 10, y: 20 }, { x: 30, y: 60 }, 0.5), { x: 20, y: 40 });
  assert.deepEqual(interpolateRoute({ x: 10, y: 20 }, { x: 30, y: 60 }, 2), { x: 30, y: 60 });
});

test('interaction proximity includes the boundary', () => {
  assert.equal(withinInteractionRange({ x: 0, y: 0 }, { x: 45, y: 60 }), true);
  assert.equal(withinInteractionRange({ x: 0, y: 0 }, { x: 46, y: 60 }), false);
});

test('game input is suppressed while editable DOM controls have focus', () => {
  assert.equal(shouldSuppressGameInput({ tagName: 'TEXTAREA' }), true);
  assert.equal(shouldSuppressGameInput({ tagName: 'select' }), true);
  assert.equal(shouldSuppressGameInput({ tagName: 'button' }), false);
  assert.equal(shouldSuppressGameInput({ isContentEditable: true }), true);
});
