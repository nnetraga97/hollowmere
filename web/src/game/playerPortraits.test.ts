import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PLAYER_PORTRAIT_KEY, isPlayerPortraitKey, PLAYER_PORTRAITS, playerPortraitPath,
} from './playerPortraits.ts';

test('provides two selectable player portraits with a stable fallback', () => {
  assert.equal(PLAYER_PORTRAITS.length, 2);
  assert.equal(isPlayerPortraitKey('player_wayfarer'), true);
  assert.equal(isPlayerPortraitKey('unknown'), false);
  assert.equal(playerPortraitPath('player_wayfarer'), '/assets/hollowmere/portraits/players/player_wayfarer.jpg');
  assert.equal(playerPortraitPath(undefined), playerPortraitPath(DEFAULT_PLAYER_PORTRAIT_KEY));
});
