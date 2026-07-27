'use client';

import { useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Heart, MessageCircle, Users } from 'lucide-react';

import {
  atlasPosition, formatAction, LOCATION_SCENES, portraitPath, rankLocationAgents, relationshipLevel,
} from '@/game/locationScenes';
import type { AgentDetail, Bootstrap, GameSnapshot } from '@/lib/contracts';

interface LocationSceneProps {
  bootstrap: Bootstrap;
  game: GameSnapshot;
  locationKey: string;
  selectedAgent: AgentDetail | null;
  bondChange: { agentKey: string; trust: number; affinity: number; fear: number; respect: number } | null;
  busy: boolean;
  onBack: () => void;
  onInspect: (agentKey: string) => void;
  onTalk: (agentKey: string) => void;
}

export function LocationScene({
  bootstrap, game, locationKey, selectedAgent, bondChange, busy, onBack, onInspect, onTalk,
}: LocationSceneProps) {
  const returnButton = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
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
  const active = selectedAgent && encounters.some(({ agentKey }) => agentKey === selectedAgent.agent.agentKey)
    ? selectedAgent : null;

  useEffect(() => {
    if (!active && encounters[0]) onInspect(encounters[0].agentKey);
  }, [active, encounters, onInspect]);

  useEffect(() => {
    returnButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBackRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <section className="location-scene" role="dialog" aria-modal="true" aria-label={`${location?.name ?? locationKey} scene`}>
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
          data-active={active?.agent.agentKey === encounter.agentKey || undefined}
          aria-pressed={active?.agent.agentKey === encounter.agentKey}
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

    {active && <aside className={`encounter-focus faction-${active.agent.factionKey}`}>
      <div className="focus-portrait">
        <img src={portraitPath(active.agent)} alt={`Portrait of ${active.agent.name}`} />
        <span>{active.agent.factionKey === 'unaligned' ? 'Independent' : active.agent.factionKey}</span>
      </div>
      <div className="focus-copy">
        <span className="eyebrow">You cross paths</span>
        <h2>{active.agent.name}</h2>
        <p className="focus-summary">{active.summary}</p>
        <p className="focus-reason"><b>Why here:</b> {formatAction(active.agent.currentAction)}.</p>
        <BondMeter relationship={active.playerRelationship} />
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
      </div>
    </aside>}

    <p className="scene-ambience"><span aria-hidden="true">“</span>{scene.ambience}<span aria-hidden="true">”</span></p>
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
