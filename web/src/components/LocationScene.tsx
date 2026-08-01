'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookHeart, BookOpen, Heart, MessageCircle, MessageCircleDashed, Users } from 'lucide-react';

import {
  atlasPosition, formatAction, LOCATION_SCENES, portraitPath, rankLocationAgents, relationshipLevel,
  resolveEncounterSelection,
} from '@/game/locationScenes';
import type {
  AgentDetail, Bootstrap, GameSnapshot, PlayerRumor, RomanceArc, RomanceChoiceResult,
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
  onOpenEvidence: (evidenceId: string) => void;
  rumorSubject: string;
  rumorText: string;
  deceptionResult: string | null;
  onRumorSubjectChange: (agentKey: string) => void;
  onRumorTextChange: (text: string) => void;
  onClearRumorResult: () => void;
  onPlantRumor: (listenerAgentKey: string) => void;
  onRepeatRumor: (listenerAgentKey: string, rumor: PlayerRumor) => void;
  onRomanceChoice: (input: {
    agentKey: string; sceneKey: string; choiceKey: string; locationKey: string;
  }) => Promise<RomanceChoiceResult>;
}

export function LocationScene({
    bootstrap, game, locationKey, selectedAgentKey, selectedAgent, bondChange, romance, busy,
  onBack, onInspect, onTalk, onOpenEvidence, rumorSubject, rumorText, deceptionResult,
  onRumorSubjectChange, onRumorTextChange, onClearRumorResult, onPlantRumor, onRepeatRumor,
  onRomanceChoice,
}: LocationSceneProps) {
  const returnButton = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(onBack);
  const [romanceOpen, setRomanceOpen] = useState(false);
  const [rumorOpen, setRumorOpen] = useState(false);
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
  const notebookEvidence = game.evidence.find((item) => item.role === 'tamper_sign');
  const notebookClaim = game.claims.find((item) => item.claimKey === notebookEvidence?.claimKey);

  useEffect(() => {
    if (activeKey && activeKey !== selectedAgentKey) onInspect(activeKey);
  }, [activeKey, onInspect, selectedAgentKey]);

  useEffect(() => {
    setRomanceOpen(false);
    setRumorOpen(false);
  }, [active?.agent.agentKey]);

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

  return <section className="location-scene" data-tweak-id={'location-scene-' + locationKey} role={romanceOpen ? undefined : 'dialog'} aria-modal={romanceOpen ? undefined : 'true'} aria-label={`${location?.name ?? locationKey} scene`}>
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
      {locationKey === 'chapel' && notebookEvidence && <article className="case-opening-card">
        <div><span className="eyebrow">The first evidence</span><h2>Prince Edryc’s notebook</h2></div>
        <BookOpen size={24} aria-hidden="true" />
        <p>{notebookClaim?.text ?? 'The binding and damaged pages show visible interference.'} It points to tampering, not to who did it.</p>
        <p className="case-opening-lead"><b>Begin here:</b> Father Ansel found the body. Ask what he saw, then look for a record that can be compared with these pages.</p>
        <button data-tweak-id="inspect-notebook" onClick={() => onOpenEvidence(notebookEvidence.evidenceId)}>Inspect the notebook</button>
      </article>}
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

    {activeEncounter && <aside className={`encounter-focus faction-${activeEncounter.factionKey}${rumorOpen ? ' rumor-open' : ''}`} aria-busy={!active}>
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
        {rumorOpen ? <RumorComposer
          game={game}
          listener={active.agent}
          subject={rumorSubject}
          text={rumorText}
          result={deceptionResult}
          busy={busy}
          onSubjectChange={onRumorSubjectChange}
          onTextChange={onRumorTextChange}
          onCancel={() => setRumorOpen(false)}
          onPlant={() => onPlantRumor(active.agent.agentKey)}
          onRepeat={(rumor) => onRepeatRumor(active.agent.agentKey, rumor)}
        /> : <>
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
            <button className="rumor-scene-button" disabled={busy} onClick={() => { onClearRumorResult(); setRumorOpen(true); }}>
              <MessageCircleDashed size={16} aria-hidden="true" /> Plant rumor
            </button>
          </div>
        </>}
        </> : <p className="focus-summary" role="status">Remembering what you know about {activeEncounter.name}…</p>}
      </div>
    </aside>}

    {!rumorOpen && <p className="scene-ambience"><span aria-hidden="true">“</span>{scene.ambience}<span aria-hidden="true">”</span></p>}
    </>}
  </section>;
}

function RumorComposer({
  game, listener, subject, text, result, busy, onSubjectChange, onTextChange,
  onCancel, onPlant, onRepeat,
}: {
  game: GameSnapshot;
  listener: GameSnapshot['agents'][number];
  subject: string;
  text: string;
  result: string | null;
  busy: boolean;
  onSubjectChange: (agentKey: string) => void;
  onTextChange: (text: string) => void;
  onCancel: () => void;
  onPlant: () => void;
  onRepeat: (rumor: PlayerRumor) => void;
}) {
  const subjects = game.agents.filter((agent) =>
    agent.status === 'alive' && agent.agentKey !== listener.agentKey);
  return <section className="rumor-composer" aria-label={`Plant a rumor with ${listener.name}`}>
    <header><span><MessageCircleDashed size={13} aria-hidden="true" /> Misinformation</span><button type="button" onClick={onCancel}>Cancel</button></header>
    <p>You choose the lie. {listener.name.split(' ')[0]} decides whether to believe it from loyalty, credulity, and trust in you.</p>
    {game.playerRumors.some((rumor) => rumor.status === 'active' && rumor.subjectKey !== listener.agentKey) && <div className="rumor-existing">
      <span>Tell an existing story</span>
      {game.playerRumors.filter((rumor) => rumor.status === 'active' && rumor.subjectKey !== listener.agentKey).map((rumor) =>
        <button type="button" disabled={busy} key={rumor.claimKey} onClick={() => onRepeat(rumor)}>{rumor.text}</button>)}
    </div>}
    <form data-tweak-id="rumor-composer-form" onSubmit={(event) => { event.preventDefault(); onPlant(); }}>
      <label>About whom?<select value={subject} onChange={(event) => onSubjectChange(event.target.value)}><option value="">Choose a person</option>{subjects.map((agent) => <option key={agent.agentKey} value={agent.agentKey}>{agent.name}</option>)}</select></label>
      <textarea maxLength={240} value={text} onChange={(event) => onTextChange(event.target.value)} placeholder="I saw… / Someone has been…" />
      <button disabled={busy || !subject || !text.trim()}>{busy ? 'Planting…' : 'Plant'}</button>
    </form>
    {result && <p className="rumor-result" role="status">{result}</p>}
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
