import * as Phaser from 'phaser';

import type { AgentView, GameSnapshot, TownMap } from '@/lib/contracts';
import { EventBus } from './EventBus';
import {
  areAdjacent, interpolateRoute, LOCATION_RADIUS, MAP_SCALE, npcOffset,
  shouldSuppressGameInput, stableHash, validateTownMap, withinInteractionRange,
  WORLD_HEIGHT, WORLD_WIDTH, worldPosition,
} from './mapManifest';

const FACTION_TINT: Record<string, number> = {
  aldreth: 0x83b7df,
  corvane: 0xdf9569,
  unaligned: 0xc1b7a6,
};

export class TownScene extends Phaser.Scene {
  private mapData: TownMap | null = null;
  private state: GameSnapshot | null = null;
  private player?: Phaser.Physics.Arcade.Sprite;
  private playerPlaced = false;
  private agents = new Map<string, Phaser.GameObjects.Sprite>();
  private labels = new Map<string, Phaser.GameObjects.Text>();
  private locations = new Map<string, { x: number; y: number }>();
  private hearingMarkers: Phaser.GameObjects.GameObject[] = [];
  private obstacles?: Phaser.Physics.Arcade.StaticGroup;
  private keys?: Record<'up' | 'down' | 'left' | 'right' | 'interact', Phaser.Input.Keyboard.Key>;
  private nearestAgent: string | null = null;
  private overlayCaptured = false;
  private domInputCaptured = false;
  private unlisten: (() => void)[] = [];

  constructor() {
    super('TownScene');
  }

  preload(): void {
    this.load.spritesheet('town-tiles', '/assets/vendor/kenney/tiny-town/tilemap_packed.png', {
      frameWidth: 16, frameHeight: 16,
    });
    this.load.spritesheet('characters', '/assets/vendor/kenney/roguelike-characters/roguelikeChar_transparent.png', {
      frameWidth: 16, frameHeight: 16, spacing: 1,
    });
  }

  create(): void {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setZoom(1.2);
    this.obstacles = this.physics.add.staticGroup();
    if (this.input.keyboard) {
      const cursors = this.input.keyboard.createCursorKeys();
      this.keys = {
        up: this.input.keyboard.addKey('W'),
        down: this.input.keyboard.addKey('S'),
        left: this.input.keyboard.addKey('A'),
        right: this.input.keyboard.addKey('D'),
        interact: this.input.keyboard.addKey('E'),
      };
      this.keys.up.on('down', () => undefined);
      this.input.keyboard.on('keydown-E', () => {
        if (!this.inputCaptured && this.nearestAgent) {
          EventBus.emit('talk-agent', { agentKey: this.nearestAgent });
        }
      });
      // Arrow keys join WASD in update without replacing the typed keys.
      this.registry.set('cursors', cursors);
    }
    this.unlisten.push(
      EventBus.on('bootstrap', ({ map, game }) => this.bootstrap(map, game)),
      EventBus.on('game-state', (game) => this.applyState(game)),
    );
    window.addEventListener('hollowmere-input-focus', this.onInputFocus);
    document.addEventListener('focusin', this.onDomFocus);
    document.addEventListener('focusout', this.onDomFocus);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
    EventBus.emit('scene-ready', undefined);
  }

  override update(): void {
    if (!this.player || !this.keys) return;
    const cursors = this.registry.get('cursors') as Phaser.Types.Input.Keyboard.CursorKeys;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);
    if (!this.inputCaptured) {
      if (this.keys.left.isDown || cursors.left.isDown) body.setVelocityX(-150);
      if (this.keys.right.isDown || cursors.right.isDown) body.setVelocityX(150);
      if (this.keys.up.isDown || cursors.up.isDown) body.setVelocityY(-150);
      if (this.keys.down.isDown || cursors.down.isDown) body.setVelocityY(150);
      body.velocity.normalize().scale(150);
    }
    this.player.setFlipX(body.velocity.x < 0);
    this.updateProximity();
  }

  private cleanup(): void {
    for (const dispose of this.unlisten) dispose();
    window.removeEventListener('hollowmere-input-focus', this.onInputFocus);
    document.removeEventListener('focusin', this.onDomFocus);
    document.removeEventListener('focusout', this.onDomFocus);
  }

  private readonly onInputFocus = (event: Event) => {
    this.overlayCaptured = (event as CustomEvent<boolean>).detail;
  };

  private readonly onDomFocus = () => {
    queueMicrotask(() => {
      this.domInputCaptured = shouldSuppressGameInput(document.activeElement);
    });
  };

  private get inputCaptured(): boolean {
    return this.overlayCaptured || this.domInputCaptured;
  }

  private bootstrap(map: TownMap, game: GameSnapshot): void {
    if (this.mapData) return;
    const errors = validateTownMap(map);
    if (errors.length) {
      this.add.text(32, 32, `MAP CONTRACT FAILED\n${errors.join('\n')}`, {
        color: '#ff8c7d', fontFamily: 'monospace', fontSize: '18px', backgroundColor: '#20110f',
      }).setScrollFactor(0).setDepth(100);
      return;
    }
    this.mapData = map;
    this.drawTown(map);
    this.createPlayer();
    this.applyState(game);
  }

  private drawTown(map: TownMap): void {
    const ground = this.add.graphics();
    ground.fillStyle(0x1d2a20).fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ground.fillStyle(0x172c36).fillRect(0, 0, 250, WORLD_HEIGHT);
    ground.fillStyle(0x303424).fillRect(920, 0, WORLD_WIDTH - 920, WORLD_HEIGHT);

    for (const location of map.locations) this.locations.set(location.key, worldPosition(location));
    ground.lineStyle(26, 0x3b342c, 1);
    const seen = new Set<string>();
    for (const route of map.routes) {
      const key = [route.from, route.to].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const from = this.locations.get(route.from), to = this.locations.get(route.to);
      if (from && to) ground.lineBetween(from.x, from.y, to.x, to.y);
    }
    ground.lineStyle(3, 0x746452, 0.45);
    for (const route of map.routes) {
      const key = [route.from, route.to].sort().join(':edge');
      if (seen.has(key)) continue;
      seen.add(key);
      const from = this.locations.get(route.from), to = this.locations.get(route.to);
      if (from && to) ground.lineBetween(from.x, from.y, to.x, to.y);
    }

    map.locations.forEach((location, index) => {
      const point = this.locations.get(location.key)!;
      const marker = this.add.circle(point.x, point.y, LOCATION_RADIUS, 0x11130f, 0.62)
        .setStrokeStyle(2, location.controllingFactionKey === 'aldreth' ? 0x557f9f
          : location.controllingFactionKey === 'corvane' ? 0x9b664b : 0x766f63);
      marker.setData('locationKey', location.key);
      const buildingFrame = 72 + (index % 30);
      this.add.sprite(point.x, point.y - 12, 'town-tiles', buildingFrame).setScale(3).setDepth(2);
      const obstacle = this.add.rectangle(point.x, point.y - 12, 34, 26, 0x000000, 0);
      this.physics.add.existing(obstacle, true);
      this.obstacles?.add(obstacle);
      this.add.text(point.x, point.y + 38, location.name, {
        fontFamily: 'ui-monospace, monospace', fontSize: '12px', color: '#d7ccb9',
        backgroundColor: '#151713cc', padding: { x: 5, y: 3 },
      }).setOrigin(0.5).setDepth(8);
    });
  }

  private createPlayer(): void {
    this.player = this.physics.add.sprite(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 'characters', 7)
      .setScale(2.2).setDepth(20).setCollideWorldBounds(true);
    this.player.setTint(0xf1d07a);
    if (this.obstacles) this.physics.add.collider(this.player, this.obstacles);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
  }

  private applyState(game: GameSnapshot): void {
    if (!this.mapData || !this.player) return;
    const previousWorld = this.state?.world.worldId;
    this.state = game;
    const playerLocation = this.locations.get(game.player.locationKey);
    if (playerLocation && (!this.playerPlaced || previousWorld !== game.world.worldId)) {
      this.player.setPosition(playerLocation.x, playerLocation.y + 58);
      this.playerPlaced = true;
    }
    this.syncAgents(game.agents);
    this.drawHearings(game);
  }

  private syncAgents(agents: AgentView[]): void {
    const active = new Set<string>();
    for (const agent of agents) {
      active.add(agent.agentKey);
      const location = this.locations.get(agent.locationKey);
      if (!location) continue;
      const peers = agents.filter((candidate) => candidate.locationKey === agent.locationKey);
      const offset = npcOffset(agent.agentKey, peers);
      const target = { x: location.x + offset.x, y: location.y + offset.y };
      let sprite = this.agents.get(agent.agentKey);
      if (!sprite) {
        sprite = this.add.sprite(target.x, target.y, 'characters', stableHash(agent.agentKey) % 648)
          .setScale(1.85).setDepth(15).setInteractive({ useHandCursor: true });
        sprite.setData('locationKey', agent.locationKey);
        sprite.on('pointerdown', () => EventBus.emit('select-agent', { agentKey: agent.agentKey }));
        this.agents.set(agent.agentKey, sprite);
        const label = this.add.text(target.x, target.y - 25, agent.name.split(' ')[0] ?? agent.name, {
          fontFamily: 'ui-monospace, monospace', fontSize: '10px', color: '#ded6c8',
          backgroundColor: '#10110ecc', padding: { x: 3, y: 2 },
        }).setOrigin(0.5).setDepth(30).setVisible(false);
        this.labels.set(agent.agentKey, label);
      } else if (sprite.getData('locationKey') !== agent.locationKey) {
        sprite.setData('locationKey', agent.locationKey);
        const start = { x: sprite.x, y: sprite.y };
        const travel = { progress: 0 };
        this.tweens.add({
          targets: travel, progress: 1,
          duration: 900, ease: 'Sine.easeInOut',
          onUpdate: () => {
            const point = interpolateRoute(start, target, travel.progress);
            sprite!.setPosition(point.x, point.y);
            const label = this.labels.get(agent.agentKey);
            if (label) label.setPosition(sprite!.x, sprite!.y - 25);
          },
        });
      } else {
        sprite.setPosition(target.x, target.y);
        this.labels.get(agent.agentKey)?.setPosition(target.x, target.y - 25);
      }
      sprite.setTint(FACTION_TINT[agent.factionKey] ?? 0xffffff);
      if (agent.status === 'dead' || agent.status === 'detained') sprite.setAlpha(0.4);
      else sprite.setAlpha(1);
    }
    for (const [key, sprite] of this.agents) {
      if (active.has(key)) continue;
      sprite.destroy();
      this.labels.get(key)?.destroy();
      this.agents.delete(key);
      this.labels.delete(key);
    }
  }

  private drawHearings(game: GameSnapshot): void {
    for (const marker of this.hearingMarkers) marker.destroy();
    this.hearingMarkers = [];
    for (const hearing of game.hearings.filter((item) => !['resolved', 'abandoned'].includes(item.status))) {
      const point = this.locations.get(hearing.locationKey);
      if (!point) continue;
      const ring = this.add.circle(point.x, point.y, 72, 0xd6b65d, 0.05)
        .setStrokeStyle(3, 0xd6b65d, 0.85).setDepth(4);
      const label = this.add.text(point.x, point.y - 78, `hearing · t${hearing.dueTick}`, {
        fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: '#f0d888',
        backgroundColor: '#17150fcc', padding: { x: 4, y: 2 },
      }).setOrigin(0.5).setDepth(30);
      this.hearingMarkers.push(ring, label);
    }
  }

  private updateProximity(): void {
    if (!this.player || !this.state || !this.mapData) return;
    let nearest: { key: string; distance: number } | null = null;
    for (const agent of this.state.agents) {
      if (!['alive', 'injured'].includes(agent.status)) continue;
      const sprite = this.agents.get(agent.agentKey);
      if (!sprite || agent.locationKey !== this.state.player.locationKey) continue;
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, sprite.x, sprite.y);
      if (withinInteractionRange(this.player, sprite) && (!nearest || distance < nearest.distance)) {
        nearest = { key: agent.agentKey, distance };
      }
    }
    if (nearest?.key !== this.nearestAgent) {
      if (this.nearestAgent) this.labels.get(this.nearestAgent)?.setVisible(false);
      this.nearestAgent = nearest?.key ?? null;
      if (this.nearestAgent) this.labels.get(this.nearestAgent)?.setVisible(true);
    }

    if (this.state.player.pendingMove) return;
    for (const location of this.mapData.locations) {
      if (location.key === this.state.player.locationKey) continue;
      if (!areAdjacent(this.mapData, this.state.player.locationKey, location.key)) continue;
      const point = this.locations.get(location.key)!;
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, point.x, point.y) <= LOCATION_RADIUS) {
        EventBus.emit('request-move', { locationKey: location.key });
        return;
      }
    }
  }
}
