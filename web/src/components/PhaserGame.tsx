'use client';

import { useEffect, useRef } from 'react';

import type { Bootstrap, GameSnapshot } from '@/lib/contracts';
import { EventBus } from '@/game/EventBus';

export function PhaserGame({ bootstrap, game }: { bootstrap: Bootstrap; game: GameSnapshot }) {
  const host = useRef<HTMLDivElement>(null);
  const ready = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    ready.current = false;
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
      ready.current = false;
      off();
      instance?.destroy(true);
      instance = null;
    };
  }, [bootstrap.map, bootstrap.session.worldId]);

  useEffect(() => {
    if (ready.current && game.world.worldId === bootstrap.session.worldId) {
      EventBus.emit('game-state', game);
    }
  }, [bootstrap.session.worldId, game]);

  return <div ref={host} className="game-canvas" aria-label="Interactive map of Hollowmere" />;
}
