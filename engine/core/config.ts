/**
 * Simulation tuning constants.
 *
 * Everything here is fixed point on SCALE = 10000. These are collected in one
 * place because balancing the town is an empirical exercise: the unattended run
 * must reach war within 192–288 ticks, and that outcome is sensitive to the
 * interplay between how fast rumors spread, how readily people believe them,
 * and how slowly tension bleeds off. Tuning against the headless harness means
 * editing this file, not hunting through the rule modules.
 */

import { fromPercent, type Fixed } from './fixedpoint.ts';

export const GOSSIP = {
  /** Baseline chance that a holder passes a rumor on in a given tick. */
  baseTransmission: fromPercent(35) as Fixed,

  /** Rumors colder than this stop spreading and are ignored by the tick. */
  minHeat: fromPercent(5) as Fixed,

  /**
   * Hard ceiling on transmissions per tick. Without it a single very hot rumor
   * in a crowded market can touch most of the town in one tick, which both
   * looks wrong and produces an unbounded write burst.
   */
  maxTransmissionsPerTick: 60,

  /** Chance a retelling is extractively reworded by deterministic rules. */
  distortionChance: fromPercent(15) as Fixed,

  /**
   * Talking requires proximity. Agents elsewhere in town can still hear things
   * second-hand, but far less readily — this is what makes the tavern and the
   * market matter as rumor hubs.
   */
  remoteTransmissionFactor: fromPercent(12) as Fixed,

  /** Trust below this and the listener does not even repeat it. */
  minTrustToTransmit: fromPercent(15) as Fixed,

  /** A player-invented story dies with a listener who affirmatively rejects it. */
  playerRumorMinConfidenceToTransmit: fromPercent(10) as Fixed,

  /**
   * Ticks before someone can be told the same thing again.
   *
   * Without re-hearing, belief cannot harden: one retelling moves a listener a
   * fraction of the way toward believing, and if that is the only time they
   * ever hear it, nobody in town ever reaches the confidence that makes them
   * act. Real rumors do not work by single exposure — they work by repetition
   * from several mouths — and the whole misinformation thesis depends on that.
   * Eight ticks is two minutes of play: long enough that a conversation is not
   * one person saying the same sentence four times.
   */
  retellCooldown: 8,

  /**
   * How many holders of one rumor do the telling in a tick. The talkative go
   * first. This bounds the work per rumor — the listener query runs once per
   * holder — and keeps a rumor everyone has heard from costing thirty queries a
   * tick to make no progress.
   */
  maxTellersPerRumor: 12,
} as const;

export const BELIEF = {
  /**
   * How readily a listener accepts a claim, by their relationship to the person
   * it is about. People defend their own and believe the worst of rivals — this
   * asymmetry is what turns a single accusation into two hardened camps rather
   * than one shared conclusion.
   */
  alignmentSameFaction: fromPercent(30) as Fixed,
  alignmentUnaligned: fromPercent(60) as Fixed,
  alignmentRivalFaction: fromPercent(100) as Fixed,

  /** Ceiling on how far one retelling can move a listener's confidence. */
  maxShiftPerTransmission: fromPercent(30) as Fixed,

  /** Confidence above which an agent acts as though the claim were true. */
  actionableConfidence: fromPercent(45) as Fixed,

  /**
   * How strongly belief in a hostile claim sours the listener's feeling toward
   * its subject. Belief and sentiment are separate: you can be convinced
   * someone did it and still not hate them.
   */
  sentimentTransfer: fromPercent(40) as Fixed,
} as const;

export const TENSION = {
  /** Added when a hostile claim crosses the line between the two houses. */
  crossFactionAccusation: fromPercent(1.2) as Fixed,

  /** Added when an agent's belief in a severe claim first becomes actionable. */
  beliefHardens: fromPercent(0.8) as Fixed,

  /** Removed by a reconciliation act. */
  reconciliation: fromPercent(3) as Fixed,

  /**
   * Stage thresholds. Crossing one is one-way: stages never reverse, so the
   * town can be slowed but not rewound.
   */
  stageThresholds: {
    suspicion: fromPercent(15) as Fixed,
    accusations: fromPercent(35) as Fixed,
    trials: fromPercent(58) as Fixed,
    first_blood: fromPercent(78) as Fixed,
    war: fromPercent(94) as Fixed,
  },

  /** Added when a believer says a cross-house accusation out loud. */
  publicAccusation: fromPercent(2.2) as Fixed,

  /**
   * Ceiling on how far tension can move in one tick.
   *
   * Individual events are priced by how bad they are, but a town's mood does
   * not turn over in fifteen in-world minutes however much is said. Without the
   * cap, one very hot rumor reaching thirty people in a single tick takes the
   * town from calm to war inside a minute of play — which is unreadable on
   * screen and makes every intervention pointless. The cap is what stretches
   * the arc across the canonical 192–288 ticks.
   */
  maxRisePerTick: fromPercent(0.45) as Fixed,

  /** Consecutive ticks the peace conditions must hold before peace is declared. */
  peaceStreakRequired: 12,

  /** Peace requires global tension below this. */
  peaceMaxTension: fromPercent(25) as Fixed,

  /** Peace requires no hostile rumor hotter than this. */
  peaceMaxRumorHeat: fromPercent(30) as Fixed,
} as const;

export const ACCUSATION = {
  /**
   * How likely a believer is to say it out loud this tick, by how far the town
   * has already gone. This is the self-reinforcing loop: accusations raise
   * tension, tension advances the stage, and a further stage makes everyone
   * readier to accuse. It is also why an unattended town does not simply settle
   * once everyone has heard everything.
   */
  chanceByStage: {
    calm: 0 as Fixed,
    suspicion: fromPercent(3) as Fixed,
    accusations: fromPercent(7) as Fixed,
    trials: fromPercent(11) as Fixed,
    first_blood: fromPercent(16) as Fixed,
    war: fromPercent(16) as Fixed,
  },

  /** Ceiling per tick, so a town of thirty believers cannot all speak at once. */
  maxPerTick: 3,

  /** How much an accusation puts a rumor back in circulation. */
  reheat: fromPercent(25) as Fixed,
} as const;

export const COGNITION = {
  /** Ticks between cognition rounds. 6 ticks × 5 s = 30 s of real time. */
  intervalTicks: 6,
  /** Agents who think in a normal round. */
  spotlightMax: 2,
  /** Agents who think when something has just happened to them. */
  burstMax: 6,
  /**
   * Inference calls a single world may make before cognition degrades to the
   * deterministic path. A 30-minute world at two thinks per 30 s needs ~120;
   * the headroom covers conversation and reflection.
   */
  callBudget: 900,
  /**
   * How long an agent keeps walking toward what they decided. Beyond this the
   * plan is stale and the day's routine takes over again — otherwise one
   * decision at dawn would keep someone out of their workshop all day.
   */
  planHorizonTicks: 12,

  /** Importance assigned to a memory an agent forms by thinking about it. */
  reflectionImportance: fromPercent(70) as Fixed,
  observationImportance: fromPercent(45) as Fixed,
} as const;

export const CONVERSE = {
  /** How hot a rumor the player's accusation starts at. */
  accusationHeat: fromPercent(75) as Fixed,

  /** Novel lies start cooler than an already-circulating accusation. */
  playerRumorHeat: fromPercent(48) as Fixed,

  /** A convincing forged record may add at most this much apparent support. */
  manufacturedEvidenceHeatBoost: fromPercent(28) as Fixed,

  /**
   * How much weight one player utterance carries against a townsperson's
   * belief. Higher than a single retelling — the player is standing in front of
   * them — but far short of decisive, so persuasion takes a conversation rather
   * than a sentence.
   */
  persuasion: fromPercent(160) as Fixed,

  /** How much heat a reconciliation takes out of the rumors that agent carries. */
  rumorCooling: fromPercent(22) as Fixed,

  sentimentWarming: fromPercent(8) as Fixed,
  sentimentSmalltalk: fromPercent(2) as Fixed,
  threatTension: fromPercent(1.5) as Fixed,

  reputationForAccusing: fromPercent(6) as Fixed,
  reputationForPeacemaking: fromPercent(5) as Fixed,
} as const;

export const SCHEME = {
  strategyIntervalTicks: 12,
  tacticDurationTicks: 6,
  rumorHeat: fromPercent(72) as Fixed,
} as const;

export const DIALOGUE = {
  intervalTicks: 6,
  trustShift: fromPercent(2) as Fixed,
  /** A direct exchange is salient, but contributes only half-weight to reflection. */
  memoryImportance: fromPercent(60) as Fixed,
  reflectionContribution: fromPercent(30) as Fixed,
} as const;

export const HEARING = {
  travelSlackTicks: 2,
  holdTicks: 6,
} as const;

export const TIME = {
  /** Ticks per in-world phase. Four phases × 24 = 96 ticks per in-world day. */
  ticksPerPhase: 24,
  /** Hard ceiling on an unattended run: 360 ticks is 30 minutes at 1×. */
  maxTicks: 360,
} as const;

export const RETRIEVAL = {
  /** Memories handed to cognition per think. */
  topK: 8,
  /** Rows drawn from the ANN index before exact re-ranking. */
  candidates: 48,
} as const;
