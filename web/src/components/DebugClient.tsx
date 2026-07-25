'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EventBus } from '@/game/EventBus';
import type {
  AgentDetail, Bootstrap, ChronicleEntry, DebugTruth, GameSnapshot, SocialGraph, TensionPoint,
} from '@/lib/contracts';
import {
  control, loadAgent, loadChronicle, loadGame, loadGraph, loadTension, loadTruth, movePlayer,
  startSession, streamConversation,
} from '@/lib/clientApi';
import { PhaserGame } from './PhaserGame';
import { Panel } from './Panel';
import { SocialGraphView, TensionChart } from './Charts';

type PanelName = 'overview' | 'chronicle' | 'graph' | 'evidence' | 'hearings' | 'agent' | null;

export function DebugClient() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [panel, setPanel] = useState<PanelName>('overview');
  const [error, setError] = useState<string | null>(null);
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);
  const [graph, setGraph] = useState<SocialGraph | null>(null);
  const [tension, setTension] = useState<TensionPoint[]>([]);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const [utterance, setUtterance] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [truth, setTruth] = useState<DebugTruth | null>(null);
  const [truthWarning, setTruthWarning] = useState(false);
  const moveInFlight = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await loadGame();
      setGame(next);
      setError(null);
      if (!next.player.pendingMove) moveInFlight.current = false;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void startSession().then((created) => {
      setBootstrap(created);
      setGame(created.game);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [bootstrap, refresh]);

  useEffect(() => {
    const offSelect = EventBus.on('select-agent', ({ agentKey }) => {
      setPanel('agent');
      void loadAgent(agentKey).then(setAgent).catch((cause) => setError(String(cause)));
    });
    const offTalk = EventBus.on('talk-agent', ({ agentKey }) => setTalkingTo(agentKey));
    const offMove = EventBus.on('request-move', ({ locationKey }) => {
      if (moveInFlight.current) return;
      moveInFlight.current = true;
      void movePlayer(locationKey, crypto.randomUUID())
        .then(() => refresh())
        .catch((cause) => { moveInFlight.current = false; setError(cause instanceof Error ? cause.message : String(cause)); });
    });
    return () => { offSelect(); offTalk(); offMove(); };
  }, [refresh]);

  useEffect(() => {
    if (panel === 'overview') void loadTension().then(setTension).catch((cause) => setError(String(cause)));
    if (panel === 'chronicle') void loadChronicle().then(setChronicle).catch((cause) => setError(String(cause)));
    if (panel === 'graph') void loadGraph().then(setGraph).catch((cause) => setError(String(cause)));
  }, [panel]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('hollowmere-input-focus', { detail: Boolean(talkingTo) }));
  }, [talkingTo]);

  const talkingAgent = useMemo(() => game?.agents.find((item) => item.agentKey === talkingTo) ?? null, [game, talkingTo]);

  async function sendDialogue(event: React.FormEvent) {
    event.preventDefault();
    if (!talkingTo || !utterance.trim() || sending) return;
    const text = utterance.trim();
    setUtterance('');
    setReply('');
    setSending(true);
    try {
      await streamConversation({ agentKey: talkingTo, text, idempotencyKey: crypto.randomUUID() },
        (token) => setReply((current) => current + token));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function applyControl(body: Record<string, unknown>) {
    try {
      await control(body);
      if (body.action === 'restart') {
        const created = await startSession();
        setBootstrap(created);
        setGame(created.game);
        setTruth(null);
      } else {
        await refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!bootstrap || !game) {
    return <main className="loading-screen"><p className="eyebrow">Hollowmere</p><h1>Opening the town ledger…</h1>{error && <p className="error">{error}</p>}</main>;
  }

  const stageProgress = Math.round(game.world.globalTension / 100);
  return <main className="app-shell">
    <PhaserGame key={bootstrap.session.worldId} bootstrap={bootstrap} game={game} />

    <header className="hud">
      <div className="brand"><span className="eyebrow">Hollowmere</span><strong>Town instrument</strong></div>
      <dl>
        <div><dt>tick</dt><dd>{game.world.currentTick}</dd></div>
        <div><dt>stage</dt><dd>{game.world.stage.replace('_', ' ')}</dd></div>
        <div><dt>tension</dt><dd>{stageProgress}%</dd></div>
        <div><dt>phase</dt><dd>{game.world.phase}</dd></div>
        <div><dt>seed</dt><dd>{game.world.seed}</dd></div>
      </dl>
      <div className="controls">
        <select aria-label="Simulation speed" value={game.world.timeScale} onChange={(event) => void applyControl({
          action: 'timeScale', value: Number(event.target.value), idempotencyKey: crypto.randomUUID(),
        })} disabled={game.world.status !== 'active'}>
          <option value={5000}>0.5×</option><option value={10000}>1×</option><option value={20000}>2×</option>
          <option value={40000}>4×</option><option value={80000}>8×</option>
        </select>
        <button onClick={() => void applyControl({ action: game.world.status === 'paused' ? 'resume' : 'pause' })}>
          {game.world.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button onClick={() => void applyControl({ action: 'restart' })}>New run</button>
      </div>
    </header>

    <nav className="toolrail" aria-label="Debug instruments">
      {([['overview', 'Overview'], ['chronicle', 'Chronicle'], ['graph', 'Graph'], ['evidence', 'Evidence'], ['hearings', 'Hearings']] as const)
        .map(([name, label]) => <button key={name} aria-pressed={panel === name} onClick={() => setPanel(panel === name ? null : name)}>{label}</button>)}
    </nav>

    <div className="help">Gold ring = YOU · blue = Aldreth · orange = Corvane · WASD / arrows move · E speaks</div>
    {game.player.pendingMove && <div className="pending">Movement queued for tick {game.world.currentTick + 1}: {game.player.pendingMove.locationKey}</div>}
    {error && <div className="toast" role="alert">{error}<button onClick={() => setError(null)}>dismiss</button></div>}

    {panel === 'overview' && <Panel title="Simulation overview" onClose={() => setPanel(null)} wide>
      <div className="overview-grid">
        <section><h3>Engine</h3><TensionChart points={tension} /><p className="muted">Global tension by tick · {game.metrics.reduce((sum, item) => sum + item.retryCount, 0)} serialization retries</p></section>
        <section><h3>Factions</h3>{game.factions.map((faction) => <div className="metric-row" key={faction.factionKey}><b>{faction.name}</b><span>{Math.round(faction.tension / 100)}% tension · {faction.willingToNegotiate ? 'will negotiate' : 'refuses'}</span></div>)}</section>
        <section><h3>Claims: belief against truth</h3><div className="table-scroll"><table><thead><tr><th>claim</th><th>truth</th><th>heat</th><th>believers</th><th>reached</th></tr></thead><tbody>{game.claims.map((claim) => <tr key={claim.claimKey}><td title={claim.text}>{claim.claimKey}</td><td className={`truth-${claim.truth}`}>{claim.truth}</td><td>{Math.round(claim.heat / 100)}%</td><td>{claim.believers}</td><td>{claim.reached}</td></tr>)}</tbody></table></div></section>
        <section><h3>Inference</h3><p>{game.world.inferenceCalls} calls · ${(game.world.estCostMicros / 1_000_000).toFixed(4)}</p>{game.cognition.slice(0, 6).map((item) => <div className="metric-row" key={`${item.tick}-${item.agentKey}`}><b>{item.agentKey}</b><span>t{item.tick} · {item.promptVersion} · {item.latencyMs}ms</span></div>)}</section>
      </div>
    </Panel>}

    {panel === 'chronicle' && <Panel title="Chronicle" onClose={() => setPanel(null)}>{chronicle.map((entry) => <article className={`chronicle kind-${entry.kind}`} key={`${entry.tick}-${entry.seq}`}><time>t{entry.tick}</time><div><b>{entry.kind}</b><p>{entry.description}</p><small>{entry.actorKey ?? 'world'} · {entry.locationKey ?? 'town-wide'}</small></div></article>)}</Panel>}
    {panel === 'graph' && <Panel title="Social graph" onClose={() => setPanel(null)} wide>{graph ? <SocialGraphView graph={graph} /> : <p className="empty">Loading relationships…</p>}</Panel>}
    {panel === 'evidence' && <Panel title="Evidence ledger" onClose={() => setPanel(null)}>
      {!game.capabilities.evidence && <p className="notice">The instigator engine tables are not installed in this worktree yet. This panel will activate after integration.</p>}
      <div className="evidence-counts">{(['provenance', 'contradiction', 'record'] as const).map((kind) => <div key={kind}><strong>{game.evidence.filter((item) => item.kind === kind).length}</strong><span>{kind}</span></div>)}</div>
      {game.evidence.map((item) => <div className="evidence-card" key={item.evidenceId}><b>{item.kind}</b><span>found t{item.foundTick}</span><p>{item.accusedKey ?? 'no named suspect'}{item.claimKey ? ` · ${item.claimKey}` : ''}</p></div>)}
      <hr /><button className="warning-button" onClick={() => setTruthWarning(true)}>Reveal Engine Truth</button>
    </Panel>}
    {panel === 'hearings' && <Panel title="Hearings" onClose={() => setPanel(null)}>
      {!game.capabilities.hearings && <p className="notice">Hearing state will appear after the instigator engine commit is integrated.</p>}
      {game.hearings.map((hearing) => <section className="hearing-card" key={hearing.hearingId}><h3>{hearing.locationKey}</h3><p>{hearing.status} · due t{hearing.dueTick} · {Math.max(0, hearing.dueTick - game.world.currentTick)} ticks remaining</p><p>Reveal: {hearing.revealClaimKey ?? 'not queued'}</p>{hearing.commitments.map((commitment) => <div className="metric-row" key={commitment.agentKey}><b>{commitment.agentKey}</b><span>{commitment.response} · {commitment.status}</span></div>)}</section>)}
    </Panel>}
    {panel === 'agent' && <Panel title={agent?.agent.name ?? 'Agent inspector'} onClose={() => setPanel(null)}>
      {!agent ? <p className="empty">Choose an NPC on the map.</p> : <><p>{agent.summary}</p><p className="tags">{agent.traits.join(' · ')}</p><dl className="detail-list"><div><dt>faction</dt><dd>{agent.agent.factionKey}</dd></div><div><dt>location</dt><dd>{agent.agent.locationKey}</dd></div><div><dt>status</dt><dd>{agent.agent.status}</dd></div><div><dt>action</dt><dd>{agent.agent.currentAction ?? 'routine'}</dd></div></dl><h3>Strongest beliefs</h3>{agent.beliefs.map((belief) => <div className="metric-row" key={belief.claimKey}><b>{belief.claimKey}</b><span>{Math.round(belief.confidence / 100)}% · t{belief.updatedTick}</span></div>)}<h3>Relationships</h3>{agent.relationships.map((relationship) => <div className="metric-row" key={relationship.agentKey}><b>{relationship.agentKey}</b><span>sentiment {Math.round(relationship.sentiment / 100)} · trust {Math.round(relationship.trust / 100)}</span></div>)}</>}
    </Panel>}

    {talkingTo && <section className="dialogue" aria-label={`Conversation with ${talkingAgent?.name ?? talkingTo}`}>
      <header><div><span className="eyebrow">Conversation</span><h2>{talkingAgent?.name ?? talkingTo}</h2></div><button onClick={() => setTalkingTo(null)} aria-label="Close conversation">×</button></header>
      <p className="muted">{talkingAgent?.factionKey} · {talkingAgent?.locationKey}</p>
      <div className="reply">{reply || (sending ? 'Listening…' : 'Ask about a source, dispute a claim, reconcile the Houses, or summon them to a hearing.')}</div>
      <form onSubmit={sendDialogue}><textarea value={utterance} onChange={(event) => setUtterance(event.target.value)} maxLength={2000} autoFocus placeholder="Speak to them…" /><button disabled={sending || !utterance.trim()}>{sending ? 'Speaking…' : 'Send'}</button></form>
    </section>}

    {truthWarning && !truth && <div className="modal-backdrop"><section className="modal"><span className="eyebrow">Spoiler boundary</span><h2>Reveal Engine Truth?</h2><p>This exposes the culprit, live scheme, and whether each clue is genuine or a misdirection. It only reads your current private world.</p><div className="modal-actions"><button onClick={() => setTruthWarning(false)}>Cancel</button><button className="danger" onClick={() => void loadTruth().then((value) => { setTruth(value); setTruthWarning(false); }).catch((cause) => setError(String(cause)))}>Reveal</button></div></section></div>}
    {truth && <section className="truth-drawer"><header><div><span className="eyebrow">Engine Truth</span><h2>{truth.culprit?.agentKey ?? 'No instigator data'}</h2></div><button onClick={() => setTruth(null)}>×</button></header>{truth.available ? <><p>Motive: {truth.culprit?.motiveKey ?? '—'} · exposed t{truth.culprit?.exposedTick ?? '—'}</p><p>Posture: {truth.scheme?.posture ?? '—'} · tactic: {truth.scheme?.currentTactic ?? '—'} · next strategy t{truth.scheme?.nextStrategyTick ?? '—'}</p>{truth.evidence.map((item) => <div className="metric-row" key={item.evidenceId}><b>{item.kind} · {item.accusedKey ?? 'unknown'}</b><span>{item.genuine ? 'genuine' : 'misdirection'}</span></div>)}</> : <p>The instigator implementation is not present in this worktree yet.</p>}</section>}

    {game.world.ending && <div className="ending"><span className="eyebrow">World ended</span><h1>{game.world.ending}</h1><p>The ledger remains open for inspection.</p><button onClick={() => void applyControl({ action: 'restart' })}>Start another town</button></div>}
  </main>;
}
