# Hollowmere: the altered notebook case

**Lore and claims design spec — 2026-07-30**

This spec replaces the grain-audit murder story and culprit roster in
`2026-07-25-instigator-design.md`. The older spec remains authoritative only for
engine mechanisms that this document does not change, such as recorded model
decisions, private strategy versus public speech contexts, rumor provenance,
hearings, and deterministic replay.

The governing constraint is **Simplicity First**: one murder, one deception, one
coherent case selection, and one fair route from physical evidence to exposure.
Variation must deepen that case rather than create parallel plots.

---

## 1. The story

Prince Edryc was born an Aldreth and remains Maren's elder brother, but taking
office as Prince of Hollowmere required him to renounce House membership. He is
the independent guarantor of the truce, formally unaligned with both Houses. The
existing `edryc_aldreth` agent key may remain for migration stability, while his
faction becomes `unaligned` and his public name becomes Prince Edryc.

Edryc spent his last days privately investigating prohibited night traffic
involving both Houses. He was fair, followed evidence across faction lines, and
kept an ordinary personal notebook of names, movements, interviews, and records.

Father Ansel is the last publicly known person to have seen Edryc alive. Someone
meets Edryc afterward, murders him, alters the notebook, and leaves or stages his
body at the chapel steps. The notebook is found on the body. Its binding, missing
leaves, or changed writing makes interference visible, but it does not reveal the
original content or the person responsible.

The murderer uses genuine entries and a real House secret to direct blame at
House Aldreth, House Corvane, or one of their people. If a person is accused,
their House's protection, denial, and concealment turn the personal accusation
into a House conflict. The murderer deliberately feeds the accusation to the
rival House until anger on one side and self-protection on the other become war.

The murderer, notebook tamperer, and instigator are always the same person. The
framed target is always innocent of Edryc's murder. Neither House collectively
ordered it.

The player can discover three larger truths:

1. The notebook was altered in a specific way.
2. One person had both murder opportunity and content-altering access.
3. That person deliberately manufactured and spread the accusation.

The notebook begins the investigation. It never solves it.

---

## 2. Narrative invariants

These facts do not vary by seed:

- Edryc was genuinely fair.
- Edryc is Aldreth-born and Maren's brother, but his princely office is formally
  independent; his simulation faction is `unaligned`.
- Edryc was murdered.
- His personal evidence notebook is found on his body.
- The notebook visibly shows tampering.
- The same person murdered Edryc, altered the notebook, and instigated the false
  accusation.
- The instigator's fixed objective is war between Aldreth and Corvane.
- The framed target is innocent of the murder and never is the instigator.
- An Aldreth instigator frames Corvane. A Corvane instigator frames Aldreth. An
  unaligned instigator may frame either side. The accusation is always promoted
  first to the rival House, so it creates inter-House conflict rather than an
  internal succession scandal.
- Neither House collectively ordered or approved the murder. A House leader may
  be the individual culprit without converting the act into collective House
  authorization.
- Ansel is the last publicly known person to see Edryc alive. The instigator is
  the actual last person to encounter him.
- Tampering happens after Edryc dies and before Ansel publicly reports finding
  the body.
- Only the instigator alters notebook content in that interval.
- Exactly one primary tampering method is used per world.
- Every required clue exists independently of model-selected character actions.
  Model decisions may create additional evidence or obstruction, but cannot make
  the authored core trail unwinnable.
- Rules own truth, provenance, evidence consequences, belief effects, tension,
  and endings. The model chooses only allowlisted character actions, once per
  world, and those decisions are persisted for replay.
- Private culprit context never enters a public speech prompt.
- World generation consumes no simulation RNG.

---

## 3. One case selection, not independent random systems

The current culprit hash and independent `opening.beliefSets` hash can select
incoherent combinations. The replacement is one deterministic case-selection
operation.

### Fixed content

- The story and invariants above
- Edryc's fairness
- The night-traffic inquiry
- The six eligible instigators
- The opposing-House framing rule
- The three notebook methods
- The five evidence roles
- The claim taxonomy and escalation chain

### Seed-selected case truth

`selectCase(seed, scenarioVersion)` selects:

- instigator;
- framed House: Aldreth or Corvane, constrained by instigator faction;
- target mode: House or individual;
- framed individual when applicable;
- one compatible notebook method;
- one compatible murder location;
- tampering before or after the body is staged, always before discovery;
- the bounded true observation held by each selected witness.

The instigator is selected first. Domain-separated hashes select only from that
instigator profile's allowed targets, methods, locations, and witness variants.
These are not free axes: every combination inside a profile must pass the
compatibility rules in section 14.

For an affiliated instigator, the framed House is derived as the opposing House.
For Ansel or Ambrose, the seed selects either House. The accusing House is always
the other belligerent House.

`bodyMoved` is derived rather than selected:

```text
bodyMoved = murderLocation != chapel
```

The opening belief state derives from the completed case. It is not another
seed-selected bundle.

### Model-selected actions

After case truth exists, the model may choose from bounded actions such as:

- Ansel opened, moved, or left the notebook;
- Ambrose omitted, delayed, contradicted, or accurately reported a finding;
- Veranne sealed, delayed, accepted, or rejected a piece of evidence;
- a House leader protected a witness, concealed a real secret, or disclosed it;
- the instigator selected an eligible listener, posture, and accusation tactic.

Each option has a rule-authored consequence. An option without an observable
consequence does not belong in an allowlist. These actions may change the social
route through the case but not the underlying answer or required clue existence.

---

## 4. The costly truth shared by both Houses

Edryc was investigating two sides of the same truce violation, not two unrelated
conspiracies:

- **Aldreth:** arms were landed secretly at Sella Dorn's yard, and Rusk Baelen
  kept cargo out of the customs record.
- **Corvane:** armed retainers were moved through the Aldreth-controlled harbour
  after curfew, and Hollis Barrow suppressed the movement record.
- **Rowan and Caleb:** Rowan was at the quay on Corvane business. Caleb, an
  Aldreth ferryman, enabled or witnessed the passage. Rowan's silence protects
  Caleb from punishment by both Houses while also concealing Corvane's breach.

This supplies either innocent accused side with a genuine reason to lie. Corvane
can deny murder while concealing night movement, suppressed records, Rowan's
presence, and Caleb's involvement. Aldreth can deny murder while concealing the
arms landing and missing customs entries. Those lies are suspicious but do not
make either House guilty of Edryc's death.

Edryc's pursuit of both violations establishes his fairness and gives characters
from both Houses reasons to manipulate his reputation after death. No poisoned
grain, flour shortage, or separate grain-profit conspiracy remains.

The Rowan-Caleb bond is authored as a relationship override. Default rival-
faction trust is insufficient to support Rowan accepting danger for Caleb.

---

## 5. Instigator profiles and motives

Version 1 gives each candidate one motive. Same-candidate motive variation is
deferred until play demonstrates that it adds more than combinatorics.

| Instigator | Motive for war | Allowed notebook methods | Allowed murder locations |
|---|---|---|---|
| **Sella Dorn** | War turns her illegal arms landings into necessary House defence and saves her yard from seizure. | reordered, removed | shipyard, chapel |
| **Rusk Baelen** | War destroys the neutral audit and makes missing cargo records leverage rather than evidence against him. | removed, changed | quay, chapel |
| **Lord Alric Corvane** | He believes Edryc's fair judgment will strip Corvane of standing; war now is his only path to preserve the dynasty. | reordered, changed | high_row, chapel |
| **Hollis Barrow** | Acting without Alric's order, he starts war to dissolve the magistrate's authority before Corvane's truce violation ruins the House. | reordered, changed | high_row, chapel |
| **Father Ansel** | He allowed covert House handovers near chapel ground because he believed compromise kept blood off the streets. Edryc's inquiry would expose him as a witness and enabler; in panic, he chooses open conflict over the hidden violence he can no longer contain. | removed, changed | chapel |
| **Ambrose Kyte** | He treated people injured during the covert movements and falsified the medical record to preserve the truce. Edryc found the discrepancy; war would recast Ambrose's betrayal as wartime necessity and destroy the inquiry. | removed, changed | high_row, chapel |

Allowed values are authoring limits, not mandates that every combination ship.
If a method/location pair cannot support all five evidence roles, validation
rejects it or the profile removes the combination.

### Framed target pool

The selected target belongs to the framed House and never is the instigator:

- **Aldreth:** House Aldreth, Lady Maren Aldreth, Sella Dorn, or Rusk Baelen.
- **Corvane:** House Corvane, Lord Alric Corvane, Rowan Corvane, or Hollis Barrow.

Profile constraints always remove the culprit and any semantically invalid
target before hashing.

---

## 6. Murder night and notebook custody

The order is stable even when locations vary:

1. Ansel sees Edryc alive and later becomes the last publicly known witness.
2. The instigator encounters Edryc afterward.
3. The instigator murders him at the selected location.
4. If the location is not the chapel, the instigator moves the body to the chapel
   steps.
5. The instigator alters the notebook either at the murder location or after
   staging the body.
6. The instigator leaves the body and notebook.
7. If Ansel is innocent, he finds the body after the instigator leaves. If Ansel
   is guilty, he stages his own discovery.
8. Ansel may open, move, or leave the notebook. His handling may explain surface
   marks but never the content alteration.
9. Ambrose examines the body after the alarm.
10. Veranne takes official custody after Ambrose's examination.

Any account contradicting this order is a belief, lie, or mistake rather than
world truth.

---

## 7. Notebook methods and fair breadcrumbs

Every method provides three notebook links. The physical sign proves tampering,
the comparator proves what cannot be original, and access evidence connects the
method to a possible tamperer. None solves the case alone.

### Reordered pages

- **Physical sign:** cut or loosened binding, resewn thread, and folio marks that
  no longer follow their internal sequence.
- **Comparator:** dates, tides, or cross-references conflict with the displayed
  order. Tobias's tide tables or another retained independent record establish
  the impossible sequence.
- **Access:** a witness or durable record places the instigator with the notebook
  during an interval and at a workspace with enough light and time to unbind it.

### Removed pages

- **Physical sign:** torn or cut leaf stubs, a wrong leaf count, or an explicit
  cross-reference to a missing folio.
- **Comparator:** a non-culprit witness holds an earlier copy, quotation, or
  independent record of the missing content. Merely seeing Edryc write does not
  reconstruct what he wrote.
- **Access:** custody testimony, a disposal trace, or a movement record connects
  the instigator to the notebook and the missing paper.

### Changed entry

- **Physical sign:** scraping, overwritten ink, different pressure, or writing
  that does not match Edryc's established hand.
- **Comparator:** an earlier copied or quoted version held outside the culprit's
  official channel establishes the original name, date, place, or House.
- **Access:** the ink, tool, workspace, and custody interval narrow the alteration
  to the instigator.

For Ansel or Ambrose cases, at least one comparator and the murder-opportunity
witness must sit outside the culprit's official channel. The trail never depends
on the culprit confessing, cooperating, or truthfully describing their own work.

---

## 8. Evidence model and exposure proof

Evidence keeps two orthogonal labels:

- `kind` records **how the evidence was obtained**: the existing storage channel
  such as provenance, contradiction, or record.
- `role` records **what the evidence proves in this case**.

The closed case roles are:

| Role | What it establishes |
|---|---|
| `tamper_sign` | The notebook was physically altered; points at nobody. |
| `tamper_comparator` | The surviving order or content cannot be original; points at nobody alone. |
| `culprit_access` | The instigator had the necessary notebook custody, place, and interval. |
| `murder_opportunity` | Independent evidence places the instigator in Edryc's murder window. |
| `escalation_provenance` | The instigator deliberately originated or targeted the false accusation. |

The case profile names one distinct immutable source row for each required role.
Two roles may not silently reuse one source event. The evidence uniqueness key
must include `role`; otherwise `ON CONFLICT DO NOTHING` can discard a required
second role and make a world unwinnable.

An evidence row qualifies only when:

```text
genuine = true
manufactured = false
```

The evidence row's presence records player acquisition, and `found_tick` records
when that happened. `discovered_tick` is not acquisition. In the existing schema
it means a manufactured record was exposed as a forgery and must not be used as
the proof predicate.

The instigator's first guaranteed accusation transmission is rules-recorded as
an immutable telling or event and assigned `escalation_provenance`. Later
retellings cannot overwrite it. The authored scheme fallback must execute this
transmission if the model has not selected a valid escalation action by its due
stage. Source inquiry must be able to reveal this retained origin even when it
is not the recipient's most recent telling.

The player unlocks the two resolution claims only after obtaining all five
roles. This is intentionally stricter than solving the case from rumor
provenance alone and simpler than global numeric thresholds unrelated to the
selected culprit.

---

## 9. Claim taxonomy and mechanics

Every claim is one atomic, disputable proposition and has a `kind`:

| Kind | Meaning | Belief alignment | Sentiment and tension | Public accusation loop |
|---|---|---|---|---|
| `fact` | Observation or physical proposition | No faction discount; transmits at the existing maximum alignment factor | None | Excluded |
| `interpretation` | Meaning inferred from one or more facts | Existing faction alignment applies | No accusation tension | Excluded |
| `accusation` | Alleged culpable act by a person or House | Existing faction alignment applies | Existing sentiment transfer and tension apply | Included when otherwise eligible |

Facts continue to circulate through disclosure, dialogue, and gossip. They do not
enter `runAccusations`; calling physical evidence an accusation would turn every
repetition into faction tension.

The current belief-update path only moves transmitted confidence toward belief,
not disbelief. Initial negative confidence is therefore authored for people who
know a claim is false. Correction happens by building belief in a supported
counterclaim, not by assuming conversation can mechanically retract an old one.
Changing that belief mechanic is outside this lore revision.

Every claim keeps a required agent subject for compatibility:

- `fact`: the actor, witness, record holder, or object owner directly described;
- `interpretation`: the person whose conduct or reputation is interpreted;
- `accusation`: the alleged actor;
- House accusation: the House leader is the mechanical subject while the text
  names the House.

Fact subjects do not create faction bias, sentiment, or tension. The notebook's
physical facts may therefore use Edryc, its owner, without turning the physical
condition of his property into an accusation against a faction.

---

## 10. Claim spine

### Opening claims

These propositions exist in every case. Closed substitutions resolve once at
instantiation.

| Template | Kind | Truth | Subject |
|---|---|---|---|
| `{target} murdered Prince Edryc.` | accusation | false | target or target House leader |
| `The accusation against {target} reflects Edryc's genuine conclusion.` | interpretation | false | target or target House leader |
| `Someone altered Edryc's notebook to direct blame toward {target}.` | interpretation | true | target or target House leader |
| `Edryc followed evidence regardless of which House it threatened.` | interpretation | true | Edryc |
| `Edryc had decided {targetHouse} was guilty before gathering evidence.` | interpretation | false | Edryc |
| `Edryc's notebook visibly shows interference.` | fact | true | Edryc |

The framing claim is an available theory, not an established solution. Visible
tampering supports it, but does not identify intent or culprit.

### Person-to-House escalation

When an individual is framed, the instigator tries to move the town through:

1. `{target} murdered Edryc.`
2. `{targetHouse} is protecting {target}.`
3. `{targetHouse} knew about the murder.`
4. `{targetHouse} ordered the murder.`

The final two are false in every case. Each is a separate accusation and enters
strategy allowlists only after its escalation-stage precondition.

For a direct House target, the chain begins at House responsibility and may name
an alleged operative from that House afterward.

### Costly-secret claims

- Aldreth secretly landed arms at Sella's yard.
- Rusk omitted those cargoes from the customs record.
- Corvane moved armed retainers through the harbour after curfew.
- Hollis suppressed the Corvane movement record.
- Rowan was at the quay on Corvane business.
- Caleb enabled or witnessed the passage.
- Rowan concealed the truth to protect Caleb.

These facts and interpretations are true, but none proves murder.

### Official-action claims

Vague cover-up claims are not authored directly. A concrete action appears first:

- Ansel delayed the alarm, moved the notebook, or omitted another presence.
- Ambrose omitted or contradicted a physical finding.
- Veranne sealed, delayed, admitted, or rejected named evidence.
- A House leader ordered a named witness or record protected.

Only after a concrete action exists may agents form the interpretation or
accusation that the official is protecting Edryc's killer. The action may have an
innocent, compromised, or guilty explanation selected consistently with the case.

### Resolution claims

These begin locked:

- `instigator_altered_notebook`: `{instigator} altered Edryc's notebook to
  implicate {target}.`
- `instigator_murdered_for_war`: `{instigator} murdered Edryc and manufactured
  the accusation to provoke war.`

They unlock from the five-role proof. They never receive opening belief rows,
including for the instigator. Culprit identity lives in hidden case truth and the
private strategy context, not in a player-readable belief.

The second is an intentional **verdict claim**: it composes already-proven atomic
claims about murder, tampering, and deliberate escalation. Witness observations
and intermediate claims remain atomic; only this locked endgame verdict joins the
completed proof into the proposition the validators must accept.

---

## 11. Claim availability and initial beliefs

There is no new claim-lifecycle enum.

- Opening, fact, and observation claims exist unlocked.
- Private knowledge has belief rows but no public rumor heat or telling until it
  is disclosed.
- Escalation accusations exist unlocked with zero belief and heat, and enter
  instigator allowlists only when stage preconditions are satisfied.
- Resolution claims use the existing `locked` state plus an authored
  `initiallyLocked` value.
- Rewind restores every claim to `initiallyLocked`; it does not hardcode one
  claim key.
- Locked claims are filtered from every player-facing API, detail query, prompt,
  hearing, dialogue, scheme, and UI. The known `getAgentDetail` private-belief
  query in `engine/player/game-api.ts` must gain the same locked filter as its
  sibling query.

Initial beliefs derive from four sources:

1. **Private observation:** a selected fact holder strongly believes or denies
   only the atomic proposition they directly know.
2. **Case roles:** the instigator privately disbelieves the false accusation they
   spread; the framed individual strongly disbelieves it.
3. **Knowledge of Edryc:** Maren, Alric, Ansel, Ambrose, and Veranne receive
   authored private beliefs about his fairness consistent with their relationship
   and case role. They may still lie publicly.
4. **Opening rumor:** everyone else's first shift is deterministically computed
   from faction alignment, source trust, traits, and credulity.

`opening.beliefSets`, `selectOpeningBeliefSet`, their validator, and their tests
are retired. Runs vary because case truth, target, evidence, and character choices
vary, not because a separate belief die was rolled.

Persona summaries are always public and case-invariant. They may describe role,
temperament, history, and reputation, but may not assert private knowledge,
culprit innocence, or a case-dependent mental state. Known rewrites include
Edryc's granary-audit summary, Alric's certainty about Rowan, Caleb's unpublished
witness knowledge, Rowan's case-specific reason for silence, and Ambrose's
case-specific report.

---

## 12. Exposure and validator availability

Exposure no longer requires a culprit to believe their own guilt.

The five-role proof unlocks both resolution accusations. Hearings may reveal
either, and culprit heat considers belief in either. Only
`instigator_murdered_for_war`, the full verdict, can produce the exposed ending.
Ending the world requires that verdict to become socially legitimate through
three validator roles:

1. Magistrate Veranne;
2. the first living, non-culprit Aldreth authority in the authored order
   `Maren -> Sella -> Rusk`;
3. the first living, non-culprit Corvane authority in the authored order
   `Alric -> Rowan -> Hollis`.

If Veranne becomes dead, missing, or detained, an authored war-ending trigger
fires because no neutral authority remains capable of legitimizing exposure.

The framed target may validate the counterclaim that they or their House were
framed. This is not belief in their own guilt. Target status therefore does not
automatically disqualify a validator, but dead, missing, or detained agents do.
If either House has no available authority, the world immediately resolves
through an authored war-ending trigger rather than continuing in a silently
unwinnable state: the House without a recognized voice treats the proceeding as
a rival judgment and mobilizes.

For an Alric case, Rowan is normally the Corvane validator; Hollis is the fallback
if Rowan becomes unavailable. For a Sella or Rusk case, Maren normally remains
the Aldreth validator. The culprit is excluded before selection on both sides.

---

## 13. Cast functions inside the claim system

The cast does not need thirty private subplots.

- **Edryc:** fixed fair investigator, notebook owner, victim.
- **Ansel:** discovery-story authority and eligible instigator.
- **Ambrose:** medical-story authority and eligible instigator.
- **Veranne:** official-story authority; never the original instigator.
- **Maren:** grieving Aldreth leader, firsthand witness to Edryc's character,
  evidence decision-maker, House mobilizer.
- **Alric:** Corvane leader, House mobilizer, possible instigator. His uncertainty
  and private beliefs are case-dependent, never frozen in his public bio.
- **Rowan:** prominent suspect, costly-truth holder, and Caleb's protector.
- **Caleb:** vulnerable witness with one bounded murder-night fragment.
- **Sella:** Aldreth operational leader, arms-secret holder, possible instigator.
- **Rusk:** customs-record holder and possible instigator.
- **Hollis:** Corvane record suppressor and possible instigator.
- **Tobias:** record custodian and chronology interpreter.
- **Jenna, Fen, Clem, Morna:** bounded observation witnesses, never omniscient.
- **Background reactors:** House hardliners, skeptics, rumor carriers, market
  opinion-makers, official announcers, and information brokers. Their function is
  to transform or spread claims, not to carry new murder solutions.

Witness claims remain atomic. For example, Caleb being on the water, seeing a
figure, recognizing them, withholding information, and being pressured are five
different propositions. Agreement on an observation does not force agreement on
its meaning.

---

## 14. Compatibility and validation rules

Scenario validation rejects a case profile unless:

- the instigator is one of Sella, Rusk, Alric, Hollis, Ansel, or Ambrose;
- an Aldreth instigator frames Corvane, a Corvane instigator frames Aldreth, and
  an unaligned instigator frames either seed-selected House;
- the target belongs to the framed House and is not the instigator;
- the target/mode wording remains semantically false under the selected culprit;
- exactly one notebook method is selected;
- the method is allowed by the culprit's access profile;
- the murder location is allowed by that profile;
- tampering is after death and before discovery;
- only the culprit has content-altering access in that interval;
- all five evidence roles resolve to distinct immutable source rows;
- role evidence qualifies with `genuine = true` and `manufactured = false`;
- comparator and murder-opportunity witnesses are alive, reachable, and not the
  culprit;
- an Ansel or Ambrose case has comparator and opportunity evidence outside the
  culprit's official channel;
- the proof is completable without conversing with the culprit;
- the guaranteed escalation-origin event exists;
- the exposure validator selection excludes the culprit and has valid Aldreth
  and Corvane authorities or an authored immediate-war route;
- all claim substitutions and subject slots resolve at instantiation;
- no locked claim text, culprit id, hidden target resolution, or private motive
  reaches a player-facing read model or public prompt.

---

## 15. Current claim migration

The current claim keys are used by scenario triggers, engine code, romance
content, tests, UI contracts, README text, and docs. The later implementation
must migrate these references atomically.

### Retain as lore concepts

- `rowan_at_the_quay`
- `shipwrights_smuggle_arms`
- `edryc_met_physician`
- `maren_welcomed_it` as a false, non-core reputational smear, with inheritance
  wording removed because Edryc's neutral office does not pass to Maren

### Retain only through compatible case profiles; atomize or rename

- `physician_was_paid`
- `ferryman_saw_it`
- `chapel_lantern_went_dark`
- `chapel_door_was_barred`
- `two_voices_at_the_steps`
- `corvane_wagon_at_shipyard`
- `aldreth_coin_bought_silence`
- `smith_forged_small_key`
- `maren_sought_magistrate`
- `merchant_ship_missed_tide`

### Remove or replace

- `instigator_exposed`: replace with `instigator_altered_notebook` and
  `instigator_murdered_for_war`. Hearing reveal recognizes both; exposure ending
  checks only the full verdict; scheme heat considers either.
- `corvane_ordered_death`: dynamic target and House-accusation templates replace
  it.
- `prince_died_of_sickness`: remove.
- `granary_books_false`: remove and migrate Maren romance beats.
- `millers_poison_grain`: remove.
- `magistrate_protects_guilty`: replace with concrete action plus interpretation.
- `flour_shortage_hidden`: remove.
- `rowan_bought_sleeping_draught`: remove; the new case has no invariant Rowan
  drugging and Rowan is always innocent of the murder.
- `widow_heard_confession`: remove.

Remove the disconnected `granary_burns` trigger. Any retained amplifier scheme
must operate on the central accusation rather than poisoned grain.

The implementation inventory includes:

- `scenario/hollowmere-v2.json`, including Edryc's faction, public name, summary,
  and his retained sibling relationship with Maren; scenario schema, publishing,
  and instantiation;
- `db/schema.sql` and its `world_player_evidence` migration: add the closed
  evidence `role` column and replace that table's uniqueness constraint with one
  that includes `role`;
- `engine/social/evidence.ts` and exposure logic;
- `engine/simulation/rewind.ts`, replacing the literal `instigator_exposed`
  relock with generic restoration from `initiallyLocked`;
- `engine/agents/schemes.ts`, replacing literal `instigator_exposed` heat with
  the two resolution claims;
- `engine/player/converse.ts`, replacing its literal `instigator_exposed`
  hearing branch with resolution-claim metadata;
- `engine/player/game-api.ts`, especially locked-claim filtering and separation
  of player-known convictions from unrestricted debug beliefs;
- `engine/player/romance-content.ts`;
- gossip, escalation, conversation, canonical-demo, scenario, memory-trace, and
  UI tests that pin claim keys or counts;
- README and Hollowmere design/build documentation;
- public persona summaries that disclose private or obsolete facts.

This spec does not authorize those implementation edits. It defines the atomic
migration required when implementation begins.

---

## 16. Player-facing narrative and UI contract

The UI must distinguish:

- **Evidence:** acquired physical record, observation, testimony, or provenance;
- **Fact claim:** an atomic proposition grounded in such evidence;
- **Interpretation:** what someone thinks the facts mean;
- **Accusation:** an alleged culpable act directed at a person or House.

The player may see that a notebook binding is disturbed without seeing a culprit
name. They may see that Rowan was at the quay without the UI presenting murder as
the conclusion. They may see that an authority withheld a record before anyone
labels that conduct protection of the killer.

Locked claim text, world truth, culprit identity, and private motives never
render. An agent's unlocked belief is shown as a known conviction only after the
player has learned it through conversation, evidence, or a witnessed event;
unrestricted private beliefs may appear only in an explicitly labelled debug
view. No decorative live-status indicators are required.

---

## 17. Acceptance tests

Implementation is not complete until:

1. Identical seed and scenario version produce identical culprit, target,
   method, locations, claim text, subjects, witnesses, and private belief seeds
   without consuming simulation RNG.
2. Every permitted case-profile combination instantiates a valid case. The
   sweep includes instigator, framed House, target mode and individual, notebook
   method, murder location, tampering timing, and witness assignment after
   profile constraints.
3. Edryc instantiates as `unaligned` while retaining the authored sibling
   relationship with Maren. An Aldreth culprit frames Corvane, a Corvane culprit
   frames Aldreth, and an unaligned culprit can frame either House. The target is
   innocent and not the instigator.
4. The central accusation and collective House-order accusation are false in
   every case.
5. Notebook tampering, the framing interpretation, and Edryc's fairness are true
   in every case.
6. `bodyMoved` derives from murder location and tampering remains after death,
   before discovery.
7. Each case produces five distinct genuine, non-manufactured evidence roles.
8. A scripted investigation for every permitted case-profile combination in test
   2 reaches exposure before first blood without speaking to the culprit.
9. The scripted investigation cannot reach exposure when any one required role
   is absent.
10. The escalation-provenance origin remains discoverable after later retellings.
11. No culprit appears in the selected validator set; an Alric case uses Rowan or
    the next valid Corvane fallback, while Sella and Rusk cases retain Maren or
    the next valid Aldreth fallback.
12. Validator unavailability produces a defined fallback or immediate ending,
    never a continuing unwinnable world.
13. Fact claims receive no faction discount, sentiment transfer, accusation
    tension, or accusation-loop eligibility.
14. No private observation becomes public until a telling, disclosure, or event
    occurs.
15. No locked claim appears in any player-facing API, detail view, prompt,
    hearing, dialogue, scheme, or UI.
16. Rewind restores all `initiallyLocked` states and reproduces the same case
    truth and evidence sources.
17. Persona summaries remain truthful across every case and reveal no private
    case knowledge.
18. Removed claim keys have no stale scenario, engine, romance, test, UI, README,
    or docs references after migration.

The implementation plan must add a deterministic winnability harness before
balancing thresholds. The harness owns the per-case scripted transcripts and
runs them before the claim migration is considered complete. A hand-authored
claim list without these runs is not evidence that the mystery is solvable.

---

## 18. Deferred work

- Additional motives for the same instigator
- More notebook methods
- Reversing the victim House
- Freeform model-authored evidence or claims
- Mechanical belief retraction through conversation
- New background-character subplots
- Difficulty tuning beyond the first measured winnability harness

These can add variety later. None is necessary to make the first version dynamic,
coherent, or fair.
