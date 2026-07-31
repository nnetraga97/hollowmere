import * as Phaser from 'phaser';

import type { AgentView, GameSnapshot, TownMap } from '@/lib/contracts';
import { EventBus } from './EventBus';
import { rankLocationAgents } from './locationScenes';
import {
  areAdjacent, LOCATION_KEYS, LOCATION_RADIUS, MAP_SCALE, npcOffset,
  shouldSuppressGameInput, validateTownMap, withinInteractionRange,
  WORLD_HEIGHT, WORLD_WIDTH, worldPosition,
} from './mapManifest';

const FACTION_TINT: Record<string, number> = {
  aldreth: 0x3b82f6,
  corvane: 0xf97316,
  unaligned: 0x94a3b8,
};

const FEMALE_AGENT_KEYS = new Set([
  'maren_aldreth', 'sella_dorn', 'oriel_faskin', 'annet_pike', 'mabel_thorn', 'tamsin_vye',
  'edda_lyle', 'veranne_thule', 'hester_lowe', 'widow_sable', 'morna_dell', 'jenna_ryle',
]);

const PLAYER_FRAME = 595;
const LOCAL_MOVEMENT_RADIUS = 82;

interface LocationMarker {
  marker: Phaser.GameObjects.Arc;
  halo: Phaser.GameObjects.Arc;
  roster: Phaser.GameObjects.Text;
}

export class TownScene extends Phaser.Scene {
  private mapData: TownMap | null = null;
  private state: GameSnapshot | null = null;
  private player?: Phaser.Physics.Arcade.Sprite;
  private playerMarker?: Phaser.GameObjects.Ellipse;
  private playerLabel?: Phaser.GameObjects.Text;
  private playerPlaced = false;
  private agents = new Map<string, Phaser.GameObjects.Container>();
  private locations = new Map<string, { x: number; y: number }>();
  private locationMarkers = new Map<string, LocationMarker>();
  private authoritativePlayerLocation: string | null = null;
  private hearingMarkers: Phaser.GameObjects.GameObject[] = [];
  private obstacles?: Phaser.Physics.Arcade.StaticGroup;
  private keys?: {
    up: readonly Phaser.Input.Keyboard.Key[];
    down: readonly Phaser.Input.Keyboard.Key[];
    left: readonly Phaser.Input.Keyboard.Key[];
    right: readonly Phaser.Input.Keyboard.Key[];
    interact: Phaser.Input.Keyboard.Key;
  };
  private nearestAgent: string | null = null;
  private overlayCaptured = false;
  private domInputCaptured = false;
  private cleaned = false;
  private unlisten: (() => void)[] = [];

  constructor() {
    super('TownScene');
  }

  preload(): void {
    this.load.spritesheet('characters', '/assets/vendor/kenney/roguelike-characters/roguelikeChar_transparent.png', {
      frameWidth: 16, frameHeight: 16, spacing: 1,
    });
    this.load.image('map-texture', '/assets/hollowmere/map-texture.jpg');
    this.load.image('aldreth-male', '/assets/hollowmere/portraits/aldreth_male.jpg');
    this.load.image('aldreth-female', '/assets/hollowmere/portraits/aldreth_female.jpg');
    this.load.image('corvane-male', '/assets/hollowmere/portraits/corvane_male.jpg');
    this.load.image('corvane-female', '/assets/hollowmere/portraits/corvane_female.jpg');
    this.load.image('independent-priest', '/assets/hollowmere/portraits/independent_priest.jpg');
    this.load.image('independent-woman', '/assets/hollowmere/portraits/independent_woman.jpg');
    for (const locationKey of LOCATION_KEYS) {
      this.load.image(`location-${locationKey}`, `/assets/hollowmere/locations/${locationKey}.png`);
    }
  }

  create(): void {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.setZoom(1.12);
    this.obstacles = this.physics.add.staticGroup();
    if (this.input.keyboard) {
      const key = (code: number) => this.input.keyboard!.addKey(code, false);
      this.keys = {
        up: [key(Phaser.Input.Keyboard.KeyCodes.W), key(Phaser.Input.Keyboard.KeyCodes.UP)],
        down: [key(Phaser.Input.Keyboard.KeyCodes.S), key(Phaser.Input.Keyboard.KeyCodes.DOWN)],
        left: [key(Phaser.Input.Keyboard.KeyCodes.A), key(Phaser.Input.Keyboard.KeyCodes.LEFT)],
        right: [key(Phaser.Input.Keyboard.KeyCodes.D), key(Phaser.Input.Keyboard.KeyCodes.RIGHT)],
        interact: key(Phaser.Input.Keyboard.KeyCodes.E),
      };
      this.keys.interact.on('down', () => {
        if (!this.inputCaptured && this.nearestAgent) {
          EventBus.emit('talk-agent', { agentKey: this.nearestAgent });
        }
      });
    }
    this.unlisten.push(
      EventBus.on('bootstrap', ({ map, game }) => this.bootstrap(map, game)),
      EventBus.on('game-state', (game) => this.applyState(game)),
    );
    window.addEventListener('hollowmere-input-focus', this.onInputFocus);
    document.addEventListener('focusin', this.onDomFocus);
    document.addEventListener('focusout', this.onDomFocus);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.cleanup, this);
    EventBus.emit('scene-ready', undefined);
  }

  override update(): void {
    if (!this.player || !this.keys) return;
    const body = this.player.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0);
    if (!this.inputCaptured) {
      if (this.keys.left.some((key) => key.isDown)) body.setVelocityX(-150);
      if (this.keys.right.some((key) => key.isDown)) body.setVelocityX(150);
      if (this.keys.up.some((key) => key.isDown)) body.setVelocityY(-150);
      if (this.keys.down.some((key) => key.isDown)) body.setVelocityY(150);
      body.velocity.normalize().scale(150);
    }
    this.player.setFlipX(body.velocity.x < 0);
    this.keepPlayerInsideLocation();
    this.syncPlayerMarker();
    this.updateProximity();
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    for (const dispose of this.unlisten) dispose();
    this.unlisten = [];
    window.removeEventListener('hollowmere-input-focus', this.onInputFocus);
    document.removeEventListener('focusin', this.onDomFocus);
    document.removeEventListener('focusout', this.onDomFocus);
  }

  private readonly onInputFocus = (event: Event) => {
    this.overlayCaptured = (event as CustomEvent<boolean>).detail;
    this.syncKeyboardCapture();
  };

  private readonly onDomFocus = () => {
    queueMicrotask(() => {
      this.domInputCaptured = shouldSuppressGameInput(document.activeElement);
      this.syncKeyboardCapture();
    });
  };

  private syncKeyboardCapture(): void {
    if (!this.input.keyboard) return;
    // Keep Phaser listening so key-up events cannot queue or leave a movement
    // key stuck. Movement and interaction are gated by inputCaptured instead.
    // The keys themselves are registered without browser-level capture, so
    // textarea input keeps Space, WASD, arrows, and E.
    this.input.keyboard.resetKeys();
  }

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
    this.add.image(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 'map-texture')
      .setDisplaySize(WORLD_WIDTH, WORLD_HEIGHT)
      .setTint(0x686b70)
      .setAlpha(0.32)
      .setDepth(-4);

    const ground = this.add.graphics();
    ground.fillStyle(0x0d0d12, 0.62).fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    ground.fillStyle(0x1f3850, 0.18).fillRect(0, 0, 260, WORLD_HEIGHT);
    ground.fillStyle(0x4a2c1e, 0.16).fillRect(940, 0, WORLD_WIDTH - 940, WORLD_HEIGHT);

    for (const location of map.locations) this.locations.set(location.key, worldPosition(location));
    const seen = new Set<string>();
    const roads: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
    for (const route of map.routes) {
      const key = [route.from, route.to].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      const from = this.locations.get(route.from), to = this.locations.get(route.to);
      if (from && to) roads.push({ from, to });
    }
    this.drawRoads(ground, roads);

    map.locations.forEach((location) => {
      const point = this.locations.get(location.key)!;
      const factionColor = location.controllingFactionKey === 'aldreth' ? 0x3b82f6
        : location.controllingFactionKey === 'corvane' ? 0xf97316 : 0x94a3b8;
      const halo = this.add.circle(point.x, point.y, LOCATION_RADIUS + 8, factionColor, 0.035)
        .setStrokeStyle(1, factionColor, 0.16)
        .setDepth(0);
      const marker = this.add.circle(point.x, point.y, LOCATION_RADIUS, 0x111116, 0.82)
        .setStrokeStyle(2, factionColor, 0.58)
        .setDepth(1)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => {
          if (this.state?.player.locationKey === location.key) {
            EventBus.emit('enter-location', { locationKey: location.key });
          } else {
            this.requestMove(location.key);
          }
        });
      marker.setData('locationKey', location.key);
      halo.setData('locationKey', location.key);
      const iconX = point.x - LOCATION_RADIUS * 0.72;
      const iconY = point.y - LOCATION_RADIUS * 0.72;
      this.add.circle(iconX, iconY, 18, 0x0d0d12, 0.96)
        .setStrokeStyle(1, factionColor, 0.42)
        .setDepth(18);
      this.add.image(iconX, iconY, `location-${location.key}`)
        .setDisplaySize(25, 25)
        .setDepth(19);
      const obstacle = this.add.rectangle(point.x, point.y - 7, 46, 46, 0x000000, 0);
      this.physics.add.existing(obstacle, true);
      this.obstacles?.add(obstacle);
      this.add.text(point.x, point.y + 40, location.name.toUpperCase(), {
        fontFamily: 'Georgia, serif', fontStyle: 'bold', fontSize: '11px', color: '#e8dcc8',
        backgroundColor: '#0d0d12ee', padding: { x: 8, y: 4 }, letterSpacing: 1.2,
      }).setOrigin(0.5).setDepth(32);
      const roster = this.add.text(point.x, point.y - 72, '', {
        align: 'center', fontFamily: 'ui-monospace, monospace', fontSize: '10px',
        color: '#d8cebd', backgroundColor: '#0d0d12f7', padding: { x: 9, y: 7 },
        lineSpacing: 3,
      }).setOrigin(0.5, 1).setDepth(46).setVisible(false);
      marker
        .on('pointerover', () => roster.setVisible(true))
        .on('pointerout', () => roster.setVisible(false));
      this.locationMarkers.set(location.key, { marker, halo, roster });
    });
  }

  private drawRoads(
    graphics: Phaser.GameObjects.Graphics,
    roads: readonly { from: { x: number; y: number }; to: { x: number; y: number } }[],
  ): void {
    const drawSolid = (width: number, color: number, alpha: number) => {
      graphics.lineStyle(width, color, alpha);
      for (const { from, to } of roads) graphics.lineBetween(from.x, from.y, to.x, to.y);
    };
    drawSolid(18, 0x111116, 0.88);
    drawSolid(13, 0x4a4136, 0.85);
    graphics.lineStyle(8, 0x6b5c48, 0.42);
    for (const { from, to } of roads) {
      const length = Phaser.Math.Distance.Between(from.x, from.y, to.x, to.y);
      for (let distance = 0; distance < length; distance += 56) {
        const start = distance / length;
        const end = Math.min(distance + 34, length) / length;
        graphics.lineBetween(
          Phaser.Math.Linear(from.x, to.x, start), Phaser.Math.Linear(from.y, to.y, start),
          Phaser.Math.Linear(from.x, to.x, end), Phaser.Math.Linear(from.y, to.y, end),
        );
      }
    }
    drawSolid(2, 0x8c7f6b, 0.3);
  }

  private createPlayer(): void {
    this.playerMarker = this.add.ellipse(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 46, 24, 0xf0c45c, 0.18)
      .setStrokeStyle(3, 0xffdb78, 1).setDepth(18);
    this.player = this.physics.add.sprite(WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 'characters', PLAYER_FRAME)
      .setScale(2.65).setDepth(20).setCollideWorldBounds(true);
    this.playerLabel = this.add.text(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 35, 'YOU', {
      fontFamily: 'ui-monospace, monospace', fontStyle: 'bold', fontSize: '12px',
      color: '#171208', backgroundColor: '#ffdb78', padding: { x: 7, y: 3 },
    }).setOrigin(0.5).setDepth(40);
    if (this.obstacles) this.physics.add.collider(this.player, this.obstacles);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
  }

  private syncPlayerMarker(): void {
    if (!this.player) return;
    this.playerMarker?.setPosition(this.player.x, this.player.y + 10);
    this.playerLabel?.setPosition(this.player.x, this.player.y - 35);
  }

  private applyState(game: GameSnapshot): void {
    if (!this.mapData || !this.player?.active || !this.player.body) return;
    const previousWorld = this.state?.world.worldId;
    this.state = game;
    const playerLocation = this.locations.get(game.player.locationKey);
    const locationChanged = this.authoritativePlayerLocation !== game.player.locationKey;
    if (playerLocation && (!this.playerPlaced || previousWorld !== game.world.worldId || locationChanged)) {
      this.player.setPosition(playerLocation.x, playerLocation.y + 58);
      const body = this.player.body as Phaser.Physics.Arcade.Body;
      body.setVelocity(0);
      this.playerPlaced = true;
      this.authoritativePlayerLocation = game.player.locationKey;
    }
    this.updateNavigationMarkers();
    this.syncAgents(game.agents);
    this.updateLocationRosters(game);
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
        const color = FACTION_TINT[agent.factionKey] ?? 0x94a3b8;
        const portrait = this.add.image(0, 0, this.circularPortraitFor(agent)).setDisplaySize(36, 36);
        const frame = this.add.circle(0, 0, 21, 0x111116, 0.92)
          .setStrokeStyle(2, color, 0.88);
        sprite = this.add.container(target.x, target.y, [frame, portrait])
          .setSize(46, 46).setDepth(15).setInteractive({ useHandCursor: true });
        sprite.setData('locationKey', agent.locationKey);
        sprite.on('pointerdown', () => EventBus.emit('select-agent', { agentKey: agent.agentKey }));
        this.agents.set(agent.agentKey, sprite);
      } else if (sprite.getData('locationKey') !== agent.locationKey) {
        sprite.setData('locationKey', agent.locationKey);
        this.tweens.add({
          targets: sprite,
          x: target.x,
          y: target.y,
          duration: 900,
          ease: 'Sine.easeInOut',
        });
      } else {
        sprite.setPosition(target.x, target.y);
      }
      if (agent.status === 'dead' || agent.status === 'detained') sprite.setAlpha(0.4);
      else sprite.setAlpha(1);
    }
    for (const [key, sprite] of this.agents) {
      if (active.has(key)) continue;
      sprite.destroy();
      this.agents.delete(key);
    }
  }

  private portraitFor(agent: AgentView): string {
    const variant = FEMALE_AGENT_KEYS.has(agent.agentKey) ? 'female' : 'male';
    if (agent.factionKey === 'aldreth') return `aldreth-${variant}`;
    if (agent.factionKey === 'corvane') return `corvane-${variant}`;
    return variant === 'male' ? 'independent-priest' : 'independent-woman';
  }

  private circularPortraitFor(agent: AgentView): string {
    const sourceKey = this.portraitFor(agent);
    const circularKey = `${sourceKey}-circle`;
    if (this.textures.exists(circularKey)) return circularKey;
    const texture = this.textures.createCanvas(circularKey, 36, 36);
    if (!texture) return sourceKey;
    const context = texture.getContext();
    context.save();
    context.beginPath();
    context.arc(18, 18, 18, 0, Math.PI * 2);
    context.clip();
    const source = this.textures.get(sourceKey).getSourceImage() as HTMLImageElement;
    const crop = Math.min(source.naturalWidth || source.width, source.naturalHeight || source.height);
    const left = ((source.naturalWidth || source.width) - crop) / 2;
    const top = ((source.naturalHeight || source.height) - crop) / 2;
    context.drawImage(source, left, top, crop, crop, 0, 0, 36, 36);
    context.restore();
    texture.refresh();
    return circularKey;
  }

  private updateLocationRosters(game: GameSnapshot): void {
    for (const [locationKey, { roster }] of this.locationMarkers) {
      const current = locationKey === game.player.locationKey;
      const reachable = current || (this.mapData && areAdjacent(this.mapData, game.player.locationKey, locationKey));
      const people = rankLocationAgents(game.agents, locationKey, game.world.seed, game.world.day);
      roster.setText([
        current ? 'OPEN LOCATION' : reachable ? 'CLICK TO TRAVEL' : 'BEYOND THIS ROAD',
        people.length ? 'WHO IS HERE' : 'NO ONE HERE',
        ...people.map((agent) => agent.name),
      ]);
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
      const label = this.add.text(point.x, point.y - 78, `summons · t${hearing.dueTick}`, {
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
      this.nearestAgent = nearest?.key ?? null;
    }
  }

  private keepPlayerInsideLocation(): void {
    if (!this.player || !this.state) return;
    const anchor = this.locations.get(this.state.player.locationKey);
    if (!anchor) return;
    const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, anchor.x, anchor.y);
    if (distance <= LOCAL_MOVEMENT_RADIUS) return;
    const angle = Phaser.Math.Angle.Between(anchor.x, anchor.y, this.player.x, this.player.y);
    this.player.setPosition(
      anchor.x + Math.cos(angle) * LOCAL_MOVEMENT_RADIUS,
      anchor.y + Math.sin(angle) * LOCAL_MOVEMENT_RADIUS,
    );
  }

  private requestMove(locationKey: string): void {
    if (!this.state || !this.mapData || this.inputCaptured) return;
    if (this.state.world.status !== 'active' || this.state.player.pendingMove) return;
    if (!areAdjacent(this.mapData, this.state.player.locationKey, locationKey)) return;
    EventBus.emit('request-move', { locationKey });
  }

  private updateNavigationMarkers(): void {
    if (!this.state || !this.mapData) return;
    for (const [locationKey, objects] of this.locationMarkers) {
      const current = locationKey === this.state.player.locationKey;
      const adjacent = areAdjacent(this.mapData, this.state.player.locationKey, locationKey);
      const available = adjacent && !this.state.player.pendingMove && this.state.world.status === 'active';
      objects.marker.setStrokeStyle(
        current ? 4 : available ? 3 : 2,
        current ? 0xffdb78 : available ? 0xd6b65d : 0x59616b,
        current || available ? 0.95 : 0.36,
      );
      objects.halo.setAlpha(current ? 0.14 : available ? 0.09 : 0.025);
    }
  }
}
