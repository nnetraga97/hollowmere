# Hollowmere altered-notebook implementation plan

**Date:** 2026-07-30
**Source:** `docs/superpowers/specs/2026-07-30-hollowmere-lore-claims-design.md`

## Objective

Replace the old grain-audit case with the independent-prince altered-notebook
case while reusing Hollowmere's existing instigator, belief, gossip, provenance,
hearing, replay, and ending machinery.

This is a vertical feature migration, not an engine rewrite.

## Simplicity decisions

1. Ship six coherent case profiles, one for each eligible instigator. Each
   profile fixes its motive, notebook method, murder location, tampering timing,
   and evidence witnesses. The seed varies the instigator and framed target.
2. Aldreth culprits frame Aldreth's rival, Corvane; Corvane culprits frame
   Aldreth; Ansel and Ambrose may frame either side.
3. Keep one stable claim catalog with closed `{target}`, `{targetHouse}`, and
   `{instigator}` substitutions resolved once during world creation.
4. Use the existing `inquire` act to discover case evidence. Do not build a new
   search, inventory, or evidence-interaction engine.
5. Keep the current debug UI. Filter locked claims, label claim kinds and evidence
   roles, and do not add a new player-knowledge permission system.
6. Use one generic deterministic case solver in tests instead of hand-authoring a
   transcript for every seed.
7. Supersede the uncommitted `opening.beliefSets` experiment. Preserve its useful
   prose/UI work, but remove that parallel selection mechanism rather than
   supporting two opening-belief systems.

## Existing systems retained

- `world_culprit`, goals, scheme state, strategy calls, and authored fallback
- private strategy/public speech separation
- signed belief storage and belief history
- rumor diffusion and append-only `world_rumor_tellings`
- NPC dialogue and player conversation
- hearings, commitments, movement, and audience belief effects
- cognition recording, rewind, and replay
- escalation, war, peace, detention, and world lifecycle
- player-created rumors and manufactured evidence

## 1. Scenario and case contracts

Extend the existing culprit definition into a case profile containing:

- fixed motive;
- allowed framed targets;
- fixed notebook method, murder location, and tampering timing;
- comparator, access, opportunity, and first-recipient agent keys.

Add closed claim metadata:

- `kind: fact | interpretation | accusation`;
- `textTemplate` or static `text`;
- `subjectSlot: target | targetHouseLeader | instigator | fixed agent`;
- `initiallyLocked`.

Add opening relationship overrides for Rowan and Caleb. Store them in the
existing scenario-version opening JSON rather than adding another template table.

Replace `selectCulprit` plus `selectOpeningBeliefSet` with `selectCase`. It hashes
the seed with the stable authored scenario version/checksum—not the database's
random scenario-version UUID—and consumes no simulation RNG.

Persist selected hidden case truth on `world_culprit` and instantiate final claim
text, subjects, truth, and lock state once.

Use the existing template tables with these narrow persistence changes:

- `claim_templates`: kind, nullable `text_template`, nullable fixed subject,
  nullable `subject_slot`, and `initially_locked`;
- `world_claims`: kind and `initially_locked` beside the resolved text/subject;
- `culprit_templates.case_profile JSONB` and `world_culprit.case_state JSONB`;
- `world_case_evidence`: stable `(world, role, holder, claim, evidence kind)`
  definitions with no event/telling UUID;
- `world_player_evidence.role`, plus a partial unique index on
  `(world_id, player_id, role) WHERE role IS NOT NULL`. Retain the existing
  ordinary-evidence uniqueness constraint because nullable provenance columns
  have different semantics.

## 2. Scenario content migration

- Make Edryc's faction `unaligned`, keep the stable `edryc_aldreth` key and his
  sibling relationship with Maren, and rewrite his public persona.
- Replace the current five culprits with Sella, Rusk, Alric, Hollis, Ansel, and
  Ambrose.
- Replace grain, poison, sickness, and sleeping-draught claims with the notebook,
  target, House escalation, night-traffic, witness, authority-action, and two
  resolution claims.
- Remove `opening.beliefSets`.
- Replace the granary-fire rumor and fixed Corvane schemes with the selected
  central accusation and concrete obstruction/escalation actions.
- Migrate romance content and tests that reference removed claim keys.
- Bump the scenario version after replacing the in-progress `hollowmere-v3`
  belief-set content.
- Do not give culprit Alric both `protect_corvane` and `provoke_war`; suppress his
  ordinary House-protection goal when his selected case profile is active.

## 3. Initial relationships and beliefs

Apply relationship defaults exactly as today, then apply authored opening
overrides. Rewind must restore the same overrides.

Seed only beliefs justified by the selected case:

- the framed target and a plausible small cohort of people with reason to doubt
  the accusation deny it; the culprit is not made the uniquely identifiable
  second denier;
- selected witnesses believe their own atomic observations;
- Maren, Alric, Ansel, Ambrose, and Veranne know Edryc investigated both Houses
  fairly;
- the opening accusation begins with its selected recipient.

Let existing gossip, faction alignment, trust, and credulity create the wider
belief distribution. Do not author another random belief bundle.

## 4. Evidence roles and acquisition

Add a closed `role` column to `world_player_evidence`; include it in evidence
uniqueness. `kind` remains the acquisition channel and `role` states what the row
proves.

Persist one case evidence definition per role:

- `tamper_sign`;
- `tamper_comparator`;
- `culprit_access`;
- `murder_opportunity`;
- `escalation_provenance`.

At opening, grant the physical tampering sign and record the culprit's first
accusation telling to the selected recipient. On every `inquire`, even when the
player names no claim, match the current NPC against undiscovered case evidence
definitions, record the evidence, unlock its clue claim, and immediately recheck
exposure. Ordinary provenance disclosure still requires a named claim.

Resolve event/telling UUIDs only when evidence is acquired. Definitions refer to
stable holder/claim identity so rewind can delete and recreate history safely.

Replace `RECORD_WITNESSES` and global evidence counts with selected case roles.

## 5. Claim behavior and exposure

- Facts use maximum receptiveness but no faction discount, sentiment transfer,
  accusation tension, or accusation-loop eligibility.
- Interpretations use normal belief alignment but do not enter the accusation
  loop.
- Accusations retain current alignment, sentiment, tension, gossip, and hearing
  behavior.
- Both resolution claims may be disclosed and heard regardless of the
  instigator's faction, so Ansel and Ambrose remain solvable. They are excluded
  from the automatic House-accusation tension loop.
- Existing player `dispute` and `defend` behavior remains unchanged.

The five genuine, non-manufactured roles unlock:

- `instigator_altered_notebook`;
- `instigator_murdered_for_war`.

Only the full verdict can end the world. It requires Veranne plus the first
living, non-culprit authority from each ordered House list:

- Aldreth: Maren, Sella, Rusk;
- Corvane: Alric, Rowan, Hollis.

Implement validator selection and the unavailable-authority fallback directly in
`evaluateExposureEnding`; the current trigger DSL cannot express culprit-aware
fallbacks. If Veranne or either House has no valid living, non-culprit authority,
take the authored war-ending failure route rather than leaving the world active
and unwinnable.

Rewind restores every claim from `initiallyLocked` and re-creates derived opening
evidence, relationship overrides, beliefs, and the first accusation telling from
the persisted case. Case state and case-evidence definitions are persistent world
truth and stay outside `HISTORY_TABLES`; acquired player evidence remains history.
All recreated opening events/tellings share rewind's single `createSeq(1)` stream.

## 6. API and UI

- Add claim kind and evidence role to player/debug contracts.
- Filter locked claims from the agent belief-detail query.
- Label private convictions as debug information. Do not add a player-knowledge
  permission system while this remains the debug client.
- Group the existing evidence ledger by proof role while retaining acquisition
  kind, credibility, and manufactured-state display.
- Keep the truth drawer debug-only and extend it with selected case fields.

## 7. Verification

1. Scenario validation rejects missing targets, subjects, witnesses, evidence
   roles, or invalid faction direction.
2. Pure tests prove selection is stable across authored array order and consumes
   no simulation RNG.
3. Every authored case profile instantiates with the correct Edryc faction,
   target direction, resolved claim text, five distinct roles, and lock state.
4. A generic scripted solver acquires all five roles and reaches exposure before
   first blood without speaking to the culprit for every profile/target variant.
5. Removing any role prevents exposure.
6. Later retellings do not hide the instigator's first accusation telling.
7. Ansel and Ambrose verdicts can pass through a hearing despite being unaligned;
   resolution claims never create House-accusation tension.
8. Alric, Sella, or Rusk as culprit never appears in its own validator slot.
9. Missing/dead/culprit-only authorities deterministically produce the fallback
   war ending rather than an unwinnable active world.
10. Rewind reproduces case truth, opening beliefs, relationship overrides, and
   locks.
11. Same seed plus stable scenario version selects the same case even when the
   database scenario-version UUID changes.
12. Existing gossip, dialogue, hearing, deception, romance, replay, and canonical
   escalation tests remain green after claim-key migration.
13. Run scenario tests, engine typecheck, web typecheck, database-backed tests,
   and `git diff --check`.

## Explicit non-goals

- no new scheduler or tick architecture;
- no new generic inventory/search system;
- no freeform model-authored claims or evidence;
- no second belief engine;
- no additional instigator motives or notebook methods in this release;
- no redesign of romance, movement, hearings, or the town map.
