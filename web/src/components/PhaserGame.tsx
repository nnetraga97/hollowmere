'use client';

import { useEffect, useRef } from 'react';

import type { Bootstrap, GameSnapshot } from '@/lib/contracts';
import { EventBus } from '@/game/EventBus';

export function PhaserGame({ bootstrap, game }: { bootstrap: Bootstrap; game: GameSnapshot }) {
  const host = useRef<HTMLDivElement>(null);
  const ready = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let instance: { destroy(removeCanvas?: boolean): void } | null = null;
    const off = EventBus.on('scene-ready', () => {
      ready.current = true;
      EventBus.emit('bootstrap', { map: bootstrap.map, game });
    });
    void import('@/game/main').then(({ createGame }) => {
      if (!disposed && host.current) instance = createGame(host.current);
    });
    return () => {
      disposed = true;
      off();
      instance?.destroy(true);
    };
  }, [bootstrap.map, bootstrap.session.worldId]);

  useEffect(() => {
    if (ready.current) EventBus.emit('game-state', game);
  }, [game]);

  return <div ref={host} className="game-canvas" aria-label="Interactive map of Hollowmere" />;
}
