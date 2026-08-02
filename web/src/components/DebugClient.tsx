'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Anchor, ArrowRight, BookOpen, ChevronDown, CircleDashed, FileSearch, Heart, LogOut, Map, Network, Pause, Play, Scale, Square, UserRound, Wheat, X } from 'lucide-react';

import { EventBus } from '@/game/EventBus';
import { atlasPosition, portraitPath, relationshipLevel } from '@/game/locationScenes';
import { playerPortraitPath } from '@/game/playerPortraits';
import type {
  AgentDetail, Bootstrap, ChronicleEntry, Conversation, DebugTruth, GameSnapshot, PlayerRumor,
  RomanceChoiceResult, SocialGraph,
} from '@/lib/contracts';
import {
  ApiError, chooseRomance, closeConversation, control, deleteWorld, listWorlds, loadAgent, loadChronicle, loadGame, loadGameSync, loadGraph, loadTruth, manufactureEvidence, movePlayer,
  plantRumor, renameWorld, startConversation, startSession, streamConversationTurn, type PlayerEntry, type WorldChoice,
} from '@/lib/clientApi';
import { PhaserGame } from './PhaserGame';
import { LocationScene } from './LocationScene';
import { Panel } from './Panel';
import { SocialGraphView } from './Charts';
import { LandingScreen } from './LandingScreen';
import { MemoryTrace } from './MemoryTrace';
import { WorldSelectionScreen } from './WorldSelectionScreen';

type PanelName = 'overview' | 'chronicle' | 'graph' | 'evidence' | 'hearings' | 'profile' | 'agent' | null;

const STAGE_THRESHOLDS = [
  { name: 'suspicion', value: 1_500 },
  { name: 'public accusations', value: 3_500 },
  { name: 'trials', value: 5_800 },
  { name: 'first blood', value: 7_800 },
  { name: 'war', value: 9_400 },
] as const;

function evidenceMeaning(item: GameSnapshot['evidence'][number]): string {
  if (item.manufactured) return 'This is a player-made record. It may persuade people, but it cannot prove the case.';
  switch (item.role) {
    case 'tamper_sign':
      return 'The damaged notebook makes tampering a live lead. It points to interference, not to the person responsible.';
    case 'tamper_comparator':
      return 'This gives you something to compare with the notebook. A mismatch can strengthen the case for tampering.';
    case 'culprit_access':
      return 'This ties a person to relevant access. It is a lead, not proof by itself.';
    case 'murder_opportunity':
      return 'This places a person near a crucial moment. It narrows the investigation but does not settle guilt.';
    case 'escalation_provenance':
      return 'This records how the accusation escalated, so you can separate a claim’s spread from its truth.';
    default:
      return 'Keep this alongside other evidence before deciding what the town should believe.';
  }
}

function EvidenceCard({
  item, claim, focused,
}: {
  item: GameSnapshot['evidence'][number];
  claim: GameSnapshot['claims'][number] | undefined;
  focused: boolean;
}) {
  return <div className={`evidence-card${focused ? ' focused' : ''}`} data-tweak-id={`evidence-${item.evidenceId}`}>
    <b>{item.manufactured ? 'manufactured record' : item.role?.replaceAll('_', ' ') ?? item.kind}</b>
    <span>{item.role ? `${item.kind} · ` : ''}found t{item.foundTick}</span>
    {claim && <p>{claim.text}</p>}
    {!claim && <p>{item.accusedKey ?? 'no named suspect'}{item.claimKey ? ` · ${item.claimKey}` : ''}{item.manufactured ? ` · ${Math.round(item.credibility / 100)}% convincing` : ''}</p>}
    {focused && <><p className="evidence-meaning"><b>What this changes:</b> {evidenceMeaning(item)}</p><p className="evidence-impact">Added to your case at tick {item.foundTick}. Use it in conversation or compare it with another record before treating it as a conclusion.</p></>}
  </div>;
}

export function DebugClient({
  availableInferenceProfiles,
}: {
  availableInferenceProfiles: NonNullable<PlayerEntry['inferenceProfile']>[];
}) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [panel, setPanel] = useState<PanelName>('overview');
  const [error, setError] = useState<string | null>(null);
  const [chronicle, setChronicle] = useState<ChronicleEntry[]>([]);
  const [graph, setGraph] = useState<SocialGraph | null>(null);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null);
  const [talkingTo, setTalkingTo] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [utterance, setUtterance] = useState('');
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [truth, setTruth] = useState<DebugTruth | null>(null);
  const [truthWarning, setTruthWarning] = useState(false);
  const [endWorldWarning, setEndWorldWarning] = useState(false);
  const [entering, setEntering] = useState(false);
  const [playerEntry, setPlayerEntry] = useState<PlayerEntry | null>(null);
  const [worlds, setWorlds] = useState<WorldChoice[]>([]);
  const [evidenceFocusId, setEvidenceFocusId] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [sceneLocationKey, setSceneLocationKey] = useState<string | null>(null);
  const [journey, setJourney] = useState<{ from: string; to: string } | null>(null);
  const [bondChange, setBondChange] = useState<{
    agentKey: string; trust: number; affinity: number; fear: number; respect: number;
  } | null>(null);
  const [rumorSubject, setRumorSubject] = useState('');
  const [rumorText, setRumorText] = useState('');
  const [deceptionResult, setDeceptionResult] = useState<string | null>(null);
  const [storyNotice, setStoryNotice] = useState<ChronicleEntry | null>(null);
  const moveInFlight = useRef(false);
  const lastLocation = useRef<string | null>(null);
  const gameRef = useRef<GameSnapshot | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const syncController = useRef<AbortController | null>(null);
  const refreshGeneration = useRef(0);
  const stateGeneration = useRef(0);
  const hydratedTick = useRef<number | null>(null);
  const conversationGeneration = useRef(0);
  const agentRequestGeneration = useRef(0);
  const agentRequestController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const generation = ++refreshGeneration.current;
    const mutationGeneration = stateGeneration.current;
    const interactionGeneration = conversationGeneration.current;
    try {
      const previousTick = hydratedTick.current;
      const next = await loadGame(controller.signal);
      if (generation !== refreshGeneration.current || mutationGeneration !== stateGeneration.current) return;
      gameRef.current = next;
      hydratedTick.current = next.world.currentTick;
      setGame(next);
      if (interactionGeneration === conversationGeneration.current) {
        setConversation(next.conversation);
        setTalkingTo(next.conversation?.agentKey ?? null);
      }
      setError(null);
      if (!next.player.pendingMove) moveInFlight.current = false;
      if (previousTick !== null && next.world.currentTick > previousTick) {
        void loadChronicle(previousTick + 1, 30).then((entries) => {
          if (generation !== refreshGeneration.current) return;
          const milestone = entries.find((entry) =>
            entry.kind === 'trigger' || entry.kind === 'escalation');
          if (milestone) setStoryNotice(milestone);
        }).catch(() => undefined);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (refreshController.current === controller) refreshController.current = null;
    }
  }, []);

  const sync = useCallback(async () => {
    if (syncController.current) return;
    const controller = new AbortController();
    syncController.current = controller;
    const mutationGeneration = stateGeneration.current;
    try {
      const next = await loadGameSync(controller.signal);
      if (mutationGeneration !== stateGeneration.current) return;
      const current = gameRef.current;
      if (!current || current.world.worldId !== next.world.worldId) return;
      const needsHydration = hydratedTick.current !== next.world.currentTick;
      const patched: GameSnapshot = {
        ...current,
        world: { ...current.world, ...next.world },
        player: { ...current.player, ...next.player },
      };
      gameRef.current = patched;
      setGame(patched);
      if (!next.player.pendingMove) moveInFlight.current = false;
      if (needsHydration) await refresh();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (syncController.current === controller) syncController.current = null;
    }
  }, [refresh]);

  async function enterTown(entry: PlayerEntry) {
    setEntering(true);
    setError(null);
    try {
      setWorlds(await listWorlds());
      setPlayerEntry(entry);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEntering(false);
    }
  }

  async function openWorld(options: { newWorld?: boolean; worldId?: string }) {
    if (!playerEntry) return;
    setEntering(true);
    setError(null);
    try {
      const created = await startSession(playerEntry, options);
      stateGeneration.current++;
      setBootstrap(created);
      gameRef.current = created.game;
      hydratedTick.current = created.game.world.currentTick;
      conversationGeneration.current++;
      setGame(created.game);
      setConversation(created.game.conversation);
      setTalkingTo(created.game.conversation?.agentKey ?? null);
      if (created.game.conversation) inspectAgent(created.game.conversation.agentKey);
      else {
        setAgent(null);
        setSelectedAgentKey(null);
      }
      setSceneLocationKey(null);
      setJourney(null);
      lastLocation.current = created.game.player.locationKey;
      setStoryNotice(null);
      if (created.game.world.currentTick <= 1 && created.game.player.locationKey === 'chapel') {
        setSceneLocationKey('chapel');
        inspectAgent('father_ansel');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setWorlds(await listWorlds().catch(() => worlds));
    } finally {
      setEntering(false);
    }
  }

  async function renameSelectedWorld(worldId: string, displayName: string) {
    setEntering(true);
    setError(null);
    try {
      const saved = await renameWorld(worldId, displayName);
      setWorlds((current) => current.map((world) => world.worldId === worldId
        ? { ...world, displayName: saved }
        : world));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setEntering(false);
    }
  }

  async function deleteSelectedWorld(worldId: string) {
    setEntering(true);
    setError(null);
    try {
      await deleteWorld(worldId);
      setWorlds((current) => current.filter((world) => world.worldId !== worldId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEntering(false);
    }
  }

  useEffect(() => {
    if (!bootstrap) return;
    let timer: number | null = null;
    let stopped = false;
    let chain = 0;
    const startPolling = () => {
      const token = ++chain;
      const poll = async () => {
        if (stopped || token !== chain) return;
        if (document.visibilityState === 'visible') await sync();
        if (stopped || token !== chain) return;
        timer = window.setTimeout(() => void poll(), 1_000);
      };
      timer = window.setTimeout(() => void poll(), 1_000);
    };
    const onVisibility = () => {
      chain++;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState !== 'visible') {
        syncController.current?.abort();
        return;
      }
      startPolling();
    };
    startPolling();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      chain++;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      syncController.current?.abort();
      refreshController.current?.abort();
    };
  }, [bootstrap, sync]);

  const inspectAgent = useCallback((agentKey: string, openPanel = false) => {
    if (openPanel) setPanel('agent');
    agentRequestController.current?.abort();
    const controller = new AbortController();
    agentRequestController.current = controller;
    const generation = ++agentRequestGeneration.current;
    setSelectedAgentKey(agentKey);
    setAgent((current) => current?.agent.agentKey === agentKey ? current : null);
    void loadAgent(agentKey, controller.signal).then((next) => {
      if (generation === agentRequestGeneration.current) setAgent(next);
    }).catch((cause) => {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(String(cause));
    }).finally(() => {
      if (agentRequestController.current === controller) agentRequestController.current = null;
    });
  }, []);

  useEffect(() => () => agentRequestController.current?.abort(), []);

  const queueMove = useCallback(async (locationKey: string) => {
    if (!game || !bootstrap || moveInFlight.current) return;
    if (locationKey === game.player.locationKey) {
      setSceneLocationKey(locationKey);
      setPanel(null);
      return;
    }
    moveInFlight.current = true;
    stateGeneration.current++;
    agentRequestGeneration.current++;
    agentRequestController.current?.abort();
    setAgent(null);
    setSelectedAgentKey(null);
    setSceneLocationKey(null);
    setPanel(null);
    setJourney({ from: game.player.locationKey, to: locationKey });
    try {
      const result = await movePlayer(locationKey, crypto.randomUUID());
      const current = gameRef.current;
      if (current) {
        const moved: GameSnapshot = {
          ...current,
          player: { ...current.player, locationKey: result.locationKey, pendingMove: null },
        };
        gameRef.current = moved;
        setGame(moved);
      }
      await refresh();
      moveInFlight.current = false;
      setJourney(null);
      setSceneLocationKey(result.locationKey);
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
      setSelectedAgentKey(null);
      agentRequestController.current?.abort();
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
  async function createRumor(listenerAgentKey: string) {
    if (!rumorSubject || !rumorText.trim() || sending) return;
    stateGeneration.current++;
    setSending(true);
    setDeceptionResult(null);
    try {
      const result = await plantRumor({
        subjectAgentKey: rumorSubject,
        listenerAgentKey,
        text: rumorText.trim(),
      });
      setRumorText('');
      setDeceptionResult(result.response);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function repeatRumor(listenerAgentKey: string, rumor: PlayerRumor) {
    if (sending) return;
    stateGeneration.current++;
    setSending(true);
    setDeceptionResult(null);
    try {
      const result = await plantRumor({
        claimKey: rumor.claimKey,
        listenerAgentKey,
        ...(rumor.evidenceId ? { evidenceId: rumor.evidenceId } : {}),
      });
      setDeceptionResult(result.response);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function forgeRumorEvidence(rumor: PlayerRumor) {
    if (sending) return;
    stateGeneration.current++;
    setSending(true);
    setDeceptionResult(null);
    try {
      const result = await manufactureEvidence(rumor.claimKey);
      setDeceptionResult(result.response);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function beginConversation(agentKey: string) {
    if (sending || game?.player.pendingMove) return;
    stateGeneration.current++;
    conversationGeneration.current++;
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
      if (cause instanceof ApiError && cause.status === 409) {
        await refresh();
        setAgent(null);
        setSelectedAgentKey(null);
        setError('They moved before you could speak. The location has been refreshed.');
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function sendDialogue(event: React.FormEvent) {
    event.preventDefault();
    if (!talkingTo || !conversation || !utterance.trim() || sending) return;
    const text = utterance.trim();
    stateGeneration.current++;
    conversationGeneration.current++;
    setUtterance('');
    setReply('');
    setSending(true);
    try {
      const result = await streamConversationTurn({ conversationId: conversation!.conversationId, text, idempotencyKey: crypto.randomUUID() },
        (token) => setReply((current) => current + token));
      setConversation(result.conversation);
      const agentGeneration = ++agentRequestGeneration.current;
      void Promise.all([refresh(), loadAgent(talkingTo)])
        .then(([, updated]) => {
          if (agentGeneration === agentRequestGeneration.current) setAgent(updated);
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  async function leaveConversation() {
    if (!conversation || sending) return;
    stateGeneration.current++;
    conversationGeneration.current++;
    setSending(true);
    try {
      const before = talkingDetail ?? await loadAgent(conversation.agentKey);
      await closeConversation(conversation.conversationId);
      setConversation(null);
      setTalkingTo(null);
      setReply('');
      setSceneLocationKey(game?.player.locationKey ?? null);
      const agentGeneration = ++agentRequestGeneration.current;
      void Promise.all([refresh(), loadAgent(conversation.agentKey)]).then(([, updated]) => {
        if (agentGeneration === agentRequestGeneration.current) setAgent(updated);
        if (before.playerRelationship && updated.playerRelationship) {
          setBondChange({
            agentKey: conversation.agentKey,
            trust: updated.playerRelationship.trust - before.playerRelationship.trust,
            affinity: updated.playerRelationship.affinity - before.playerRelationship.affinity,
            fear: updated.playerRelationship.fear - before.playerRelationship.fear,
            respect: updated.playerRelationship.respect - before.playerRelationship.respect,
          });
        }
      }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
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
    stateGeneration.current++;
    setSending(true);
    try {
      const result = await chooseRomance(input);
      const agentGeneration = ++agentRequestGeneration.current;
      void Promise.all([refresh(), loadAgent(input.agentKey)])
        .then(([, updated]) => {
          if (agentGeneration === agentRequestGeneration.current) setAgent(updated);
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
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
    if (controlling) return;
    stateGeneration.current++;
    setControlling(true);
    try {
      await control(body);
      if (body.action === 'start') {
        const created = await startSession();
        setBootstrap(created);
        gameRef.current = created.game;
        hydratedTick.current = created.game.world.currentTick;
        conversationGeneration.current++;
        setGame(created.game);
        setConversation(created.game.conversation);
        setTalkingTo(created.game.conversation?.agentKey ?? null);
        setTruth(null);
        setAgent(null);
        setSelectedAgentKey(null);
        agentRequestController.current?.abort();
        setSceneLocationKey(null);
        setJourney(null);
        setBondChange(null);
        setEndWorldWarning(false);
        lastLocation.current = created.game.player.locationKey;
      } else {
        const current = gameRef.current;
        if (current) {
          const world = { ...current.world };
          if (body.action === 'pause') world.status = 'paused';
          if (body.action === 'resume') world.status = 'active';
          if (body.action === 'end') {
            conversationGeneration.current++;
            world.status = 'ended';
            world.ending = 'player_ended';
          }
          if (body.action === 'timeScale' && typeof body.value === 'number') {
            world.timeScale = body.value;
          }
          const patched = { ...current, world };
          gameRef.current = patched;
          setGame(patched);
        }
        if (body.action === 'end') {
          setConversation(null);
          setTalkingTo(null);
          setAgent(null);
          setSelectedAgentKey(null);
          agentRequestController.current?.abort();
          setSceneLocationKey(null);
          setJourney(null);
          setEndWorldWarning(false);
        }
        void refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setControlling(false);
    }
  }

  async function quitWorld() {
    if (controlling) return;
    stateGeneration.current++;
    conversationGeneration.current++;
    setControlling(true);
    setError(null);
    try {
      if (gameRef.current?.world.status === 'active') await control({ action: 'pause' });
      const choices = await listWorlds();
      refreshController.current?.abort();
      syncController.current?.abort();
      agentRequestController.current?.abort();
      gameRef.current = null;
      hydratedTick.current = null;
      setBootstrap(null);
      setGame(null);
      setWorlds(choices);
      setConversation(null);
      setTalkingTo(null);
      setAgent(null);
      setSelectedAgentKey(null);
      setSceneLocationKey(null);
      setJourney(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setControlling(false);
    }
  }

  if (!bootstrap || !game) {
    if (playerEntry) {
      return <WorldSelectionScreen
        player={playerEntry}
        worlds={worlds}
        busy={entering}
        error={error}
        onOpen={(worldId) => openWorld({ worldId })}
        onCreate={() => openWorld({ newWorld: true })}
        onRename={renameSelectedWorld}
        onDelete={deleteSelectedWorld}
        onBack={() => {
          setPlayerEntry(null);
          setWorlds([]);
          setError(null);
        }}
      />;
    }
    return <LandingScreen
      onEnter={enterTown}
      busy={entering}
      error={error}
      availableInferenceProfiles={availableInferenceProfiles}
    />;
  }

  const stageProgress = Math.round(game.world.globalTension / 100);
  const nextStage = STAGE_THRESHOLDS.find((threshold) =>
    threshold.value > game.world.globalTension);
  const pointsToNextStage = nextStage
    ? Math.max(1, Math.ceil((nextStage.value - game.world.globalTension) / 100)) : 0;
  const currentLocation = bootstrap.map.locations.find(({ key }) => key === game.player.locationKey)?.name
    ?? game.player.locationKey;
  const journeyFrom = journey ? bootstrap.map.locations.find(({ key }) => key === journey.from)?.name ?? journey.from : null;
  const journeyTo = journey ? bootstrap.map.locations.find(({ key }) => key === journey.to)?.name ?? journey.to : null;
  const tickSeconds = Math.max(0.1, 5 * 10_000 / game.world.timeScale);
  const pendingDestination = game.player.pendingMove
    ? bootstrap.map.locations.find((location) => location.key === game.player.pendingMove?.locationKey)
    : null;
  return <main className="app-shell" data-tweak-id="town-app-shell">
    <PhaserGame key={bootstrap.session.worldId} bootstrap={bootstrap} game={game} />
    {sceneLocationKey === game.player.locationKey && <LocationScene
      key={`${sceneLocationKey}-${game.world.worldId}`}
      bootstrap={bootstrap}
      game={game}
      locationKey={sceneLocationKey}
      selectedAgentKey={selectedAgentKey}
      selectedAgent={agent}
      bondChange={bondChange}
      romance={game.romances.find((item) => item.agentKey === selectedAgentKey) ?? null}
      busy={sending}
      onBack={() => {
        setSceneLocationKey(null);
        setAgent(null);
        setSelectedAgentKey(null);
        agentRequestController.current?.abort();
      }}
      onInspect={inspectAgent}
      onTalk={(agentKey) => void beginConversation(agentKey)}
      onOpenEvidence={(evidenceId) => { setSceneLocationKey(null); setEvidenceFocusId(evidenceId); setPanel('evidence'); }}
      rumorSubject={rumorSubject}
      rumorText={rumorText}
      deceptionResult={deceptionResult}
      onRumorSubjectChange={setRumorSubject}
      onRumorTextChange={setRumorText}
      onClearRumorResult={() => setDeceptionResult(null)}
      onPlantRumor={(listenerAgentKey) => void createRumor(listenerAgentKey)}
      onRepeatRumor={(listenerAgentKey, rumor) => void repeatRumor(listenerAgentKey, rumor)}
      onRomanceChoice={makeRomanceChoice}
    />}
    {journey && <section className="journey-cinematic" aria-live="polite">
      <div className="journey-backdrop" style={{ backgroundPosition: atlasPosition(journey.to) }} aria-hidden="true" />
      <div className="journey-copy"><span className="eyebrow">On the road · one world tick</span><p>{journeyFrom}</p><ArrowRight size={22} aria-hidden="true" /><h2>{journeyTo}</h2></div>
      <div className="journey-rule" aria-hidden="true"><i /></div>
    </section>}

    <header className="hud" data-tweak-id="town-hud">
      <div className="brand"><strong>Hollowmere</strong><span>Town instrument · {game.player.name}</span></div>
      <dl className="instrument-strip">
        <div className="instrument"><dt>tick</dt><dd>{game.world.currentTick}</dd></div>
        <div className="instrument"><dt>tick pace</dt><dd>{conversation ? 'held' : game.world.status === 'paused' ? 'paused' : `${tickSeconds.toFixed(tickSeconds < 1 ? 1 : 0)}s`}</dd></div>
        <div className="instrument stage-instrument"><dt>stage</dt><dd>{game.world.stage.replaceAll('_', ' ')}</dd></div>
        <div className="instrument tension-instrument"><dt>tension</dt><dd><span className="tension-track"><span style={{ width: `${stageProgress}%` }} /></span><span className="tension-copy"><b>{stageProgress}%</b><small>{nextStage ? `${pointsToNextStage}% to ${nextStage.name}` : 'war threshold crossed'}</small></span></dd></div>
        <div className="instrument"><dt>phase</dt><dd>{game.world.phase}</dd></div>
        {game.world.timeDebtTicks > 0 && <div className="instrument"><dt>talk cost</dt><dd>+{game.world.timeDebtTicks} ticks</dd></div>}
        <div className="instrument seed-instrument"><dt>seed</dt><dd>{game.world.seed}</dd></div>
      </dl>
      <div className="controls">
        <select aria-label="Simulation speed" value={game.world.timeScale} onChange={(event) => void applyControl({
          action: 'timeScale', value: Number(event.target.value), idempotencyKey: crypto.randomUUID(),
        })} disabled={controlling || game.world.status !== 'active'}>
          <option value={5000}>0.5×</option><option value={10000}>1×</option><option value={20000}>2×</option>
          <option value={40000}>4×</option><option value={80000}>8×</option>
        </select>
        <button className="icon-button" disabled={controlling} aria-label={game.world.status === 'paused' ? 'Resume simulation' : 'Pause simulation'} onClick={() => void applyControl({ action: game.world.status === 'paused' ? 'resume' : 'pause' })}>
          {game.world.status === 'paused' ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          <span>{game.world.status === 'paused' ? 'Resume' : 'Pause'}</span>
        </button>
        <details className="world-menu" data-tweak-id="world-menu">
          <summary aria-label="World menu"><Square size={13} aria-hidden="true" /><span>World</span><ChevronDown size={13} aria-hidden="true" /></summary>
          <div role="menu">
            <button role="menuitem" disabled={controlling} onClick={() => void quitWorld()}><span><LogOut size={13} aria-hidden="true" />Quit world</span><small>Pauses the simulation and leaves</small></button>
            <button role="menuitem" className="end-world-menu-item" disabled={controlling} onClick={() => setEndWorldWarning(true)}><span><Square size={13} aria-hidden="true" />End world</span><small>Closes this town permanently</small></button>
          </div>
        </details>
      </div>
    </header>

    <nav className="toolrail" data-tweak-id="town-toolrail" aria-label="Debug instruments">
      {([
        ['overview', 'Overview', Map], ['chronicle', 'Chronicle', BookOpen], ['graph', 'Graph', Network],
        ['evidence', 'Evidence', FileSearch], ['hearings', 'Summons', Scale],
      ] as const).map(([name, label, Icon]) => <button key={name} aria-label={label} title={label} aria-pressed={panel === name} onClick={() => setPanel(panel === name ? null : name)}><Icon size={19} strokeWidth={1.6} aria-hidden="true" /><span>{label}</span></button>)}
      <div className="rail-spacer" />
      <button className="profile-rail-button" aria-label="Player record" title="Player record" aria-pressed={panel === 'profile'} onClick={() => setPanel(panel === 'profile' ? null : 'profile')}><UserRound size={19} strokeWidth={1.6} aria-hidden="true" /><span>You</span></button>
    </nav>

    <footer className="bottom-hud">
      <div className="faction-legend" aria-label="Map legend">
        <span className="legend-you"><UserRound size={13} aria-hidden="true" />You</span><span className="legend-aldreth"><Anchor size={13} aria-hidden="true" />Aldreth</span>
        <span className="legend-corvane"><Wheat size={13} aria-hidden="true" />Corvane</span><span className="legend-independent"><CircleDashed size={13} aria-hidden="true" />Independent</span>
      </div>
      <div className="shortcuts"><span><kbd>E</kbd> approach</span></div>
    </footer>
    {game.player.pendingMove && <div className="pending">Finishing earlier travel to {pendingDestination?.name ?? game.player.pendingMove.locationKey}</div>}
    {storyNotice && <aside className="story-notice" role="status" aria-live="polite">
      <span className="eyebrow">The town changes · tick {storyNotice.tick}</span>
      <p>{storyNotice.description}</p>
      <div><button onClick={() => { setPanel('chronicle'); setStoryNotice(null); }}>Open chronicle</button><button className="dismiss-story" aria-label="Dismiss" onClick={() => setStoryNotice(null)}><X size={15} aria-hidden="true" /></button></div>
    </aside>}
    {error && <div className="toast" role="alert">{error}<button onClick={() => setError(null)}>dismiss</button></div>}

    {panel === 'chronicle' && <Panel title="Chronicle" onClose={() => setPanel(null)}>{chronicle.map((entry) => <article className={`chronicle kind-${entry.kind}`} key={`${entry.tick}-${entry.seq}`}><time>t{entry.tick}</time><div><b>{entry.kind}</b><p>{entry.description}</p><small>{entry.actorKey ?? 'world'} · {entry.locationKey ?? 'town-wide'}</small></div></article>)}</Panel>}
    {panel === 'graph' && <Panel title="Social graph" onClose={() => setPanel(null)} wide>{graph ? <SocialGraphView graph={graph} /> : <p className="empty">Loading relationships…</p>}</Panel>}
    {panel === 'evidence' && <Panel title="Evidence ledger" onClose={() => { setEvidenceFocusId(null); setPanel(null); }} wide>
      {!game.capabilities.evidence && <p className="notice">The instigator engine tables are not installed in this worktree yet. This panel will activate after integration.</p>}
      <div className="evidence-counts">{[
        { label: 'case roles', count: new Set(game.evidence.flatMap((item) => item.role ? [item.role] : [])).size },
        { label: 'provenance', count: game.evidence.filter((item) => item.kind === 'provenance').length },
        { label: 'records', count: game.evidence.filter((item) => item.kind === 'record' && !item.manufactured).length },
        { label: 'manufactured', count: game.evidence.filter((item) => item.manufactured).length },
      ].map((item) => <div key={item.label}><strong>{item.count}</strong><span>{item.label}</span></div>)}</div>
      {game.evidence.map((item) => <EvidenceCard key={item.evidenceId} item={item} claim={game.claims.find((claim) => claim.claimKey === item.claimKey)} focused={evidenceFocusId === item.evidenceId} />)}
      <p className="evidence-rumor-note">Plant and repeat stories from a person’s location card. Only the listener needs to be present.</p>
      {deceptionResult && <p className="notice">{deceptionResult}</p>}
      {game.playerRumors.length > 0 && <section className="player-rumors"><h3>Your stories</h3>{game.playerRumors.map((rumor) => <article key={rumor.claimKey} className={rumor.status === 'discredited' ? 'discredited' : ''}>
        <header><b>{rumor.subjectKey}</b><span>{rumor.reach} heard · heat {Math.round(rumor.heat / 100)}%</span></header>
        <p>{rumor.text}</p>
        {rumor.fabricationOutcome ? <small>{rumor.fabricationOutcome === 'created' ? `Forged record · ${Math.round((rumor.evidenceCredibility ?? 0) / 100)}% convincing` : `Forgery ${rumor.fabricationOutcome}`}</small> : <small>{rumor.reach < 3 ? `${3 - rumor.reach} more listener${3 - rumor.reach === 1 ? '' : 's'} needed before a record can look plausible` : 'One difficult attempt is available to forge a supporting record'}</small>}
        <div>
          <button disabled={sending || rumor.status !== 'active' || rumor.reach < 3 || Boolean(rumor.fabricationOutcome)} onClick={() => void forgeRumorEvidence(rumor)}>Forge record</button>
        </div>
      </article>)}</section>}
      <hr /><button className="warning-button" onClick={() => setTruthWarning(true)}>Reveal Engine Truth</button>
    </Panel>}
    {panel === 'hearings' && <Panel title="Summons" onClose={() => setPanel(null)}>
      {!game.capabilities.hearings && <p className="notice">Summons state will appear after the instigator engine commit is integrated.</p>}
      {game.hearings.map((hearing) => <section className="hearing-card" key={hearing.hearingId}><h3>{hearing.locationKey}</h3><p>{hearing.status} · due t{hearing.dueTick} · {Math.max(0, hearing.dueTick - game.world.currentTick)} ticks remaining</p><p>Reveal: {hearing.revealClaimKey ?? 'not queued'}</p>{hearing.commitments.map((commitment) => <div className="metric-row" key={commitment.agentKey}><b>{commitment.agentKey}</b><span>{commitment.response} · {commitment.status}</span></div>)}</section>)}
    </Panel>}
    {panel === 'profile' && <Panel title="Player record" onClose={() => setPanel(null)}>
      <section className="player-record">
        <img className="player-record-portrait" src={playerPortraitPath(playerEntry?.portraitKey)} alt={`Portrait of ${game.player.name}`} />
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
      {!agent ? <p className="empty">Choose an NPC on the map.</p> : <><p>{agent.summary}</p><p className="tags">{agent.traits.join(' · ')}</p><p className="approach-note">{agent.agent.name} is {agent.agent.currentAction ?? 'going about their routine'}. They have not engaged you yet.</p>{agent.agent.locationKey === game.player.locationKey && ['alive', 'injured'].includes(agent.agent.status) && <button className="speak-button" disabled={sending || Boolean(game.player.pendingMove)} onClick={() => void beginConversation(agent.agent.agentKey)}>Speak to {agent.agent.name}</button>}<dl className="detail-list"><div><dt>faction</dt><dd>{agent.agent.factionKey}</dd></div><div><dt>location</dt><dd>{agent.agent.locationKey}</dd></div><div><dt>status</dt><dd>{agent.agent.status}</dd></div><div><dt>action</dt><dd>{agent.agent.currentAction ?? 'routine'}</dd></div></dl><h3>Personality</h3>{Object.entries(agent.personality).map(([name, value]) => <div className="metric-row" key={name}><b>{name}</b><span>{Math.round(value / 100)}%</span></div>)}<h3>Relationship with you</h3>{agent.playerRelationship ? <><div className="metric-row"><b>trust · affinity</b><span>{Math.round(agent.playerRelationship.trust / 100)} · {Math.round(agent.playerRelationship.affinity / 100)}</span></div><div className="metric-row"><b>fear · respect</b><span>{Math.round(agent.playerRelationship.fear / 100)} · {Math.round(agent.playerRelationship.respect / 100)}</span></div>{agent.playerRelationship.impression && <p className="notice">{agent.playerRelationship.impression}</p>}</> : <p className="empty">No impression yet.</p>}<h3>Recent dialogue</h3>{agent.recentDialogue.length ? agent.recentDialogue.map((item, index) => <div className="metric-row" key={`${item.tick}-${index}`}><b>t{item.tick}</b><span>{item.text}</span></div>) : <p className="empty">Nothing recorded.</p>}<MemoryTrace memories={agent.memoryTrace} /><h3>Private convictions <small>debug only</small></h3>{agent.beliefs.length ? agent.beliefs.map((belief) => <div className="metric-row" key={belief.claimKey}><b>{belief.text}</b><span>{belief.confidence < 0 ? 'denies' : 'believes'} · {Math.abs(Math.round(belief.confidence / 100))}% · t{belief.updatedTick}</span></div>) : <p className="empty">No settled convictions yet.</p>}<h3>Relationships</h3>{agent.relationships.map((relationship) => <div className="metric-row" key={relationship.agentKey}><b>{relationship.agentKey}</b><span>sentiment {Math.round(relationship.sentiment / 100)} · trust {Math.round(relationship.trust / 100)}</span></div>)}</>}
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
    {endWorldWarning && <div className="modal-backdrop"><section className="modal"><span className="eyebrow">End this world</span><h2>Leave Hollowmere behind?</h2><p>This permanently stops the simulation. Its chronicle stays stored under your signed player session, but this world cannot be resumed.</p><div className="modal-actions"><button disabled={controlling} onClick={() => setEndWorldWarning(false)}>Keep playing</button><button className="danger" disabled={controlling} onClick={() => void applyControl({ action: 'end' })}>{controlling ? 'Ending…' : 'End world'}</button></div></section></div>}
    {truth && <section className="truth-drawer"><header><div><span className="eyebrow">Engine Truth</span><h2>{truth.culprit?.agentKey ?? 'No instigator data'}</h2></div><button onClick={() => setTruth(null)}>×</button></header>{truth.available ? <><p>Motive: {truth.culprit?.motiveKey ?? '—'} · exposed t{truth.culprit?.exposedTick ?? '—'}</p>{truth.culprit && <p>{Object.entries(truth.culprit.caseState).map(([key, value]) => `${key}: ${value ?? '—'}`).join(' · ')}</p>}<p>Posture: {truth.scheme?.posture ?? '—'} · tactic: {truth.scheme?.currentTactic ?? '—'} · next strategy t{truth.scheme?.nextStrategyTick ?? '—'}</p>{truth.evidence.map((item) => <div className="metric-row" key={item.evidenceId}><b>{item.role ?? item.kind} · {item.accusedKey ?? 'unknown'}</b><span>{item.genuine ? 'genuine' : 'misdirection'}</span></div>)}</> : <p>The instigator implementation is not present in this worktree yet.</p>}</section>}

    {game.world.ending && <div className="ending"><span className="eyebrow">World ended · tick {game.world.currentTick}</span><h1>{game.world.ending === 'player_ended' ? 'Your story ends here' : game.world.ending}</h1><p>{game.world.ending === 'player_ended' ? 'The town is no longer advancing. Its record remains stored.' : 'The ledger remains open for inspection.'}</p>
      {game.world.ending !== 'player_ended' && game.romances.filter((arc) => arc.stage > 0).map((arc) => <article className="ending-romance" key={arc.agentKey}>
        <span><Heart size={15} fill="currentColor" aria-hidden="true" /> {arc.routeTitle} · {arc.status}</span>
        <p>{arc.epilogue}</p>
      </article>)}
      <button disabled={controlling} onClick={() => void quitWorld()}>{controlling ? 'Opening archive…' : 'Start another world'}</button></div>}
  </main>;
}
