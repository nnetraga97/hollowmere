'use client';

import { ArrowLeft, ArrowRight, BookOpen, Pause, Plus } from 'lucide-react';

import type { PlayerEntry, WorldChoice } from '@/lib/clientApi';

const MODEL_NAMES: Record<WorldChoice['inferenceProfile'], string> = {
  stub: 'Offline simulation',
  azure_sol: 'GPT-5.6 Sol',
  azure_terra: 'GPT-5.6 Terra',
  bedrock_sonnet: 'Claude Sonnet',
};

export function WorldSelectionScreen({
  player, worlds, busy, error, onOpen, onCreate, onBack,
}: {
  player: PlayerEntry;
  worlds: WorldChoice[];
  busy: boolean;
  error: string | null;
  onOpen(worldId: string): Promise<void>;
  onCreate(): Promise<void>;
  onBack(): void;
}) {
  const resumable = worlds.filter((world) => world.status === 'active' || world.status === 'paused');
  const ended = worlds.filter((world) => world.status === 'ended');

  return <main className="world-select-screen">
    <section className="world-select-header">
      <button type="button" className="world-back" onClick={onBack} disabled={busy}><ArrowLeft size={15} /> Player record</button>
      <p className="eyebrow">World archive</p>
      <h1>Welcome, {player.playerName ?? 'traveler'}</h1>
      <p>Resume a living Hollowmere or begin another seeded history. Previous chronicles remain intact.</p>
    </section>

    <section className="world-select-content">
      <div className="world-select-title"><div><span className="entry-step">Private worlds</span><h2>Choose a world</h2></div><button type="button" className="new-world-button" onClick={() => void onCreate()} disabled={busy}><Plus size={16} /> {busy ? 'Preparing…' : 'Start new world'}</button></div>
      {error && <p className="entry-error" role="alert">{error}</p>}

      {resumable.length > 0 ? <div className="world-card-grid">{resumable.map((world) => <article className="world-card" key={world.worldId}>
        <div className="world-card-top"><span>{world.status === 'paused' ? <Pause size={14} /> : <BookOpen size={14} />}{world.status}</span><b>{MODEL_NAMES[world.inferenceProfile]}</b></div>
        <h3>Seed {world.seed}</h3>
        <dl><div><dt>Day</dt><dd>{world.day}</dd></div><div><dt>Tick</dt><dd>{world.currentTick}</dd></div><div><dt>Stage</dt><dd>{world.stage.replaceAll('_', ' ')}</dd></div></dl>
        <small>Created {new Date(world.createdAt).toLocaleDateString()}</small>
        <button type="button" onClick={() => void onOpen(world.worldId)} disabled={busy}>{world.status === 'paused' ? 'Unpause world' : 'Enter world'}<ArrowRight size={15} /></button>
      </article>)}</div> : <div className="world-empty"><BookOpen size={24} /><h3>No living worlds</h3><p>Start a new history to enter Hollowmere at the chapel.</p></div>}

      {ended.length > 0 && <p className="world-archive-note">{ended.length} completed {ended.length === 1 ? 'chronicle' : 'chronicles'} preserved in the archive.</p>}
    </section>
  </main>;
}
