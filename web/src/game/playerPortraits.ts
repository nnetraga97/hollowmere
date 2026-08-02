export const PLAYER_PORTRAITS = [
  {
    key: 'player_scholar',
    name: 'The Scholar',
    description: 'Measured, perceptive, and difficult to mislead.',
    path: '/assets/hollowmere/portraits/players/player_scholar.jpg',
  },
  {
    key: 'player_wayfarer',
    name: 'The Wayfarer',
    description: 'Observant, composed, and new to every allegiance.',
    path: '/assets/hollowmere/portraits/players/player_wayfarer.jpg',
  },
] as const;

export type PlayerPortraitKey = typeof PLAYER_PORTRAITS[number]['key'];

export const DEFAULT_PLAYER_PORTRAIT_KEY: PlayerPortraitKey = 'player_scholar';

export function isPlayerPortraitKey(value: unknown): value is PlayerPortraitKey {
  return PLAYER_PORTRAITS.some(({ key }) => key === value);
}

export function playerPortraitPath(key: PlayerPortraitKey | undefined): string {
  return PLAYER_PORTRAITS.find((portrait) => portrait.key === key)?.path
    ?? PLAYER_PORTRAITS[0].path;
}
