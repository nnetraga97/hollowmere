'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CircleHelp, Feather, Shield, ShieldHalf } from 'lucide-react';

import type { PlayerEntry } from '@/lib/clientApi';

const PROFILE_KEY = 'hollowmere-player-profile-v1';

type Sympathy = NonNullable<PlayerEntry['sympathyFactionKey']>;

interface SavedProfile {
  playerName: string;
  background: string;
  sympathyFactionKey: Sympathy | null;
}

const FACTIONS: {
  key: Sympathy;
  name: string;
  description: string;
  Icon: typeof Shield;
}[] = [
  { key: 'aldreth', name: 'Aldreth', description: 'Old harbour blood and the prince\'s grieving house.', Icon: Shield },
  { key: 'corvane', name: 'Corvane', description: 'Mill wealth, hard bargains, and an old rival claim.', Icon: ShieldHalf },
  { key: 'unaligned', name: 'Independent', description: 'No house oath. The town must earn your trust.', Icon: CircleHelp },
];

export function LandingScreen({ onEnter, busy, error }: {
  onEnter(entry: PlayerEntry): Promise<void>;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const [background, setBackground] = useState('');
  const [sympathy, setSympathy] = useState<Sympathy | null>(null);
  const [saved, setSaved] = useState<SavedProfile | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PROFILE_KEY);
      if (!raw) return;
      const profile = JSON.parse(raw) as Partial<SavedProfile>;
      if (typeof profile.playerName !== 'string' || !profile.playerName.trim()) return;
      const restored: SavedProfile = {
        playerName: profile.playerName.slice(0, 60),
        background: typeof profile.background === 'string' ? profile.background.slice(0, 360) : '',
        sympathyFactionKey: FACTIONS.some(({ key }) => key === profile.sympathyFactionKey)
          ? profile.sympathyFactionKey as Sympathy : null,
      };
      setSaved(restored);
      setName(restored.playerName);
      setBackground(restored.background);
      setSympathy(restored.sympathyFactionKey);
    } catch {
      window.localStorage.removeItem(PROFILE_KEY);
    }
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const profile: SavedProfile = {
      playerName: name.trim().slice(0, 60),
      background: background.trim().slice(0, 360),
      sympathyFactionKey: sympathy,
    };
    if (!profile.playerName) return;
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    setSaved(profile);
    await onEnter(profile);
  }

  function restoreSaved() {
    if (!saved) return;
    setName(saved.playerName);
    setBackground(saved.background);
    setSympathy(saved.sympathyFactionKey);
  }

  return <main className="entry-screen">
    <div className="entry-atmosphere" aria-hidden="true" />
    <section className="entry-briefing">
      <p className="eyebrow">A private town simulation</p>
      <h1>Hollowmere</h1>
      <p className="entry-subtitle">Town instrument</p>
      <div className="entry-rule"><span /></div>
      <blockquote>“The prince lies dead on the chapel steps. By sundown, the town will decide who must answer.”</blockquote>
      <dl className="entry-facts">
        <div><dt>Observe</dt><dd>Rumours move with people, not menus.</dd></div>
        <div><dt>Intervene</dt><dd>Question witnesses, challenge claims, and change allegiances.</dd></div>
        <div><dt>Remember</dt><dd>Every town keeps its own history, evidence, and ending.</dd></div>
      </dl>
    </section>

    <form className="entry-card" onSubmit={submit}>
      <header><span className="entry-step">Player record · 01</span><h2>Who enters the town?</h2><p>Your identity becomes part of this private simulation.</p></header>

      <label className="entry-field">
        <span>Your name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="name" placeholder="Enter your given name" required />
      </label>

      <label className="entry-field">
        <span>Your background</span>
        <textarea value={background} onChange={(event) => setBackground(event.target.value)} maxLength={360} rows={4} placeholder="A merchant who arrived three days before the accusations began…" />
        <small>{background.length}/360</small>
      </label>

      <fieldset className="sympathy-field">
        <legend>Faction sympathy <span>optional</span></legend>
        <div className="sympathy-grid">
          {FACTIONS.map(({ key, name: factionName, description, Icon }) => <button key={key} type="button" className={`sympathy-card sympathy-${key}`} aria-pressed={sympathy === key} onClick={() => setSympathy(sympathy === key ? null : key)}>
            <Icon size={22} strokeWidth={1.45} aria-hidden="true" />
            <strong>{factionName}</strong>
            <span>{description}</span>
          </button>)}
        </div>
      </fieldset>

      {error && <p className="entry-error" role="alert">{error}</p>}

      <button className="enter-town-button" disabled={busy || !name.trim()}>
        <span>{busy ? 'Opening the ledger…' : 'Enter Hollowmere'}</span><ArrowRight size={18} aria-hidden="true" />
      </button>
      {saved && <button className="restore-profile-button" type="button" onClick={restoreSaved} disabled={busy}><Feather size={14} aria-hidden="true" /> Restore saved player record</button>}
      <p className="entry-privacy">No account is required. Your signed session owns one isolated town.</p>
    </form>
  </main>;
}
