import * as Phaser from 'phaser';

import { TownScene } from './TownScene';

export function createGame(parent: HTMLElement): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#151713',
    pixelArt: true,
    roundPixels: true,
    width: parent.clientWidth || 960,
    height: parent.clientHeight || 640,
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
    physics: {
      default: 'arcade',
      arcade: { debug: false, gravity: { x: 0, y: 0 } },
    },
    scene: [TownScene],
  });
}
