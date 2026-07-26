import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, query, withClient } from './db.ts';
import {
  NPC_DIALOGUE_SYSTEM, parseDialogueTurns, SPEECH_PROMPT_VERSION, thinkDialogue,
} from './dialogue.ts';
import { createStubClient, type CompletionRequest } from './inference/index.ts';
import { createRng } from './rng.ts';
import { runTick } from './runtick.ts';
import { instantiateWorld } from '../scenario/instantiate.ts';
import { loadScenarioFile, publishScenario } from '../scenario/publish.ts';

const here = dirname(fileURLToPath(import.meta.url));
const HAS_DB = Boolean(process.env.DATABASE_URL);

describe('NPC dialogue output parsing', () => {
  test('accepts two to four alternating turns beginning with the sender', () => {
    const turns = [
      { speaker: 'sender', text: 'First.' },
      { speaker: 'listener', text: 'Second.' },
      { speaker: 'sender', text: 'Third.' },
      { speaker: 'listener', text: 'Fourth.' },
    ];
    assert.deepEqual(parseDialogueTurns(JSON.stringify({ turns })), turns);
    assert.deepEqual(parseDialogueTurns(JSON.stringify({ turns: turns.slice(0, 3) })), turns.slice(0, 3));
    assert.deepEqual(parseDialogueTurns(JSON.stringify({ turns: turns.slice(0, 2) })), turns.slice(0, 2));
  });

  test('rejects malformed, incorrectly ordered, and out-of-range exchanges', () => {
    const valid = [
      { speaker: 'sender', text: 'First.' },
      { speaker: 'listener', text: 'Second.' },
    ];
    const invalid = [
      'not json',
      JSON.stringify({ turns: valid.slice(0, 1) }),
      JSON.stringify({ turns: [...valid, ...valid, { speaker: 'sender', text: 'Fifth.' }] }),
      JSON.stringify({ turns: [{ speaker: 'listener', text: 'Wrong.' }, valid[1]] }),
      JSON.stringify({ turns: [valid[0], { speaker: 'sender', text: 'Wrong.' }] }),
      JSON.stringify({ turns: [valid[0], null] }),
      JSON.stringify({ turns: [valid[0], { speaker: 'listener', text: 42 }] }),
      JSON.stringify({ turns: [valid[0], { speaker: 'listener', text: 'x'.repeat(801) }] }),
    ];
    for (const text of invalid) assert.equal(parseDialogueTurns(text), null);
  });
});

describe('NPC dialogue', { skip: !HAS_DB && 'DATABASE_URL not set' }, () => {
  let scenarioVersionId: string;

  before(async () => {
    scenarioVersionId = (await publishScenario(
      await loadScenarioFile(join(here, '..', 'scenario', 'hollowmere-v2.json')),
    )).scenarioVersionId;
  });
  after(closePool);

  test('sends grounded context for both NPCs without exposing the hidden tactic', async () => {
    const world = await instantiateWorld({
      scenarioVersionId,
      seed: 1_307,
      sessionId: `npc-dialogue-${Date.now()}`,
    });
    const stub = createStubClient();
    let captured: CompletionRequest | null = null;
    const inference = {
      ...stub,
      async complete(request: CompletionRequest) {
        const response = await stub.complete(request);
        if (request.task !== 'npc_conversation') return response;
        captured = request;
        return {
          ...response,
          text: JSON.stringify({
            turns: [
              { speaker: 'sender', text: 'The selected claim deserves an answer.' },
              { speaker: 'listener', text: 'I am not certain I believe you.' },
              { speaker: 'sender', text: 'Then remember that doubts remain.' },
              { speaker: 'listener', text: 'I will judge it against what I know.' },
            ],
          }),
        };
      },
    };

    for (let tick = 1; tick <= 11; tick++) {
      await runTick({ worldId: world.worldId, inference, tick, allowDistortion: false });
    }
    const scheme = await query<{
      agent_id: string; target_agent_id: string; current_tactic: string;
    }>(
      `SELECT agent_id, target_agent_id, current_tactic FROM world_scheme_state
        WHERE world_id = $1 AND current_tactic IS NOT NULL`, [world.worldId],
    );
    assert.ok(scheme[0]?.target_agent_id, 'the instigator should have an active tactic by tick 12');
    await query(
      `UPDATE world_agents target
          SET location_id = culprit.location_id
         FROM world_agents culprit
        WHERE target.world_id = $1 AND target.agent_id = $2
          AND culprit.world_id = target.world_id AND culprit.agent_id = $3`,
      [world.worldId, scheme[0]!.target_agent_id, scheme[0]!.agent_id],
    );
    await runTick({ worldId: world.worldId, inference, tick: 12, allowDistortion: false });

    assert.ok(captured, 'the dialogue interval should produce one NPC exchange');
    const request = captured as CompletionRequest;
    assert.equal(request.promptVersion, SPEECH_PROMPT_VERSION);
    assert.equal(request.system, NPC_DIALOGUE_SYSTEM);
    const prompt = JSON.parse(request.user) as {
      scene: unknown;
      sender: { subjectiveBeliefs: { claim: string }[] };
      listener: unknown;
      relationship: unknown;
      selectedTopic: { claim: string; senderStance: { stance: string; confidence: number } };
      publicDeliveryGoal: string;
    };
    assert.ok(prompt.scene);
    assert.ok(prompt.sender);
    assert.ok(prompt.listener);
    assert.ok(prompt.relationship);
    assert.ok(prompt.selectedTopic);
    assert.deepEqual(prompt.selectedTopic.senderStance, { stance: 'undisclosed', confidence: 0 });
    assert.ok(!prompt.sender.subjectiveBeliefs.some(
      (belief) => belief.claim === prompt.selectedTopic.claim,
    ));
    assert.equal(typeof prompt.publicDeliveryGoal, 'string');
    assert.notEqual(prompt.publicDeliveryGoal,
      'Share the selected topic naturally; the listener may agree, doubt, or question it.');
    assert.doesNotMatch(request.user, /"tactic"|blame_shift|corroborate_false|poison_the_well|feign_moderation|redirect_suspicion|recruit_amplifier/);

    const events = await query<{
      actor_agent_id: string; description: string; dialogue_turn: number; claim_key: string | null;
    }>(
      `SELECT actor_agent_id, description, (payload->>'dialogueTurn')::INT8 AS dialogue_turn,
              payload->>'claimKey' AS claim_key
         FROM world_events
        WHERE world_id = $1 AND tick = 12 AND kind = 'dialogue'
        ORDER BY seq`,
      [world.worldId],
    );
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => event.dialogue_turn), [1, 2, 3, 4]);
    assert.equal(events[0]!.actor_agent_id, events[2]!.actor_agent_id);
    assert.equal(events[1]!.actor_agent_id, events[3]!.actor_agent_id);
    assert.notEqual(events[0]!.actor_agent_id, events[1]!.actor_agent_id);
    assert.ok(events[0]!.claim_key);
    assert.deepEqual(events.slice(1).map((event) => event.claim_key), [null, null, null]);
    const memories = await query<{
      agent_id: string; content: string; importance: number; sources: number;
    }>(
      `SELECT memory.agent_id, memory.content, memory.importance,
              count(source.edge_id)::INT8 AS sources
         FROM world_memories memory
         LEFT JOIN memory_source_edges source
           ON source.world_id = memory.world_id AND source.memory_id = memory.memory_id
        WHERE memory.world_id = $1 AND memory.tick = 12 AND memory.kind = 'dialogue'
        GROUP BY memory.agent_id, memory.content, memory.importance
        ORDER BY memory.agent_id`,
      [world.worldId],
    );
    assert.equal(memories.length, 2, 'both participants form a durable exchange memory');
    assert.ok(memories.every((memory) => memory.sources === 1));
    assert.ok(memories.every((memory) => memory.importance > 0));
    assert.ok(memories.every((memory) => memory.content.includes(prompt.selectedTopic.claim)));
    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });

  test('masks every historically planted scheme claim, including ambient retellings', async () => {
    const world = await instantiateWorld({
      scenarioVersionId,
      seed: 1_308,
      sessionId: `npc-dialogue-history-${Date.now()}`,
    });
    const agents = await query<{
      culprit_id: string; culprit_location_id: string; listener_id: string; remote_location_id: string;
    }>(
      `SELECT culprit.agent_id AS culprit_id, culprit.location_id AS culprit_location_id,
              listener.agent_id AS listener_id, remote.location_id AS remote_location_id
         FROM world_culprit marker
         JOIN world_agents culprit
           ON culprit.world_id = marker.world_id AND culprit.agent_id = marker.agent_id
         JOIN world_agents listener
           ON listener.world_id = culprit.world_id AND listener.agent_id != culprit.agent_id
         JOIN world_locations remote
           ON remote.world_id = culprit.world_id AND remote.location_id != culprit.location_id
        WHERE marker.world_id = $1
        ORDER BY listener.agent_key, remote.location_key LIMIT 1`,
      [world.worldId],
    );
    const claims = await query<{ rumor_id: string; claim_id: string; text: string }>(
      `SELECT rumor.rumor_id, claim.claim_id, claim.text
         FROM world_rumors rumor
         JOIN world_claims claim
           ON claim.world_id = rumor.world_id AND claim.claim_id = rumor.claim_id
        WHERE rumor.world_id = $1 AND NOT claim.locked
        ORDER BY claim.claim_key LIMIT 2`,
      [world.worldId],
    );
    assert.equal(claims.length, 2);
    const actor = agents[0]!;
    const historical = claims[0]!;
    const current = claims[1]!;
    await query(
      `UPDATE world_agents SET location_id = $2
        WHERE world_id = $1 AND agent_id != $3`,
      [world.worldId, actor.remote_location_id, actor.culprit_id],
    );
    await query(
      `UPDATE world_agents SET location_id = $3
        WHERE world_id = $1 AND agent_id = $2`,
      [world.worldId, actor.listener_id, actor.culprit_location_id],
    );
    await query(
      `UPDATE world_scheme_state
          SET claim_id = $2, current_tactic = NULL, executes_until = 0
        WHERE world_id = $1`,
      [world.worldId, current.claim_id],
    );
    await query(
      `INSERT INTO cognition_records
         (world_id, tick, agent_id, task, input_hash, decision, model_id, prompt_version)
       VALUES
         ($1, 1, $2, 'strategy', 'historical-scheme-claim', $3,
          'deterministic-fallback', 'strategy-v2'),
         ($1, 20, $2, 'strategy', 'future-scheme-claim', $4,
          'deterministic-fallback', 'strategy-v2')`,
      [world.worldId, actor.culprit_id,
        JSON.stringify({ claimId: historical.claim_id }),
        JSON.stringify({ claimId: current.claim_id })],
    );
    await query(
      `INSERT INTO agent_beliefs (world_id, agent_id, claim_id, confidence, updated_tick)
       VALUES ($1, $2, $3, -7200, 1), ($1, $2, $4, 3500, 1)
       ON CONFLICT (world_id, agent_id, claim_id)
       DO UPDATE SET confidence = excluded.confidence, updated_tick = excluded.updated_tick`,
      [world.worldId, actor.culprit_id, historical.claim_id, current.claim_id],
    );
    await query(`DELETE FROM world_rumor_spread WHERE world_id = $1`, [world.worldId]);
    await query(
      `UPDATE world_rumors SET heat = 10000, updated_tick = 1
        WHERE world_id = $1 AND rumor_id = $2`,
      [world.worldId, historical.rumor_id],
    );
    await query(
      `INSERT INTO world_rumor_spread
         (world_id, rumor_id, agent_id, received_tick, distorted_text)
       VALUES ($1, $2, $3, 1, $4)`,
      [world.worldId, historical.rumor_id, actor.culprit_id, historical.text],
    );

    const stub = createStubClient();
    let captured: CompletionRequest | null = null;
    const inference = {
      ...stub,
      async complete(request: CompletionRequest) {
        if (request.task === 'npc_conversation') captured = request;
        return stub.complete(request);
      },
    };
    const decision = await withClient((client) => thinkDialogue(client, {
      worldId: world.worldId,
      tick: 6,
      rng: createRng(44),
      inference,
    }));
    assert.equal(decision?.fromAgentId, actor.culprit_id);
    assert.ok(captured);
    const prompt = JSON.parse((captured as CompletionRequest).user) as {
      sender: { subjectiveBeliefs: { claim: string }[] };
      selectedTopic: { claim: string; senderStance: { stance: string; confidence: number } };
    };
    assert.equal(prompt.selectedTopic.claim, historical.text);
    assert.deepEqual(prompt.selectedTopic.senderStance, { stance: 'undisclosed', confidence: 0 });
    assert.ok(!prompt.sender.subjectiveBeliefs.some((belief) => belief.claim === historical.text));
    assert.ok(prompt.sender.subjectiveBeliefs.some((belief) => belief.claim === current.text),
      'a future strategy record must not mask an earlier prompt');

    await query(`DELETE FROM world_rumor_spread WHERE world_id = $1`, [world.worldId]);
    await query(
      `INSERT INTO world_rumor_spread
         (world_id, rumor_id, agent_id, received_tick, distorted_text)
       VALUES ($1, $2, $3, 1, $4)`,
      [world.worldId, historical.rumor_id, actor.listener_id, historical.text],
    );
    captured = null;
    const listenerDecision = await withClient((client) => thinkDialogue(client, {
      worldId: world.worldId,
      tick: 12,
      rng: createRng(45),
      inference,
    }));
    assert.equal(listenerDecision?.toAgentId, actor.culprit_id);
    assert.ok(captured);
    const listenerPrompt = JSON.parse((captured as CompletionRequest).user) as {
      listener: { subjectiveBeliefs: { claim: string }[] };
      selectedTopic: { listenerStance: { stance: string; confidence: number } };
    };
    assert.deepEqual(listenerPrompt.selectedTopic.listenerStance,
      { stance: 'undisclosed', confidence: 0 });
    assert.ok(!listenerPrompt.listener.subjectiveBeliefs.some(
      (belief) => belief.claim === historical.text,
    ));
    await query(`DELETE FROM worlds WHERE world_id = $1`, [world.worldId]);
  });
});
