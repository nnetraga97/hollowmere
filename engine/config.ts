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

  /** Chance a retelling is reworded. Each distortion costs one model call. */
  distortionChance: fromPercent(15) as Fixed,

  /**
   * Talking requires proximity. Agents elsewhere in town can still hear things
   * second-hand, but far less readily — this is what makes the tavern and the
   * market matter as rumor hubs.
   */
  remoteTransmissionFactor: fromPercent(12) as Fixed,

  /** Trust below this and the listener does not even repeat it. */
  minTrustToTransmit: fromPercent(15) as Fixed,
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

  /** Consecutive ticks the peace conditions must hold before peace is declared. */
  peaceStreakRequired: 12,

  /** Peace requires global tension below this. */
  peaceMaxTension: fromPercent(25) as Fixed,

  /** Peace requires no hostile rumor hotter than this. */
  peaceMaxRumorHeat: fromPercent(30) as Fixed,
} as const;

export const RETRIEVAL = {
  /** Memories handed to cognition per think. */
  topK: 8,
  /** Rows drawn from the ANN index before exact re-ranking. */
  candidates: 48,
} as const;
