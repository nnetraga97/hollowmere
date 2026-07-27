'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, FileSearch, Heart, Map, Network, Pause, Play, RotateCcw, Scale, UserRound } from 'lucide-react';

import { EventBus } from '@/game/EventBus';
import { atlasPosition, portraitPath, relationshipLevel } from '@/game/locationScenes';
import type {
  AgentDetail, Bootstrap, ChronicleEntry, Conversation, DebugTruth, GameSnapshot,
  RomanceChoiceResult, SocialGraph,
} from '@/lib/contracts';
import {
  chooseRomance, closeConversation, control, loadAgent, loadChronicle, loadGame, loadGraph, loadTruth, movePlayer,
  startConversation, startSession, streamConversationTurn, type PlayerEntry,
} from '@/lib/clientApi';
import { PhaserGame } from './PhaserGame';
import { LocationScene } from './LocationScene';
import { Panel } from './Panel';
import { SocialGraphView } from './Charts';
import { LandingScreen } from './LandingScreen';

type PanelName = 'overview' | 'chronicle' | 'graph' | 'evidence' | 'hearings' | 'profile' | 'agent' | null;

export function DebugClient() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [panel, setPanel] = useState<PanelName>('overview');
  const [error, setError] = useState<string | null>(null);
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);
  const [graph, setGraph] = useState<SocialGraph | null>(null);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [utterance, setUtterance] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [truth, setTruth] = useState<DebugTruth | null>(null);
  const [truthWarning, setTruthWarning] = useState(false);
  const [entering, setEntering] = useState(false);
  const [sceneLocationKey, setSceneLocationKey] = useState<string | null>(null);
  const [journey, setJourney] = useState<{ from: string; to: string } | null>(null);
  const [bondChange, setBondChange] = useState<{
    agentKey: string; trust: number; affinity: number; fear: number; respect: number;
  } | null>(null);
  const moveInFlight = useRef(false);
  const lastLocation = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await loadGame();
      setGame(next);
      setConversation(next.conversation);
      setTalkingTo(next.conversation?.agentKey ?? null);
      setError(null);
      if (!next.player.pendingMove) moveInFlight.current = false;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  async function enterTown(entry: PlayerEntry) {
    setEntering(true);
    setError(null);
    try {
      const created = await startSession(entry);
      setBootstrap(created);
      setGame(created.game);
      setConversation(created.game.conversation);
      setTalkingTo(created.game.conversation?.agentKey ?? null);
      if (created.game.conversation) inspectAgent(created.game.conversation.agentKey);
      setSceneLocationKey(null);
      setJourney(null);
      lastLocation.current = created.game.player.locationKey;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEntering(false);
    }
  }

  useEffect(() => {
    if (!bootstrap) return;
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(timer);
  }, [bootstrap, refresh]);

  const inspectAgent = useCallback((agentKey: string, openPanel = false) => {
    if (openPanel) setPanel('agent');
    void loadAgent(agentKey).then(setAgent).catch((cause) => setError(String(cause)));
  }, []);

  const queueMove = useCallback(async (locationKey: string) => {
    if (!game || !bootstrap || moveInFlight.current) return;
    if (locationKey === game.player.locationKey) {
      setSceneLocationKey(locationKey);
      setPanel(null);
      return;
    }
    moveInFlight.current = true;
    setSceneLocationKey(null);
    setPanel(null);
    setJourney({ from: game.player.locationKey, to: locationKey });
    try {
      await movePlayer(locationKey, crypto.randomUUID());
      await refresh();
    } catch (cause) {
      moveInFlight.current = false;
      setJourney(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bootstrap, game, refresh]);

  useEffect(() => {
    const offSelect = EventBus.on('select-agent', ({ agentKey }) => {
      inspectAgent(agentKey, true);
    });
    const offTalk = EventBus.on('talk-agent', ({ agentKey }) => {
      inspectAgent(agentKey, true);
    });
    const offMove = EventBus.on('request-move', ({ locationKey }) => {
      void queueMove(locationKey);
    });
    const offEnter = EventBus.on('enter-location', ({ locationKey }) => {
      setSceneLocationKey(locationKey);
      setPanel(null);
    });
    return () => { offSelect(); offTalk(); offMove(); offEnter(); };
  }, [inspectAgent, queueMove]);

  useEffect(() => {
    if (!game) return;
    if (lastLocation.current && lastLocation.current !== game.player.locationKey) {
      setJourney(null);
      setSceneLocationKey(game.player.locationKey);
      setPanel(null);
      setAgent(null);
    }
    lastLocation.current = game.player.locationKey;
  }, [game]);

  useEffect(() => {
    if (panel === 'chronicle') void loadChronicle().then(setChronicle).catch((cause) => setError(String(cause)));
    if (panel === 'graph') void loadGraph().then(setGraph).catch((cause) => setError(String(cause)));
  }, [panel]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('hollowmere-input-focus', {
      detail: Boolean(talkingTo) || Boolean(sceneLocationKey),
    }));
  }, [sceneLocationKey, talkingTo]);

  const talkingAgent = useMemo(() => game?.agents.find((item) => item.agentKey === talkingTo) ?? null, [game, talkingTo]);
  const talkingDetail = agent?.agent.agentKey === talkingTo ? agent : null;
  const talkingBond = relationshipLevel(talkingDetail?.playerRelationship);

  async function beginConversation(agentKey: string) {
    if (sending || game?.player.pendingMove) return;
    setSending(true);
    try {
      const value = await startConversation(agentKey);
      setConversation(value);
      setTalkingTo(value.agentKey);
      setReply('');
      setBondChange(null);
      setPanel(null);
      inspectAgent(agentKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function sendDialogue(event: React.FormEvent) {
    event.preventDefault();
    if (!talkingTo || !conversation || !utterance.trim() || sending) return;
    const text = utterance.trim();
    setUtterance('');
    setReply('');
    setSending(true);
    try {
      await streamConversationTurn({ conversationId: conversation!.conversationId, text, idempotencyKey: crypto.randomUUID() },
        (token) => setReply((current) => current + token));
      await refresh();
      const updated = await loadAgent(talkingTo);
      setAgent(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function leaveConversation() {
    if (!conversation || sending) return;
    setSending(true);
    try {
      const before = talkingDetail ?? await loadAgent(conversation.agentKey);
      await closeConversation(conversation.conversationId);
      const updated = await loadAgent(conversation.agentKey);
      setAgent(updated);
      if (before.playerRelationship && updated.playerRelationship) {
        setBondChange({
          agentKey: conversation.agentKey,
          trust: updated.playerRelationship.trust - before.playerRelationship.trust,
          affinity: updated.playerRelationship.affinity - before.playerRelationship.affinity,
          fear: updated.playerRelationship.fear - before.playerRelationship.fear,
          respect: updated.playerRelationship.respect - before.playerRelationship.respect,
        });
      }
      setConversation(null);
      setTalkingTo(null);
      setReply('');
      setSceneLocationKey(game?.player.locationKey ?? null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function makeRomanceChoice(input: {
    agentKey: string; sceneKey: string; choiceKey: string; locationKey: string;
  }): Promise<RomanceChoiceResult> {
    if (sending) throw new Error('another action is still resolving');
    setSending(true);
    try {
      const result = await chooseRomance(input);
      await refresh();
      setAgent(await loadAgent(input.agentKey));
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
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
        setAgent(null);
        setSceneLocationKey(null);
        setJourney(null);
        setBondChange(null);
        lastLocation.current = created.game.player.locationKey;
      } else {
        await refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!bootstrap || !game) {
    return <LandingScreen onEnter={enterTown} busy={entering} error={error} />;
  }

  const stageProgress = Math.round(game.world.globalTension / 100);
  const currentLocation = bootstrap.map.locations.find(({ key }) => key === game.player.locationKey)?.name
    ?? game.player.locationKey;
  const journeyFrom = journey ? bootstrap.map.locations.find(({ key }) => key === journey.from)?.name ?? journey.from : null;
  const journeyTo = journey ? bootstrap.map.locations.find(({ key }) => key === journey.to)?.name ?? journey.to : null;
  const tickSeconds = Math.max(0.1, 5 * 10_000 / game.world.timeScale);
  const adjacentLocations = bootstrap.map.routes
    .filter((route) => route.from === game.player.locationKey)
    .map((route) => bootstrap.map.locations.find((location) => location.key === route.to))
    .filter((location): location is NonNullable<typeof location> => Boolean(location));
  const pendingDestination = game.player.pendingMove
    ? bootstrap.map.locations.find((location) => location.key === game.player.pendingMove?.locationKey)
    : null;
  return <main className="app-shell">
    <PhaserGame key={bootstrap.session.worldId} bootstrap={bootstrap} game={game} />
    {sceneLocationKey === game.player.locationKey && <LocationScene
      key={`${sceneLocationKey}-${game.world.worldId}`}
      bootstrap={bootstrap}
      game={game}
      locationKey={sceneLocationKey}
      selectedAgent={agent}
      bondChange={bondChange}
      romance={game.romances.find((item) => item.agentKey === agent?.agent.agentKey) ?? null}
      busy={sending}
      onBack={() => { setSceneLocationKey(null); setAgent(null); }}
      onInspect={inspectAgent}
      onTalk={(agentKey) => void beginConversation(agentKey)}
      onRomanceChoice={makeRomanceChoice}
    />}
    {journey && <section className="journey-cinematic" aria-live="polite">
      <div className="journey-backdrop" style={{ backgroundPosition: atlasPosition(journey.to) }} aria-hidden="true" />
      <div className="journey-copy"><span className="eyebrow">On the road · one world tick</span><p>{journeyFrom}</p><ArrowRight size={22} aria-hidden="true" /><h2>{journeyTo}</h2></div>
      <div className="journey-rule" aria-hidden="true"><i /></div>
    </section>}

    <header className="hud">
      <div className="brand"><strong>Hollowmere</strong><span>Town instrument · {game.player.name}</span></div>
      <dl className="instrument-strip">
        <div className="instrument"><dt>tick</dt><dd>{game.world.currentTick}</dd></div>
        <div className="instrument"><dt>tick pace</dt><dd>{conversation ? 'held' : game.world.status === 'paused' ? 'paused' : `${tickSeconds.toFixed(tickSeconds < 1 ? 1 : 0)}s`}</dd></div>
        <div className="instrument stage-instrument"><dt>stage</dt><dd>{game.world.stage.replaceAll('_', ' ')}</dd></div>
        <div className="instrument tension-instrument"><dt>tension</dt><dd><span className="tension-track"><span style={{ width: `${stageProgress}%` }} /></span><b>{stageProgress}%</b></dd></div>
        <div className="instrument"><dt>phase</dt><dd>{game.world.phase}</dd></div>
        {game.world.timeDebtTicks > 0 && <div className="instrument"><dt>talk cost</dt><dd>+{game.world.timeDebtTicks} ticks</dd></div>}
        <div className="instrument seed-instrument"><dt>seed</dt><dd>{game.world.seed}</dd></div>
      </dl>
      <div className="controls">
        <select aria-label="Simulation speed" value={game.world.timeScale} onChange={(event) => void applyControl({
          action: 'timeScale', value: Number(event.target.value), idempotencyKey: crypto.randomUUID(),
        })} disabled={game.world.status !== 'active'}>
          <option value={5000}>0.5×</option><option value={10000}>1×</option><option value={20000}>2×</option>
          <option value={40000}>4×</option><option value={80000}>8×</option>
        </select>
        <button className="icon-button" aria-label={game.world.status === 'paused' ? 'Resume simulation' : 'Pause simulation'} onClick={() => void applyControl({ action: game.world.status === 'paused' ? 'resume' : 'pause' })}>
          {game.world.status === 'paused' ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          <span>{game.world.status === 'paused' ? 'Resume' : 'Pause'}</span>
        </button>
        <button className="new-run-button" onClick={() => void applyControl({ action: 'restart' })}><RotateCcw size={14} aria-hidden="true" /><span>New run</span></button>
      </div>
    </header>

    <nav className="toolrail" aria-label="Debug instruments">
      {([
        ['overview', 'Overview', Map], ['chronicle', 'Chronicle', BookOpen], ['graph', 'Graph', Network],
        ['evidence', 'Evidence', FileSearch], ['hearings', 'Hearings', Scale],
      ] as const).map(([name, label, Icon]) => <button key={name} aria-label={label} title={label} aria-pressed={panel === name} onClick={() => setPanel(name)}><Icon size={19} strokeWidth={1.6} aria-hidden="true" /><span>{label}</span></button>)}
      <div className="rail-spacer" />
      <button className="profile-rail-button" aria-label="Player record" title="Player record" aria-pressed={panel === 'profile'} onClick={() => setPanel('profile')}><UserRound size={19} strokeWidth={1.6} aria-hidden="true" /><span>You</span></button>
    </nav>

    <footer className="bottom-hud">
      <div className="faction-legend" aria-label="Map legend">
        <span><i className="legend-mark legend-you" />You</span><span><i className="legend-mark legend-aldreth" />Aldreth</span>
        <span><i className="legend-mark legend-corvane" />Corvane</span><span><i className="legend-mark legend-independent" />Independent</span>
      </div>
      <div className="shortcuts"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move locally</span><span><kbd>E</kbd> approach</span></div>
    </footer>
    {!sceneLocationKey && <nav className="travel-nav" aria-label={`Roads from ${currentLocation}`}>
      <button className="current-location-button" onClick={() => setSceneLocationKey(game.player.locationKey)}><b>{currentLocation}</b><small>enter location scene</small></button>
      {adjacentLocations.map((location) => <button key={location.key}
        disabled={Boolean(game.player.pendingMove || conversation) || game.world.status !== 'active'}
        onClick={() => void queueMove(location.key)}>{location.name}<small>1 tick</small></button>)}
    </nav>}
    {game.player.pendingMove && <div className="pending">Travelling to {pendingDestination?.name ?? game.player.pendingMove.locationKey} · arrives when tick {game.world.currentTick + 1} commits</div>}
    {error && <div className="toast" role="alert">{error}<button onClick={() => setError(null)}>dismiss</button></div>}

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
    {panel === 'profile' && <Panel title="Player record" onClose={() => setPanel(null)}>
      <section className="player-record">
        <div className="player-monogram" aria-hidden="true">{game.player.name.charAt(0).toUpperCase()}</div>
        <div><p className="eyebrow">The outsider</p><h3>{game.player.name}</h3><p>{currentLocation}</p></div>
      </section>
      <section className="profile-section"><h3>Background</h3><p>{game.player.background || 'No history was offered at the gate.'}</p></section>
      <section className="profile-section"><h3>Declared sympathy</h3><p className={`profile-sympathy sympathy-text-${game.player.sympathyFactionKey ?? 'none'}`}>{game.player.sympathyFactionKey === 'unaligned' ? 'Independent' : game.player.sympathyFactionKey ?? 'None declared'}</p></section>
      <section className="profile-section"><h3>House reputation</h3>{game.player.reputation.map((item) => {
        const magnitude = Math.abs(item.value) / 200;
        return <div className={`reputation-row ${item.value < 0 ? 'reputation-negative' : ''}`} key={item.factionKey}><span>{item.factionKey === 'unaligned' ? 'Independent' : item.factionKey}</span><div><i style={{ left: `${item.value < 0 ? 50 - magnitude : 50}%`, width: `${magnitude}%` }} /></div><b>{Math.round(item.value / 100)}%</b></div>;
      })}</section>
    </Panel>}
    {panel === 'agent' && <Panel title={agent?.agent.name ?? 'Agent inspector'} onClose={() => setPanel(null)}>
      {!agent ? <p className="empty">Choose an NPC on the map.</p> : <><p>{agent.summary}</p><p className="tags">{agent.traits.join(' · ')}</p><p className="approach-note">{agent.agent.name} is {agent.agent.currentAction ?? 'going about their routine'}. They have not engaged you yet.</p>{agent.agent.locationKey === game.player.locationKey && ['alive', 'injured'].includes(agent.agent.status) && <button className="speak-button" disabled={sending || Boolean(game.player.pendingMove)} onClick={() => void beginConversation(agent.agent.agentKey)}>Speak to {agent.agent.name}</button>}<dl className="detail-list"><div><dt>faction</dt><dd>{agent.agent.factionKey}</dd></div><div><dt>location</dt><dd>{agent.agent.locationKey}</dd></div><div><dt>status</dt><dd>{agent.agent.status}</dd></div><div><dt>action</dt><dd>{agent.agent.currentAction ?? 'routine'}</dd></div></dl><h3>Personality</h3>{Object.entries(agent.personality).map(([name, value]) => <div className="metric-row" key={name}><b>{name}</b><span>{Math.round(value / 100)}%</span></div>)}<h3>Relationship with you</h3>{agent.playerRelationship ? <><div className="metric-row"><b>trust · affinity</b><span>{Math.round(agent.playerRelationship.trust / 100)} · {Math.round(agent.playerRelationship.affinity / 100)}</span></div><div className="metric-row"><b>fear · respect</b><span>{Math.round(agent.playerRelationship.fear / 100)} · {Math.round(agent.playerRelationship.respect / 100)}</span></div>{agent.playerRelationship.impression && <p className="notice">{agent.playerRelationship.impression}</p>}</> : <p className="empty">No impression yet.</p>}<h3>Recent dialogue</h3>{agent.recentDialogue.length ? agent.recentDialogue.map((item, index) => <div className="metric-row" key={`${item.tick}-${index}`}><b>t{item.tick}</b><span>{item.text}</span></div>) : <p className="empty">Nothing recorded.</p>}<h3>Strongest beliefs</h3>{agent.beliefs.map((belief) => <div className="metric-row" key={belief.claimKey}><b>{belief.claimKey}</b><span>{Math.round(belief.confidence / 100)}% · t{belief.updatedTick}</span></div>)}<h3>Relationships</h3>{agent.relationships.map((relationship) => <div className="metric-row" key={relationship.agentKey}><b>{relationship.agentKey}</b><span>sentiment {Math.round(relationship.sentiment / 100)} · trust {Math.round(relationship.trust / 100)}</span></div>)}</>}
    </Panel>}

    {talkingTo && conversation && <section className="dialogue-stage" role="dialog" aria-modal="true" aria-label={`Conversation with ${talkingAgent?.name ?? talkingTo}`}>
      <div className="dialogue-backdrop" style={{ backgroundPosition: atlasPosition(talkingAgent?.locationKey ?? game.player.locationKey) }} aria-hidden="true" />
      {talkingAgent && <figure className={`dialogue-portrait faction-${talkingAgent.factionKey}`}>
        <img src={portraitPath(talkingAgent)} alt={`Portrait of ${talkingAgent.name}`} />
        <figcaption><span>{talkingAgent.factionKey === 'unaligned' ? 'Independent' : talkingAgent.factionKey}</span><strong>{talkingAgent.name}</strong></figcaption>
      </figure>}
      <div className="dialogue-panel">
        <header>
          <div><span className="eyebrow">Private conversation · {conversation.turnCount} {conversation.turnCount === 1 ? 'turn' : 'turns'}</span><h2>{talkingAgent?.name ?? talkingTo}</h2></div>
          <button disabled={sending} onClick={() => void leaveConversation()} aria-label="End conversation">End conversation</button>
        </header>
        <div className="dialogue-bond">
          <span>Bond <b>{talkingDetail?.playerRelationship ? `${talkingBond.toFixed(1)} / 5` : 'unformed'}</b></span>
          <div aria-hidden="true">{[1, 2, 3, 4, 5].map((heart) => <i className={talkingBond >= heart ? 'filled' : ''} key={heart}>♥</i>)}</div>
          <em>Outcome settles when you part.</em>
        </div>
        {conversation.participants.some((item) => item.role === 'observer') && <p className="audience">Not entirely private · overheard by {conversation.participants.filter((item) => item.role === 'observer').map((item) => item.name).join(', ')}</p>}
        <div className="conversation-log">
          {conversation.turns.map((turn) => <div className="conversation-exchange" key={turn.turnId}><p><b>You</b>{turn.playerText}</p><p><b>{conversation.agentName}</b>{turn.reply}</p><small>{turn.speechAct}{turn.fallback ? ' · fallback' : ''}</small></div>)}
        </div>
        <div className={`reply ${sending ? 'reply-listening' : ''}`}>{reply || (sending ? `${conversation.agentName} considers your words…` : conversation.turns.length ? 'Their answer hangs between you.' : 'They wait to learn why you approached.')}</div>
        <div className="conversation-approaches" role="group" aria-label="Conversation approaches">
          <span>Approach</span>
          {[
            ['Ask what they saw', 'What have you seen here that others might have missed?'],
            ['Offer help', 'You seem burdened. Is there something I can help you set right?'],
            ['Challenge a rumor', 'I have heard stories moving through town. Which one do you believe is dangerous?'],
          ].map(([label, prompt]) => <button type="button" key={label} disabled={sending} onClick={() => setUtterance(prompt)}>{label}</button>)}
        </div>
        <form onSubmit={sendDialogue}><textarea value={utterance} onChange={(event) => setUtterance(event.target.value)} maxLength={2000} autoFocus placeholder="Choose your words…" /><button disabled={sending || !utterance.trim()}>{sending ? 'Listening…' : 'Speak'}</button></form>
      </div>
    </section>}

    {truthWarning && !truth && <div className="modal-backdrop"><section className="modal"><span className="eyebrow">Spoiler boundary</span><h2>Reveal Engine Truth?</h2><p>This exposes the culprit, live scheme, and whether each clue is genuine or a misdirection. It only reads your current private world.</p><div className="modal-actions"><button onClick={() => setTruthWarning(false)}>Cancel</button><button className="danger" onClick={() => void loadTruth().then((value) => { setTruth(value); setTruthWarning(false); }).catch((cause) => setError(String(cause)))}>Reveal</button></div></section></div>}
    {truth && <section className="truth-drawer"><header><div><span className="eyebrow">Engine Truth</span><h2>{truth.culprit?.agentKey ?? 'No instigator data'}</h2></div><button onClick={() => setTruth(null)}>×</button></header>{truth.available ? <><p>Motive: {truth.culprit?.motiveKey ?? '—'} · exposed t{truth.culprit?.exposedTick ?? '—'}</p><p>Posture: {truth.scheme?.posture ?? '—'} · tactic: {truth.scheme?.currentTactic ?? '—'} · next strategy t{truth.scheme?.nextStrategyTick ?? '—'}</p>{truth.evidence.map((item) => <div className="metric-row" key={item.evidenceId}><b>{item.kind} · {item.accusedKey ?? 'unknown'}</b><span>{item.genuine ? 'genuine' : 'misdirection'}</span></div>)}</> : <p>The instigator implementation is not present in this worktree yet.</p>}</section>}

    {game.world.ending && <div className="ending"><span className="eyebrow">World ended</span><h1>{game.world.ending}</h1><p>The ledger remains open for inspection.</p>
      {game.romances.filter((arc) => arc.stage > 0).map((arc) => <article className="ending-romance" key={arc.agentKey}>
        <span><Heart size={15} fill="currentColor" aria-hidden="true" /> {arc.routeTitle} · {arc.status}</span>
        <p>{arc.epilogue}</p>
      </article>)}
      <button onClick={() => void applyControl({ action: 'restart' })}>Start another town</button></div>}
  </main>;
}
