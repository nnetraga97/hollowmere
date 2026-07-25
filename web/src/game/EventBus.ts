import type { GameSnapshot, TownMap } from '@/lib/contracts';

export interface GameEvents {
  'bootstrap': { map: TownMap; game: GameSnapshot };
  'game-state': GameSnapshot;
  'select-agent': { agentKey: string };
  'talk-agent': { agentKey: string };
  'request-move': { locationKey: string };
  'scene-ready': undefined;
}

class TypedEventBus {
  private readonly target = new EventTarget();

  emit<K extends keyof GameEvents>(name: K, detail: GameEvents[K]): void {
    this.target.dispatchEvent(new CustomEvent(String(name), { detail }));
  }

  on<K extends keyof GameEvents>(name: K, listener: (detail: GameEvents[K]) => void): () => void {
    const wrapped = (event: Event) => listener((event as CustomEvent<GameEvents[K]>).detail);
    this.target.addEventListener(String(name), wrapped);
    return () => this.target.removeEventListener(String(name), wrapped);
  }
}

export const EventBus = new TypedEventBus();
