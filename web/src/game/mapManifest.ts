import type { AgentView, TownMap } from '@/lib/contracts';

export const MAP_VERSION = 'hollowmere-v2';
export const MAP_SCALE = 16;
export const MAP_PADDING = 150;
export const WORLD_WIDTH = 1_400;
export const WORLD_HEIGHT = 1_100;
export const LOCATION_RADIUS = 54;

export const LOCATION_KEYS = [
  'chapel', 'fields', 'granary', 'high_row', 'low_row', 'market_square',
  'mill', 'plaza', 'quay', 'shipyard', 'tavern',
] as const;

const ROUTES = [
  ['market_square', 'quay'], ['market_square', 'shipyard'], ['market_square', 'plaza'],
  ['market_square', 'tavern'], ['market_square', 'low_row'], ['market_square', 'granary'],
  ['quay', 'shipyard'], ['plaza', 'chapel'], ['granary', 'mill'], ['mill', 'fields'],
  ['granary', 'fields'], ['tavern', 'low_row'], ['low_row', 'high_row'], ['high_row', 'plaza'],
] as const;

const routeKey = (a: string, b: string) => [a, b].sort().join('::');

export function validateTownMap(map: TownMap): string[] {
  const errors: string[] = [];
  if (map.scenarioVersion !== MAP_VERSION) errors.push(`unsupported scenario ${map.scenarioVersion}`);
  const actualLocations = new Set(map.locations.map((location) => location.key));
  for (const key of LOCATION_KEYS) if (!actualLocations.has(key)) errors.push(`map is missing location ${key}`);
  for (const key of actualLocations) if (!(LOCATION_KEYS as readonly string[]).includes(key)) errors.push(`map has unknown location ${key}`);
  const actualRoutes = new Set(map.routes.map((route) => routeKey(route.from, route.to)));
  for (const [from, to] of ROUTES) if (!actualRoutes.has(routeKey(from, to))) errors.push(`map is missing route ${from} -> ${to}`);
  return errors;
}

export function worldPosition(location: { x: number; y: number }) {
  return { x: location.x * MAP_SCALE + MAP_PADDING, y: location.y * MAP_SCALE + MAP_PADDING };
}

export function interpolateRoute(
  from: { x: number; y: number },
  to: { x: number; y: number },
  progress: number,
) {
  const amount = Math.max(0, Math.min(1, progress));
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
  };
}

export function withinInteractionRange(
  first: { x: number; y: number },
  second: { x: number; y: number },
  range = 75,
): boolean {
  return Math.hypot(first.x - second.x, first.y - second.y) <= range;
}

export function shouldSuppressGameInput(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return target.isContentEditable === true || tag === 'input' || tag === 'textarea' || tag === 'select';
}

export function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function npcOffset(agentKey: string, colocated: readonly AgentView[]) {
  const ordered = [...colocated].sort((a, b) => a.agentKey.localeCompare(b.agentKey));
  const index = Math.max(0, ordered.findIndex((agent) => agent.agentKey === agentKey));
  const ring = Math.floor(index / 8) + 1;
  const angle = ((index % 8) / 8) * Math.PI * 2 + (stableHash(agentKey) % 17) / 40;
  const radius = 22 + ring * 15;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function areAdjacent(map: TownMap, from: string, to: string): boolean {
  return map.routes.some((route) =>
    (route.from === from && route.to === to) || (route.from === to && route.to === from));
}
