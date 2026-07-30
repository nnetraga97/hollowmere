'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookHeart, Heart, MessageCircle, Users } from 'lucide-react';

import {
  atlasPosition, formatAction, LOCATION_SCENES, portraitPath, rankLocationAgents, relationshipLevel,
  resolveEncounterSelection,
} from '@/game/locationScenes';
import type {
  AgentDetail, Bootstrap, GameSnapshot, RomanceArc, RomanceChoiceResult,
} from '@/lib/contracts';
import { RomanceScene } from './RomanceScene';

interface LocationSceneProps {
  bootstrap: Bootstrap;
  game: GameSnapshot;
  locationKey: string;
  selectedAgentKey: string | null;
  selectedAgent: AgentDetail | null;
  bondChange: { agentKey: string; trust: number; affinity: number; fear: number; respect: number } | null;
  romance: RomanceArc | null;
  busy: boolean;
  onBack: () => void;
  onInspect: (agentKey: string) => void;
  onTalk: (agentKey: string) => void;
  onRomanceChoice: (input: {
    agentKey: string; sceneKey: string; choiceKey: string; locationKey: string;
  }) => Promise<RomanceChoiceResult>;
}

export function LocationScene({
  bootstrap, game, locationKey, selectedAgentKey, selectedAgent, bondChange, romance, busy,
  onBack, onInspect, onTalk, onRomanceChoice,
}: LocationSceneProps) {
  const returnButton = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(onBack);
  const [romanceOpen, setRomanceOpen] = useState(false);
  const romanceOpenRef = useRef(false);
  onBackRef.current = onBack;
  romanceOpenRef.current = romanceOpen;
  const location = bootstrap.map.locations.find(({ key }) => key === locationKey);
  const scene = LOCATION_SCENES[locationKey] ?? {
    kicker: 'A corner of Hollowmere',
    description: 'The town has not decided what this place means yet.',
    ambience: 'Rain moves softly through the dark.',
    atlasColumn: 3, atlasRow: 2,
  };
  const encounters = useMemo(() => rankLocationAgents(
    game.agents, locationKey, game.world.seed, game.world.day,
  ), [game.agents, game.world.day, game.world.seed, locationKey]);
  const activeKey = resolveEncounterSelection(selectedAgentKey, encounters);
  const activeEncounter = encounters.find(({ agentKey }) => agentKey === activeKey) ?? null;
  const active = selectedAgent?.agent.agentKey === activeKey ? selectedAgent : null;
  const activeRomance = active?.agent.agentKey === romance?.agentKey ? romance : null;

  useEffect(() => {
    if (activeKey && activeKey !== selectedAgentKey) onInspect(activeKey);
  }, [activeKey, onInspect, selectedAgentKey]);

  useEffect(() => setRomanceOpen(false), [active?.agent.agentKey]);

  useEffect(() => {
    returnButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !romanceOpenRef.current) onBackRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!romanceOpen) returnButton.current?.focus();
  }, [romanceOpen]);

  return <section className="location-scene" role={romanceOpen ? undefined : 'dialog'} aria-modal={romanceOpen ? undefined : 'true'} aria-label={`${location?.name ?? locationKey} scene`}>
    {romanceOpen && activeRomance?.moment ? <RomanceScene
      arc={activeRomance}
      locationKey={locationKey}
      busy={busy}
      onClose={() => setRomanceOpen(false)}
      onChoose={onRomanceChoice}
    /> : <>
    <div className="location-backdrop" style={{ backgroundPosition: atlasPosition(locationKey) }} aria-hidden="true" />
    <div className="location-weather" aria-hidden="true" />
    <header className="location-scene-header">
      <button ref={returnButton} className="return-map" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Return to map</button>
      <div className="location-title">
        <span className="eyebrow">{scene.kicker}</span>
        <h1>{location?.name ?? locationKey.replaceAll('_', ' ')}</h1>
        <p>{scene.description}</p>
      </div>
      <div className="scene-clock"><span>Day {game.world.day}</span><strong>{game.world.phase}</strong></div>
    </header>

    <div className="scene-encounters">
      <div className="encounter-heading">
        <span><Users size={14} aria-hidden="true" /> Present now</span>
        <small>{encounters.length} {encounters.length === 1 ? 'person' : 'people'} · live simulation</small>
      </div>
      {encounters.length ? <div className="encounter-list">
        {encounters.map((encounter, index) => <button
          className={`encounter-card faction-${encounter.factionKey}`}
          data-active={activeKey === encounter.agentKey || undefined}
          aria-pressed={activeKey === encounter.agentKey}
          key={encounter.agentKey}
          onClick={() => onInspect(encounter.agentKey)}
        >
          <img src={portraitPath(encounter)} alt="" />
          <span><small>{index === 0 ? 'Chance encounter' : encounter.factionKey}</small><strong>{encounter.name}</strong><em>{formatAction(encounter.currentAction)}</em></span>
        </button>)}
      </div> : <div className="empty-scene">
        <strong>No one is here just now.</strong>
        <span>People follow their own routines. Another tick may change the company.</span>
      </div>}
    </div>

    {activeEncounter && <aside className={`encounter-focus faction-${activeEncounter.factionKey}`} aria-busy={!active}>
      <div className="focus-portrait">
        <img src={portraitPath(activeEncounter)} alt={`Portrait of ${activeEncounter.name}`} />
        <span>{activeEncounter.factionKey === 'unaligned' ? 'Independent' : activeEncounter.factionKey}</span>
      </div>
      <div className="focus-copy">
        <span className="eyebrow">You cross paths</span>
        <h2>{activeEncounter.name}</h2>
        {active ? <>
        <p className="focus-summary">{active.summary}</p>
        <p className="focus-reason"><b>Why here:</b> {formatAction(active.agent.currentAction)}.</p>
        <BondMeter relationship={active.playerRelationship} />
        {activeRomance && <RomanceCard arc={activeRomance} onOpen={() => setRomanceOpen(true)} busy={busy} />}
        {bondChange?.agentKey === active.agent.agentKey && <div className="bond-impact" role="status">
          <span>Conversation remembered</span>
          <strong>{formatSigned(bondChange.trust)} trust · {formatSigned(bondChange.affinity)} affinity</strong>
          {(bondChange.fear !== 0 || bondChange.respect !== 0) && <small>{formatSigned(bondChange.fear)} fear · {formatSigned(bondChange.respect)} respect</small>}
        </div>}
        <div className="focus-actions">
          <button className="speak-scene-button" disabled={busy} onClick={() => onTalk(active.agent.agentKey)}>
            <MessageCircle size={16} aria-hidden="true" /> Speak with {active.agent.name.split(' ')[0]}
          </button>
          <span>Words alter trust, affinity, fear, and respect.</span>
        </div>
        </> : <p className="focus-summary" role="status">Remembering what you know about {activeEncounter.name}…</p>}
      </div>
    </aside>}

    <p className="scene-ambience"><span aria-hidden="true">“</span>{scene.ambience}<span aria-hidden="true">”</span></p>
    </>}
  </section>;
}

function RomanceCard({ arc, onOpen, busy }: { arc: RomanceArc; onOpen: () => void; busy: boolean }) {
  const complete = arc.stage >= arc.chapterCount;
  return <section className="romance-card" aria-label={`${arc.routeTitle} relationship route`}>
    <header>
      <span><BookHeart size={15} aria-hidden="true" /> {arc.routeTitle}</span>
      <b>{arc.status}</b>
    </header>
    <p>{arc.profile.plotRole}</p>
    <div className="romance-route-progress"><i><b style={{ width: `${(arc.stage / arc.chapterCount) * 100}%` }} /></i><span>{arc.stage} / {arc.chapterCount} moments</span></div>
    {complete
      ? <p className="romance-route-note">{arc.epilogue}</p>
      : <button className="romance-open" disabled={busy || !arc.available} onClick={onOpen}>
          <Heart size={16} aria-hidden="true" /> {arc.available ? `Stay a little longer with ${arc.shortName}` : 'A private moment is not ready'}
        </button>}
    {!complete && !arc.available && <small className="romance-lock-reason">{arc.availabilityReason}</small>}
    <details className="romance-character-notes">
      <summary>What you have learned about {arc.shortName}</summary>
      <dl>
        <div><dt>Behind the public face</dt><dd>{arc.profile.privateSelf}</dd></div>
        <div><dt>What {arc.shortName} wants</dt><dd>{arc.profile.deepestWant}</dd></div>
        <div><dt>How affection appears</dt><dd>{arc.profile.affectionStyle}</dd></div>
        <div><dt>Boundaries</dt><dd>{arc.profile.boundaries.join(' ')}</dd></div>
      </dl>
    </details>
    <small className="romance-no-lockout">Independent route · no jealousy or exclusivity lock</small>
  </section>;
}

function formatSigned(value: number): string {
  const scaled = value / 100;
  const formatted = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1);
  return `${value >= 0 ? '+' : ''}${formatted}`;
}

function BondMeter({ relationship }: { relationship: AgentDetail['playerRelationship'] }) {
  const level = relationshipLevel(relationship);
  return <section className="bond-meter" aria-label={relationship ? `Bond ${level.toFixed(1)} out of 5` : 'No bond yet'}>
    <div><span>Bond</span><strong>{relationship ? `${level.toFixed(1)} / 5` : 'Unformed'}</strong></div>
    <div className="bond-hearts" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((heart) => <span key={heart} className={level >= heart ? 'bond-full' : level >= heart - 0.5 ? 'bond-half' : ''}>
        <Heart size={18} />
      </span>)}
    </div>
    {relationship && <small>Trust {Math.round(relationship.trust / 100)} · Affinity {Math.round(relationship.affinity / 100)}</small>}
  </section>;
}
