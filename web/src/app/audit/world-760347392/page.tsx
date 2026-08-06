import worldAudit from '@/data/world-760347392.json';

import styles from './page.module.css';

type Effect = {
  tensionDelta?: number; reputationDelta?: number; sentimentDelta?: number;
  beliefBefore?: number | null; beliefAfter?: number | null; rumorSeeded?: boolean;
  evidenceRecorded?: boolean; negotiationOpened?: boolean; hearingId?: string | null;
};
type Turn = {
  opened_tick: string; closed_tick: string; agent_key: string; name: string; ordinal: string;
  player_text: string; reply: string; speech_act: string; status: string; model_id: string;
  prompt_version: string; tokens_in: string; tokens_out: string; latency_ms: string;
  structured_outcome: { recalledMemories?: unknown[]; referencedClaimKeys?: string[] };
  effects: Effect | null;
};
type Audit = {
  generatedAt: string;
  world: {
    seed: string; status: string; current_tick: string; created_at: string; last_activity_at: string;
    inference_profile: string; active_runtime_ms: string; day: string; phase: string;
    escalation_stage: string; global_tension: string; inference_calls: string;
    tokens_in: string; tokens_out: string; est_cost_micros: string;
  };
  conversations: Turn[];
  inference: { task: string; model_id: string; prompt_version: string; calls: string; tokens_in: string; tokens_out: string; avg_latency_ms: number; min_latency_ms: string; max_latency_ms: string }[];
  ticks: { duration_ms: string; retry_count: string }[];
  stateHistory: { tick: string; global_tension: string; escalation_stage: string }[];
  events: { tick: string; kind: string; description: string; actor_key: string | null }[];
  agents: { agent_key: string; name: string; status: string; faction_key: string; location_key: string; current_action: string | null; updated_tick: string }[];
  beliefs: { claim_key: string; text: string; believers: string; disbelievers: string; strongest_confidence: string }[];
  memories: { kind: string; count: string; avg_importance: number }[];
  memoryAccess: { accesses: string; accessed_memories: string };
  relationshipUpdates: { tick: string; agent_key: string; trust_delta: string; affinity_delta: string; fear_delta: string; respect_delta: string; impression: string }[];
  usage: { category: string; model_id: string; calls: string; tokens_in: string; tokens_out: string; est_cost_micros: string }[];
  rumors: { claim_key: string; heat: string; created_tick: string; updated_tick: string; reached_agents: string; tellings: string }[];
};

const report = worldAudit as unknown as Audit;
const number = (value: string | number | null | undefined) => Number(value ?? 0);
const fixed = (value: string | number) => `${(number(value) / 100).toFixed(1)}%`;
const ms = (value: string | number) => `${Math.round(number(value)).toLocaleString()} ms`;
const effectIntent: Record<string, string> = {
  accuse: 'Seed a named accusation and raise public pressure.',
  corroborate: 'Strengthen this NPC’s belief in the referenced claim.',
  defend: 'Reduce this NPC’s belief in the referenced claim and warm the relationship around its subject.',
  inquire: 'Ask for a lead; the engine may record authorized evidence or provenance.',
  reconcile: 'Lower tension and improve standing with this NPC’s faction.',
  summon: 'Seek a formal hearing response.',
  inform: 'Share information without a direct belief or tension change.',
  smalltalk: 'Build a small amount of goodwill without changing the case.',
  dispute: 'Reduce this NPC’s belief in the referenced claim.',
  threaten: 'Increase pressure at a social cost.',
};

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function actualEffect(effect: Effect | null): string {
  if (!effect) return 'No durable effect record was found.';
  const parts: string[] = [];
  if (effect.rumorSeeded) parts.push('seeded a rumor');
  if (effect.tensionDelta) parts.push(`${effect.tensionDelta > 0 ? '+' : ''}${effect.tensionDelta} tension`);
  if (effect.reputationDelta) parts.push(`${effect.reputationDelta > 0 ? '+' : ''}${effect.reputationDelta} faction reputation`);
  if (effect.sentimentDelta) parts.push(`${effect.sentimentDelta > 0 ? '+' : ''}${effect.sentimentDelta} NPC-to-subject sentiment`);
  if (effect.beliefAfter !== null && effect.beliefAfter !== undefined) {
    parts.push(`belief ${effect.beliefBefore ?? 0} → ${effect.beliefAfter}`);
  }
  if (effect.evidenceRecorded) parts.push('recorded evidence/provenance');
  if (effect.negotiationOpened) parts.push('opened negotiation willingness');
  if (effect.hearingId) parts.push('created a hearing');
  return parts.length ? parts.join(' · ') : 'No case, rumor, tension, or relationship effect.';
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <article className={styles.metric}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>;
}

export default function WorldAuditPage() {
  const turns = report.conversations;
  const tickLatencies = report.ticks.map((tick) => number(tick.duration_ms));
  const turnLatency = turns.map((turn) => number(turn.latency_ms));
  const conversations = new Map<string, Turn[]>();
  for (const turn of turns) {
    const key = `${turn.opened_tick}:${turn.agent_key}`;
    conversations.set(key, [...(conversations.get(key) ?? []), turn]);
  }
  const byKind = report.events.reduce<Record<string, number>>((result, event) => {
    result[event.kind] = (result[event.kind] ?? 0) + 1;
    return result;
  }, {});
  const stageChanges = report.stateHistory.filter((item, index, all) => index === 0 || item.escalation_stage !== all[index - 1]?.escalation_stage);
  const maxTension = Math.max(...report.stateHistory.map((item) => number(item.global_tension)), 1);
  const totalConversationTokens = turns.reduce((total, turn) => total + number(turn.tokens_in) + number(turn.tokens_out), 0);

  return <main className={styles.page}>
    <header className={styles.hero}>
      <p>Production world audit · static, read-only snapshot</p>
      <h1>World {report.world.seed}</h1>
      <div className={styles.status}><span>{report.world.status}</span> at tick {report.world.current_tick} · {report.world.escalation_stage} · day {report.world.day}, {report.world.phase}</div>
      <small>Captured {new Date(report.generatedAt).toLocaleString()} from durable production records. No prompts, embeddings, secrets, or world writes are included.</small>
    </header>

    <section className={styles.metrics} aria-label="World summary">
      <Metric label="Inference calls" value={number(report.world.inference_calls).toLocaleString()} note={`${number(report.world.tokens_in).toLocaleString()} in · ${number(report.world.tokens_out).toLocaleString()} out`} />
      <Metric label="Estimated inference cost" value={`$${(number(report.world.est_cost_micros) / 1_000_000).toFixed(4)}`} note="recorded estimate" />
      <Metric label="Player conversations" value={`${conversations.size} / ${turns.length} turns`} note={`${turns.filter((turn) => turn.status === 'fallback').length} fallbacks`} />
      <Metric label="Town tension" value={fixed(report.world.global_tension)} note={`${stageChanges.length - 1} stage changes`} />
      <Metric label="Tick p95" value={ms(percentile(tickLatencies, .95))} note={`median ${ms(percentile(tickLatencies, .5))}`} />
      <Metric label="Conversation p95" value={ms(percentile(turnLatency, .95))} note={`${totalConversationTokens.toLocaleString()} conversation tokens`} />
    </section>

    <section className={styles.section}>
      <div className={styles.heading}><p>Run progression</p><h2>The accusation campaign outpaced the evidence trail</h2></div>
      <div className={styles.timeline}>
        {stageChanges.map((item) => <div key={item.tick}><b>t{item.tick}</b><span className={styles.stage}>{item.escalation_stage}</span><small>{fixed(item.global_tension)} tension</small></div>)}
      </div>
      <div className={styles.tensionChart} aria-label="Tension by tick">
        {report.stateHistory.map((item) => <i key={item.tick} title={`t${item.tick}: ${fixed(item.global_tension)}`} style={{ height: `${Math.max(2, number(item.global_tension) / maxTension * 100)}%` }} />)}
      </div>
      <p className={styles.caption}>{Object.entries(byKind).map(([kind, count]) => `${count} ${kind}`).join(' · ')}. The run entered suspicion at t24 and accusations at t48; it remains below the trials threshold.</p>
    </section>

    <section className={styles.section}>
      <div className={styles.heading}><p>Conversations</p><h2>Every player turn, its intended engine action, and its durable result</h2></div>
      <p className={styles.caption}>NPC wording is model-generated; the engine, not the model, decides the listed durable effects. The most repeated pattern was a player accusation of Sella based on the arms landing, followed by NPCs asking for independent proof of murder.</p>
      <div className={styles.conversations}>
        {[...conversations.entries()].map(([key, group]) => {
          const first = group[0]!;
          const totalLatency = group.reduce((total, turn) => total + number(turn.latency_ms), 0);
          return <details key={key} className={styles.conversation}>
            <summary><span>t{first.opened_tick}</span><strong>{first.name}</strong><small>{group.length} turns · {ms(totalLatency / group.length)} avg</small></summary>
            {group.map((turn) => <article className={styles.turn} key={`${turn.agent_key}-${turn.opened_tick}-${turn.ordinal}`}>
              <div className={styles.turnMeta}>Turn {number(turn.ordinal) + 1} · {turn.speech_act} · {turn.model_id} · {ms(turn.latency_ms)}</div>
              <p><b>You</b>{turn.player_text}</p>
              <p><b>{turn.name}</b>{turn.reply}</p>
              <dl><div><dt>Intended effect</dt><dd>{effectIntent[turn.speech_act] ?? 'No engine mapping recorded.'}</dd></div><div><dt>Actual effect</dt><dd>{actualEffect(turn.effects)}</dd></div></dl>
              <small>Claims: {turn.structured_outcome.referencedClaimKeys?.join(', ') || 'none'} · recalled memories: {turn.structured_outcome.recalledMemories?.length ?? 0} · {number(turn.tokens_in).toLocaleString()} in / {number(turn.tokens_out).toLocaleString()} out</small>
            </article>)}
          </details>;
        })}
      </div>
    </section>

    <section className={styles.twoColumn}>
      <div className={styles.section}>
        <div className={styles.heading}><p>Inference</p><h2>Model work and latency</h2></div>
        <div className={styles.tableWrap}><table><thead><tr><th>Task</th><th>Calls</th><th>Tokens</th><th>Avg / max</th></tr></thead><tbody>{report.inference.map((item) => <tr key={`${item.task}-${item.model_id}`}><td><b>{item.task}</b><small>{item.model_id} · {item.prompt_version}</small></td><td>{item.calls}</td><td>{number(item.tokens_in).toLocaleString()} / {number(item.tokens_out).toLocaleString()}</td><td>{ms(item.avg_latency_ms)} / {ms(item.max_latency_ms)}</td></tr>)}</tbody></table></div>
        <p className={styles.caption}>Recorded usage includes planning, NPC dialogue, player turns, and embeddings. The conversation table shows the 45 player-turn completions; the cognition table separately captures 42 model-recorded NPC tasks.</p>
      </div>
      <div className={styles.section}>
        <div className={styles.heading}><p>Performance</p><h2>Scheduler health</h2></div>
        <div className={styles.metricsCompact}><Metric label="Committed ticks" value={String(report.ticks.length)} /><Metric label="Tick average" value={ms(tickLatencies.reduce((a, b) => a + b, 0) / tickLatencies.length)} /><Metric label="Tick maximum" value={ms(Math.max(...tickLatencies))} /><Metric label="Serializable retries" value={String(report.ticks.reduce((total, tick) => total + number(tick.retry_count), 0))} /></div>
        <p className={styles.caption}>The 23.5s worst tick is a long tail, not a transaction-retry failure: all 72 committed ticks recorded zero serializable retries.</p>
      </div>
    </section>

    <section className={styles.twoColumn}>
      <div className={styles.section}>
        <div className={styles.heading}><p>Beliefs & rumors</p><h2>What the town currently believes</h2></div>
        <div className={styles.claims}>{report.beliefs.map((belief) => <article key={belief.claim_key}><b>{belief.claim_key}</b><p>{belief.text}</p><span>{belief.believers} believe · {belief.disbelievers} deny · strongest {fixed(belief.strongest_confidence)}</span></article>)}</div>
        <p className={styles.caption}>The arms-landing claim reached all 29 living NPCs. It is widely believed, but it is not the same as proof of Sella’s role in the murder.</p>
      </div>
      <div className={styles.section}>
        <div className={styles.heading}><p>Memory</p><h2>Retrieval-backed context</h2></div>
        <div className={styles.memory}>{report.memories.map((memory) => <span key={memory.kind}><b>{memory.count}</b>{memory.kind}</span>)}</div>
        <p className={styles.caption}>{report.memoryAccess.accesses} recorded retrieval accesses across {report.memoryAccess.accessed_memories} memories. The conversation entries expose only counts and candidate-path evidence, not vector data.</p>
        <div className={styles.heading}><p>Current agents</p><h2>Active behaviors when paused</h2></div>
        <div className={styles.agents}>{report.agents.filter((agent) => agent.current_action).map((agent) => <article key={agent.agent_key}><b>{agent.name}</b><small>{agent.faction_key} · {agent.location_key} · updated t{agent.updated_tick}</small><p>{agent.current_action}</p></article>)}</div>
      </div>
    </section>
  </main>;
}
