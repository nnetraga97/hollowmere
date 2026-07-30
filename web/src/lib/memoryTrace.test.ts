import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MemoryTrace } from '../components/MemoryTrace.ts';
import { memoryPathAriaLabel, memoryPathLabel } from './memoryTrace.ts';

describe('memory trace presentation', () => {
  test('gives every retrieval path a distinct judge-facing label', () => {
    assert.equal(memoryPathLabel('ann'), 'ANN / vector');
    assert.equal(memoryPathLabel('importance'), 'importance');
    assert.equal(memoryPathLabel('recency'), 'recency');
    assert.equal(memoryPathLabel('pinned_anchor'), 'pinned anchor');
  });

  test('announces the same path labels rendered by the trace', () => {
    assert.equal(
      memoryPathAriaLabel(['ann', 'importance', 'pinned_anchor']),
      'Retrieval paths: ANN / vector, importance, pinned anchor',
    );
  });

  test('renders bounded provenance without an embedding or hidden prompt field', () => {
    const markup = renderToStaticMarkup(createElement(MemoryTrace, { memories: [{
      memoryId: '11111111-1111-1111-1111-111111111111',
      formedTick: 12,
      lastAccessedTick: 27,
      kind: 'dialogue',
      excerpt: 'The outsider warned me about the chapel ledger.',
      claimKey: 'physician_was_paid',
      sourceKind: 'turn',
      sourceId: '22222222-2222-2222-2222-222222222222',
      recalledByTurnId: '33333333-3333-3333-3333-333333333333',
      candidatePaths: ['ann', 'pinned_anchor'],
    }] }));

    assert.match(markup, /Memory trace/);
    assert.match(markup, /11111111-1111-1111-1111-111111111111/);
    assert.match(markup, /ANN \/ vector/);
    assert.match(markup, /pinned anchor/);
    assert.match(markup, /Retrieval paths: ANN \/ vector, pinned anchor/);
    assert.doesNotMatch(markup, /embedding|systemPrompt|userPrompt/);
  });
});
