'use client';

import { useEffect, useState } from 'react';
import {
  ArrowRight, CircleHelp, Feather, Gauge, Shield, ShieldHalf,
} from 'lucide-react';

import type { PlayerEntry } from '@/lib/clientApi';
import {
  DEFAULT_PLAYER_PORTRAIT_KEY, isPlayerPortraitKey, PLAYER_PORTRAITS, type PlayerPortraitKey,
} from '@/game/playerPortraits';

const PROFILE_KEY = 'hollowmere-player-profile-v1';

type Sympathy = NonNullable<PlayerEntry['sympathyFactionKey']>;
type InferenceProfile = NonNullable<PlayerEntry['inferenceProfile']>;

interface SavedProfile {
  playerName: string;
  background: string;
  portraitKey: PlayerPortraitKey;
  sympathyFactionKey: Sympathy | null;
  inferenceProfile: InferenceProfile | null;
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

const AZURE_MODELS: Record<InferenceProfile, { name: string; description: string }> = {
  azure_sol: {
    name: 'GPT-5.6 Sol',
    description: 'Faster responses for conversations, rumours, and town decisions.',
  },
  azure_terra: {
    name: 'GPT-5.6 Terra',
    description: 'Deeper character reasoning for dialogue and long-running investigations.',
  },
};

function defaultInferenceProfile(profiles: readonly InferenceProfile[]): InferenceProfile | null {
  return profiles.includes('azure_terra') ? 'azure_terra' : profiles[0] ?? null;
}

export function LandingScreen({ onEnter, busy, error, availableInferenceProfiles }: {
  onEnter(entry: PlayerEntry): Promise<void>;
  busy: boolean;
  error: string | null;
  availableInferenceProfiles: InferenceProfile[];
}) {
  const [name, setName] = useState('');
  const [background, setBackground] = useState('');
  const [portraitKey, setPortraitKey] = useState<PlayerPortraitKey>(DEFAULT_PLAYER_PORTRAIT_KEY);
  const [sympathy, setSympathy] = useState<Sympathy | null>(null);
  const [inferenceProfile, setInferenceProfile] = useState<InferenceProfile | null>(
    defaultInferenceProfile(availableInferenceProfiles),
  );
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
        portraitKey: isPlayerPortraitKey(profile.portraitKey)
          ? profile.portraitKey : DEFAULT_PLAYER_PORTRAIT_KEY,
        sympathyFactionKey: FACTIONS.some(({ key }) => key === profile.sympathyFactionKey)
          ? profile.sympathyFactionKey as Sympathy : null,
        inferenceProfile: (profile.inferenceProfile === 'azure_sol'
          || profile.inferenceProfile === 'azure_terra')
          && availableInferenceProfiles.includes(profile.inferenceProfile as InferenceProfile)
          ? profile.inferenceProfile
          : defaultInferenceProfile(availableInferenceProfiles),
      };
      setSaved(restored);
      setName(restored.playerName);
      setBackground(restored.background);
      setPortraitKey(restored.portraitKey);
      setSympathy(restored.sympathyFactionKey);
      setInferenceProfile(restored.inferenceProfile);
    } catch {
      window.localStorage.removeItem(PROFILE_KEY);
    }
  }, [availableInferenceProfiles]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !inferenceProfile) return;
    const profile: SavedProfile = {
      playerName: name.trim().slice(0, 60),
      background: background.trim().slice(0, 360),
      portraitKey,
      sympathyFactionKey: sympathy,
      inferenceProfile,
    };
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    setSaved(profile);
    await onEnter({ ...profile, inferenceProfile });
  }

  function restoreSaved() {
    if (!saved) return;
    setName(saved.playerName);
    setBackground(saved.background);
    setPortraitKey(saved.portraitKey);
    setSympathy(saved.sympathyFactionKey);
    setInferenceProfile(saved.inferenceProfile);
  }

  return <main className="entry-screen" data-tweak-id="landing-screen">
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

    <form className="entry-card" data-tweak-id="player-entry-form" onSubmit={submit}>
      <header><span className="entry-step">Player record · 01</span><h2>Who enters the town?</h2><p>Your identity becomes part of this private simulation.</p></header>

      <fieldset className="portrait-field">
        <legend>Choose your likeness</legend>
        <div className="portrait-grid">
          {PLAYER_PORTRAITS.map((portrait) => <button
            key={portrait.key}
            type="button"
            className="portrait-card"
            aria-label={`Choose ${portrait.name.toLowerCase()} portrait`}
            aria-pressed={portraitKey === portrait.key}
            onClick={() => setPortraitKey(portrait.key)}
          >
            <img src={portrait.path} alt="" />
          </button>)}
        </div>
      </fieldset>

      <label className="entry-field">
        <span>Your name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} autoComplete="name" placeholder="Enter your given name" required />
      </label>

      <label className="entry-field">
        <span>Your background</span>
        <textarea value={background} onChange={(event) => setBackground(event.target.value)} maxLength={360} rows={4} placeholder="e.g., An investigator who arrived three days before the accusations began…" />
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

      <details className="inference-field" data-tweak-id="inference-settings">
        <summary>How Hollowmere thinks</summary>
        <div className="inference-content">
          <p className="inference-intro">Choose the Azure Foundry model that will voice and plan for your private town.</p>
          <label className="inference-select">
            <Gauge size={22} strokeWidth={1.45} aria-hidden="true" />
            <span><strong>Azure Foundry</strong><small>{inferenceProfile ? AZURE_MODELS[inferenceProfile].description : 'Choose a model.'}</small></span>
            <select value={inferenceProfile ?? ''} onChange={(event) => setInferenceProfile(event.target.value as InferenceProfile)} required>
              {availableInferenceProfiles.map((profile) => <option key={profile} value={profile}>{AZURE_MODELS[profile].name}</option>)}
            </select>
          </label>
          <p className="inference-rule">Your choice changes the voice and responsiveness of the town—not its rules. Evidence, memories, belief updates, and outcomes remain grounded and replayable in CockroachDB.</p>
        </div>
      </details>

      {error && <p className="entry-error" role="alert">{error}</p>}

      <button className="enter-town-button" disabled={busy || !name.trim() || !inferenceProfile}>
        <span>{busy ? 'Starting your world…' : 'Start your world'}</span><ArrowRight size={18} aria-hidden="true" />
      </button>
      {saved && <button className="restore-profile-button" type="button" onClick={restoreSaved} disabled={busy}><Feather size={14} aria-hidden="true" /> Restore saved player record</button>}
      <p className="entry-privacy">Your signed player session owns one world at a time. Another begins only when you choose it.</p>
    </form>
  </main>;
}
