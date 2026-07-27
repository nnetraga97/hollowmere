'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookHeart, Heart, ShieldCheck } from 'lucide-react';

import type { RomanceArc, RomanceChoiceResult } from '@/lib/contracts';

interface RomanceSceneProps {
  arc: RomanceArc;
  locationKey: string;
  busy: boolean;
  onClose: () => void;
  onChoose: (input: {
    agentKey: string; sceneKey: string; choiceKey: string; locationKey: string;
  }) => Promise<RomanceChoiceResult>;
}

export function RomanceScene({ arc, locationKey, busy, onClose, onChoose }: RomanceSceneProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<RomanceChoiceResult | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moment = arc.moment;

  useEffect(() => {
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !choosing) onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [choosing, onClose]);

  async function choose(choiceKey: string) {
    if (!moment || busy || choosing) return;
    setChoosing(choiceKey);
    setError(null);
    try {
      setResult(await onChoose({
        agentKey: arc.agentKey,
        sceneKey: moment.sceneKey,
        choiceKey,
        locationKey,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChoosing(null);
    }
  }

  if (!moment) return null;
  return <section className="romance-scene" role="dialog" aria-modal="true" aria-label={`${moment.title}, a private moment with ${arc.shortName}`}>
    <div className={`romance-scene-wash faction-${arc.factionKey}`} aria-hidden="true" />
    <header className="romance-scene-header">
      <button ref={closeButton} className="romance-close" onClick={onClose} disabled={Boolean(choosing)}>
        <ArrowLeft size={15} aria-hidden="true" /> Return to the street
      </button>
      <div className="romance-chapter"><span>Bond chapter {moment.chapter} of {moment.chapterCount}</span><i><b style={{ width: `${(moment.chapter / moment.chapterCount) * 100}%` }} /></i></div>
    </header>

    {!result ? <div className="romance-scene-body">
      <div className="romance-scene-title">
        <span className="eyebrow"><BookHeart size={14} aria-hidden="true" /> {moment.kicker}</span>
        <h1>{moment.title}</h1>
        <small>{moment.setting}</small>
      </div>
      <div className="romance-prose">
        <p className="romance-narration">{moment.narration}</p>
        {moment.callbacks.map((callback) => <p className="romance-callback" key={callback}>{callback}</p>)}
        <blockquote>{moment.opening}</blockquote>
      </div>
      <div className="romance-choices" aria-label="Choose your response">
        <span>Choose what you mean</span>
        {moment.choices.map((choice) => <button
          key={choice.key}
          disabled={busy || Boolean(choosing)}
          data-choosing={choosing === choice.key || undefined}
          onClick={() => void choose(choice.key)}
        >
          <strong>{choice.label}</strong>
          <small>{choice.intent}</small>
        </button>)}
      </div>
      {error && <p className="romance-error" role="alert">{error}</p>}
    </div> : <div className="romance-result" aria-live="polite">
      <span className="eyebrow"><Heart size={15} fill="currentColor" aria-hidden="true" /> {result.arc.status}</span>
      <blockquote>{result.response}</blockquote>
      <p>{result.aftermath}</p>
      <div className="romance-consequences">
        <span><ShieldCheck size={15} aria-hidden="true" /> This choice is remembered</span>
        <ul>{result.effectSummary.map((effect) => <li key={effect}>{effect}</li>)}</ul>
      </div>
      <button className="romance-continue" onClick={onClose}>Continue</button>
    </div>}

    <footer className="romance-scene-footer">
      <span>No exclusivity lock</span>
      <p>Your relationship with {arc.shortName} never closes another person’s route. Hollowmere remembers each bond on its own terms.</p>
    </footer>
  </section>;
}
