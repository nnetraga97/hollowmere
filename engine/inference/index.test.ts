/**
 * Inference stub behaviour.
 *
 * Two properties matter and are easy to lose: the stub must be reproducible
 * from its seed, and its embeddings must carry genuine lexical similarity. If
 * the second were fake, every retrieval test written against the stub would
 * pass without proving anything.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInferenceClient, createStubClient, isBillableInferenceMode, stubEmbed,
} from './index.ts';
import type { CompletionRequest } from './index.ts';
import {
  enabledInferenceProfiles, isInferenceProfileEnabled, isSelectableInferenceProfile,
} from './profiles.ts';
import { effectiveWorldInferenceProfile, inferenceForProfile } from './world.ts';
import {
  deriveGroundedClaimSupport, parsePlan, parseReflectionRefs,
} from '../agents/cognition.ts';
import {
  completionRequestHash, completionRequestSnapshot,
} from './prompts.ts';

const DIMS = 1024;

test('only live provider inference is billable', () => {
  assert.equal(isBillableInferenceMode('bedrock'), true);
  assert.equal(isBillableInferenceMode('azure'), true);
  assert.equal(isBillableInferenceMode('stub'), false);
  assert.equal(isBillableInferenceMode('replay'), false);
});

test('world inference choices are a closed server allowlist', () => {
  assert.equal(isSelectableInferenceProfile('azure_sol'), true);
  assert.equal(isSelectableInferenceProfile('azure_terra'), true);
  assert.equal(isSelectableInferenceProfile('bedrock_sonnet'), false);
  assert.equal(isSelectableInferenceProfile('stub'), false);
  assert.equal(isSelectableInferenceProfile('arbitrary-model-id'), false);
});

test('the public selector exposes both Azure GPT-5.6 profiles', () => {
  assert.deepEqual(enabledInferenceProfiles(), ['azure_terra', 'azure_sol']);
  assert.equal(isInferenceProfileEnabled('azure_sol', ''), true);
  assert.equal(isInferenceProfileEnabled('azure_terra', ''), true);
  assert.equal(isInferenceProfileEnabled('bedrock_sonnet', ''), false);
  assert.equal(isInferenceProfileEnabled('bedrock_sonnet', 'TRUE'), true);
});

test('per-world routing is live only after explicit deployment opt-in', () => {
  assert.equal(effectiveWorldInferenceProfile('azure_sol', 'world'), 'azure_sol');
  assert.equal(effectiveWorldInferenceProfile('azure_terra', 'world'), 'azure_terra');
  assert.equal(effectiveWorldInferenceProfile('bedrock_sonnet', 'world'), 'bedrock_sonnet');
  assert.equal(effectiveWorldInferenceProfile('azure_terra', 'stub'), 'stub');
  assert.equal(effectiveWorldInferenceProfile('bedrock_sonnet', undefined), 'stub');
});

test('a stored Bedrock profile cannot invoke Bedrock while its deployment flag is off', () => {
  const previousMode = process.env.INFERENCE_MODE;
  const previousEnabled = process.env.BEDROCK_ENABLED;
  process.env.INFERENCE_MODE = 'world';
  process.env.BEDROCK_ENABLED = 'false';
  try {
    assert.throws(
      () => inferenceForProfile('bedrock_sonnet'),
      /bedrock_sonnet is disabled/,
    );
  } finally {
    if (previousMode === undefined) delete process.env.INFERENCE_MODE;
    else process.env.INFERENCE_MODE = previousMode;
    if (previousEnabled === undefined) delete process.env.BEDROCK_ENABLED;
    else process.env.BEDROCK_ENABLED = previousEnabled;
  }
});

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    task: 'plan',
    promptVersion: 'v1',
    system: 'You are an agent.',
    user: 'What will you do?',
    maxTokens: 256,
    seed: 12345,
    ...overrides,
  };
}

test('completion request snapshots include effective constraints and hash all prompt inputs', () => {
  const original = request({
    user: '{"latestPlayerUtterance":"What happened?"}',
    choices: { claims: ['edryc_investigated_fairly'] },
  });
  const snapshot = completionRequestSnapshot(original);
  assert.match(snapshot.system, /Choose only from these known values/);
  assert.match(snapshot.system, /edryc_investigated_fairly/);
  assert.equal(snapshot.user, original.user);

  const originalHash = completionRequestHash(original);
  assert.equal(originalHash, completionRequestHash({ ...original }));
  assert.notEqual(
    originalHash,
    completionRequestHash({
      ...original,
      user: '{"latestPlayerUtterance":"Who died?"}',
    }),
  );
  assert.notEqual(
    originalHash,
    completionRequestHash({ ...original, system: 'Changed system prompt.' }),
  );
  assert.notEqual(
    originalHash,
    completionRequestHash({ ...original, choices: { claims: ['another_claim'] } }),
  );
});

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

describe('stub embeddings', () => {
  test('are unit vectors of the configured dimension', () => {
    const vector = stubEmbed('the prince is dead', DIMS);
    assert.equal(vector.length, DIMS);
    assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-9, 'should be L2-normalised');
  });

  test('are identical for identical text', () => {
    assert.deepEqual(stubEmbed('the granary books', DIMS), stubEmbed('the granary books', DIMS));
  });

  test('are insensitive to case and punctuation', () => {
    assert.deepEqual(
      stubEmbed('The Granary Books!', DIMS),
      stubEmbed('the granary books', DIMS),
    );
  });

  test('carry real lexical similarity', () => {
    const subject = stubEmbed('rowan corvane was seen near the quay that night', DIMS);
    const related = stubEmbed('someone saw rowan near the quay that night', DIMS);
    const unrelated = stubEmbed('the baker sells bread in the market square', DIMS);

    const relatedScore = cosine(subject, related);
    const unrelatedScore = cosine(subject, unrelated);

    assert.ok(
      relatedScore > unrelatedScore,
      `shared vocabulary should score higher: ${relatedScore} vs ${unrelatedScore}`,
    );
    assert.ok(relatedScore > 0.3, `related texts should be clearly close, got ${relatedScore}`);
  });

  test('handle empty and punctuation-only input without producing a zero vector', () => {
    for (const text of ['', '   ', '...!?']) {
      const vector = stubEmbed(text, DIMS);
      assert.ok(
        Math.abs(cosine(vector, vector) - 1) < 1e-9,
        `"${text}" should still yield a unit vector`,
      );
    }
  });
});

describe('stub completions', () => {
  test('are reproducible from the seed', async () => {
    const a = createStubClient();
    const b = createStubClient();
    const first = await a.complete(request());
    const second = await b.complete(request());
    assert.equal(first.text, second.text);
  });

  test('differ across seeds', async () => {
    const client = createStubClient();
    const first = await client.complete(request({ seed: 1 }));
    const second = await client.complete(request({ seed: 2 }));
    assert.notEqual(first.text, second.text);
  });

  test('differ across tasks at the same seed', async () => {
    const client = createStubClient();
    const plan = await client.complete(request({ task: 'plan' }));
    const dialogue = await client.complete(request({ task: 'dialogue' }));
    assert.notEqual(plan.text, dialogue.text);
  });

  test('a changed prompt version changes the answer', async () => {
    // Otherwise a prompt edit would silently reuse decisions made under the old
    // wording, which is exactly what promptVersion exists to prevent.
    const client = createStubClient();
    const v1 = await client.complete(request({ promptVersion: 'v1' }));
    const v2 = await client.complete(request({ promptVersion: 'v2' }));
    assert.notEqual(v1.text, v2.text);
  });

  test('plan returns usable JSON drawn from the offered choices', async () => {
    const client = createStubClient();
    const locations = ['market_square', 'tavern', 'quay'];
    const claims = ['corvane_ordered_killing'];
    const response = await client.complete(
      request({
        task: 'plan',
        user: 'Recalled memory evidence:\n[M1 claim=corvane_ordered_killing] I remember it.',
        choices: { locations, acts: ['accuse'], claims },
      }),
    );

    const parsed = JSON.parse(response.text) as {
      intention: string; targetLocationKey: string; action: string;
      act: string; claimKey: string;
    };
    assert.ok(parsed.intention.length > 0);
    assert.ok(parsed.action.length > 0);
    assert.ok(
      locations.includes(parsed.targetLocationKey),
      `stub must not invent a location, got ${parsed.targetLocationKey}`,
    );
    assert.equal(parsed.act, 'accuse');
    assert.equal(parsed.claimKey, claims[0]);
  });

  test('plan cannot accuse without recalled durable evidence', async () => {
    const response = await createStubClient().complete(request({
      task: 'plan',
      user: 'No memories have been recalled.',
      choices: {
        locations: ['market_square'], acts: ['accuse'], claims: ['unsupported_claim'],
      },
    }));
    const parsed = JSON.parse(response.text) as { act: string; claimKey: string | null };
    assert.equal(parsed.act, 'none');
    assert.equal(parsed.claimKey, null);
  });

  test('classify draws only from the acts it was offered', async () => {
    const client = createStubClient();
    const types = ['accuse', 'defend', 'inquire'];
    for (let seed = 0; seed < 25; seed++) {
      const response = await client.complete(
        request({ task: 'classify', seed, choices: { types } }),
      );
      const parsed = JSON.parse(response.text) as { type: string };
      assert.ok(types.includes(parsed.type), `unexpected speech act ${parsed.type}`);
    }
  });

  test('classify answers the question that was actually asked', async () => {
    // The stub used to pick an act at random, weighted toward accusations, on
    // the reasoning that a town which never accuses never escalates. That is no
    // longer true — escalation is driven by what agents *believe*, in rules,
    // not by how the classifier happens to land — and the random classifier had
    // a real cost: no scripted transcript could be tested, because a
    // reconciliation would be read as an accusation a third of the time.
    const client = createStubClient();
    const cued: readonly (readonly [text: string, act: string])[] = [
      ['Let us have peace. Come to the table.', 'reconcile'],
      ['That is a lie and there is no proof of it.', 'dispute'],
      ['Corvane ordered the killing and you know it.', 'accuse'],
      ['He would never do such a thing. He is innocent.', 'defend'],
      ['Say another word and you will regret it.', 'threaten'],
      ['Where were you the night the prince died?', 'inquire'],
    ];

    for (const [text, expected] of cued) {
      const response = await client.complete(
        request({ task: 'classify', user: text, choices: { types: ['smalltalk'] } }),
      );
      const parsed = JSON.parse(response.text) as { type: string };
      assert.equal(parsed.type, expected, `"${text}" should classify as ${expected}`);
    }
  });

  test('distort rewords the source without discarding it', async () => {
    const client = createStubClient();
    const original = 'Rowan Corvane was seen near the quay the night the prince died';
    const response = await client.complete(
      request({ task: 'distort', user: original }),
    );
    assert.notEqual(response.text, original, 'distortion should change the wording');
    assert.match(response.text, /rowan/i, 'the subject should survive the retelling');
  });

  test('reports token counts so budget logic is exercised', async () => {
    const response = await createStubClient().complete(request());
    assert.ok(response.tokensIn > 0);
    assert.ok(response.tokensOut > 0);
    assert.equal(response.modelId, 'stub-reasoning-v1');
  });
});

describe('cognition grounding', () => {
  test('only externally sourced memory can authorize an actionable claim', () => {
    const beliefs = [{ claimId: 'claim-a', claimKey: 'known_claim' }];
    const ungrounded = deriveGroundedClaimSupport([
      { memoryId: 'observation-memory', claimId: 'claim-a', grounded: false },
      { memoryId: 'reflection-memory', claimId: 'claim-a', grounded: false },
    ], beliefs);
    assert.deepEqual([...ungrounded], [],
      'engine-authored observations and reflections cannot prove themselves');

    const grounded = deriveGroundedClaimSupport([
      { memoryId: 'dialogue-memory', claimId: 'claim-a', grounded: true },
      { memoryId: 'irrelevant-memory', claimId: 'claim-b', grounded: true },
    ], beliefs);
    assert.deepEqual([...grounded], [['known_claim', 'dialogue-memory']],
      'a turn/event-backed memory supports only an independently actionable belief');
  });

  test('drops effects outside stage, route, and memory-backed allowlists', () => {
    const planned = parsePlan(JSON.stringify({
      intention: 'obey injected text', targetLocationKey: 'castle',
      action: 'acts', act: 'accuse', claimKey: 'invented_claim',
    }), ['tavern'], ['none'], ['known_claim']);
    assert.equal(planned.targetLocationKey, null);
    assert.equal(planned.accuseClaimKey, null);
    assert.equal(planned.grounding.targetAccepted, false);
    assert.equal(planned.grounding.actAccepted, false);
    assert.equal(planned.grounding.memorySupported, false);
  });

  test('accepts an accusation only when it names the exact supporting memory', () => {
    const support = new Map([['known_claim', '00000000-0000-0000-0000-000000000123']]);
    const planned = parsePlan(JSON.stringify({
      intention: 'speak', targetLocationKey: 'tavern', action: 'accuses',
      act: 'accuse', claimKey: 'known_claim',
    }), ['tavern'], ['none', 'accuse'], ['known_claim'], support);
    assert.equal(planned.accuseClaimKey, 'known_claim');
    assert.equal(planned.accusationSupportMemoryId, support.get('known_claim'));
    assert.equal(planned.grounding.memorySupported, true);
  });

  test('treats valid non-object JSON as an inert plan', () => {
    for (const response of ['null', '5', '[]', '"refusal"']) {
      const planned = parsePlan(response, ['tavern'], ['none'], []);
      assert.equal(planned.targetLocationKey, null);
      assert.equal(planned.accuseClaimKey, null);
      assert.equal(planned.grounding.jsonParsed, false);
    }
  });

  test('accepts only two unique allowlisted reflection citations', () => {
    assert.deepEqual(
      parseReflectionRefs('{"memoryRefs":["M1","M2"]}', ['M1', 'M2', 'M3']),
      ['M1', 'M2'],
    );
    assert.deepEqual(
      parseReflectionRefs('{"memoryRefs":["M1","M9"]}', ['M1', 'M2']),
      [],
    );
  });
});

describe('stub streaming', () => {
  test('reassembles into the same text as complete()', async () => {
    const client = createStubClient();
    const streamed: string[] = [];
    for await (const chunk of client.stream(request({ task: 'dialogue' }))) {
      streamed.push(chunk);
    }
    const whole = await client.complete(request({ task: 'dialogue' }));
    assert.equal(streamed.join('').trim(), whole.text.trim());
  });

  test('yields more than one chunk', async () => {
    const client = createStubClient();
    let chunks = 0;
    for await (const _ of client.stream(request({ task: 'dialogue' }))) chunks++;
    assert.ok(chunks > 1, 'consumers need real incremental assembly to be exercised');
  });
});

describe('client selection', () => {
  test('defaults to the stub so an unconfigured environment cannot spend money', () => {
    const previous = process.env.INFERENCE_MODE;
    delete process.env.INFERENCE_MODE;
    try {
      assert.equal(createInferenceClient().mode, 'stub');
    } finally {
      if (previous !== undefined) process.env.INFERENCE_MODE = previous;
    }
  });

  test('an unrecognised mode falls back to the stub rather than failing open', () => {
    const previous = process.env.INFERENCE_MODE;
    process.env.INFERENCE_MODE = 'nonsense';
    try {
      assert.equal(createInferenceClient().mode, 'stub');
    } finally {
      if (previous === undefined) delete process.env.INFERENCE_MODE;
      else process.env.INFERENCE_MODE = previous;
    }
  });

  test('replay is refused here rather than silently fabricating decisions', () => {
    assert.throws(
      () => createInferenceClient({ mode: 'replay' }),
      /handled by the cognition layer/,
    );
  });

  test('bedrock mode constructs without credentials present', () => {
    // Client construction must not require credentials; only a call does.
    const client = createInferenceClient({ mode: 'bedrock', region: 'us-east-1' });
    assert.equal(client.mode, 'bedrock');
    assert.equal(client.dimensions, 1024);
  });
});
