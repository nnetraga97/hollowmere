# Hollowmere: the instigator

**Design spec — 2026-07-25**

Gives the town a plot. One agent begins the world intending to drive Hollowmere
to war; the player's goal is to stop them. The instigator is hidden, must be
deduced from evidence, and is defeated by exposure through the same belief
machinery they use to attack.

This is also the fix for a real weakness in the engine. The README claims the
Park et al. agent architecture, and the *shape* is right — but three of the four
stages are stubs. Adding an antagonist with a concealed agenda forces the two
mechanisms that are most conspicuously missing: persistent goals with multi-tick
plans, and agents that actually talk to each other.

---

## 1. Why now: the gap being closed

Measured against Park et al., *Generative Agents* (2023):

| Paper | Hollowmere today |
|---|---|
| Agents converse; information spreads through dialogue | `kind='dialogue'` is written in exactly one place, `converse.ts:347` — the player path. NPCs never speak to each other. Gossip is a probability roll over relationship edges. |
| Agents observe each other's actions | `applyCognition` writes `action` to `world_agents.current_action` and emits no event. Agents cannot perceive each other acting. |
| Poignancy rated 1–10 per memory | Two hardcoded constants (`config.ts:180`). The importance term in retrieval carries no ranking signal. |
| Reflection: importance threshold → salient questions → insights citing evidence → trees | 30% dice roll, one-sentence summary, no citation, no recursion. |
| Plans decompose day → hour → 5–15 min, replanned on reaction | `{intention, targetLocationKey}` for one tick, expiring after 12 into a static routine table. |
| Dynamic self-summary composed from reflections | Static `persona.summary` frozen at tick 0. |

**In scope for this spec:** agent↔agent dialogue, and goals with multi-tick
plans.

**Explicitly deferred:** model-rated importance, reflection trees, dynamic
self-summary, relationship-aware prompts. These are what make agents *feel*
less rudimentary independent of plot, and they are a natural follow-on — but the
plot does not require them.

**Consequence of deferring reflection:** townspeople will never notice the
pattern themselves. All deduction is the player's. This is a cleaner division of
labour, but it puts the entire weight of winnability on the evidence trail in §6.

**What is not being given up.** Truth stored separately from belief; belief as a
first-class auditable quantity; integer determinism and working replay;
escalation and peace decided by rules and never announced by a model. Every
mechanism below is designed to preserve these, and each section states how.

---

## 2. Cast reduction: 40 → 30 agents

For tick cost. `loadListeners` runs one query per rumor-holder per tick, and a
tick already costs ~500 ms locally at 40 agents; agent↔agent dialogue adds to
that. Thirty is the budget.

Ten are cut. Selection is not arbitrary — an agent survives if it is load-bearing
for the mystery or the gossip topology:

- **Every claim subject stays.** All ten claims name a subject; removing one
  orphans a claim.
- **Both House leaders and the magistrate stay** — peace and exposure both route
  through them.
- **All five culprit candidates stay** (§3).
- **Gossip conduits stay**: `silas_wren` (the only daily cross-house carrier),
  `wyn_thatcher` (market amplifier), `coran_pell` (crier), `hester_lowe`
  (tavern), `edda_lyle` (baker).
- **Evidence-bearing witnesses stay**: `fen_marrow` (lamplighter, sees the town
  at night), `clem_ottery` (stablehand, sees who rides out), `jenna_ryle` (goes
  everywhere unnoticed), `morna_dell` (sold the sleeping draught),
  `ambrose_kyte` (altered the record), `caleb_mord` (was on the water),
  `tobias_reeve` (harbourmaster, keeps ledgers).

Cut (10): `garrick_vell`, `ilsa_kenner`, `bram_atwell`, `perrin_slate`,
`jory_vance`, `dunstan_reed`, `petra_holm`, `gideon_stack`, `lark_penn`,
`iris_fenn`.

Resulting balance — Aldreth 11, Corvane 11, Unaligned 8 — preserves the symmetry
the belief-alignment asymmetry in `BELIEF.alignment*` depends on. `edryc_aldreth`
starts dead, so 29 agents are live at tick 0.

---

## 3. Ground truth chosen per seed

The scenario gains a `culprits` block. Five candidates, each with a way war makes
them money, a ledger that documents it, and therefore a reason the prince's audit
was fatal. The motive is half-written in the existing roster:

| Candidate | Faction | Profit from war | The record |
|---|---|---|---|
| `rusk_baelen` — customs clerk | Aldreth | Clears the arms cargo off the books | "knows exactly which cargoes never appeared in the ledgers, and knows what that knowledge is worth" |
| `bertram_croy` — blacksmith | Corvane | Arms both houses | "lately been asked to forge things he would rather not describe" |
| `hollis_barrow` — Corvane steward | Corvane | Launders grain payments as House affairs | "would burn a ledger before letting it reach the magistrate" |
| `cuthbert_ash` — granary keeper | Corvane | Sells grain off-book to the arms trade | The prince was auditing his books the week he died |
| `sella_dorn` — master shipwright | Aldreth | Her yard lands the cargo | Subject of `shipwrights_smuggle_arms`, already `truth='true'` |

**The motive chain, uniform across candidates:** the individual profits from war;
the granary books record how; the prince's audit found it; the individual killed
him to stop it; the feud is the cover-up. The murder is not a separate mystery —
it is the instigator's opening move.

The seed picks one at instantiation. This is close to free given the determinism
contract, and it lands on capability the schema already has: **`world_claims.truth`
is per-world**, so the culprit's identity resolves the existing claims differently
in each world.

- Culprit Aldreth-side → `corvane_ordered_death` instantiates `truth='false'`,
  and half the town hardens around a lie about the wrong House.
- Culprit `cuthbert_ash` → it instantiates `'true'`, but for the wrong reason.

Truth-versus-belief stops being one demonstration claim and becomes the spine of
the mystery.

### New table

```sql
CREATE TABLE world_culprit (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  motive_key   STRING NOT NULL,
  exposed_tick INT8 NULL,
  PRIMARY KEY (world_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);
```

One row per world, so `PRIMARY KEY (world_id)` alone — matching `world_state`
rather than schema convention 2's per-entity composite, which does not apply to
singleton tables. The FK to `world_agents` is still composite, so a cross-world
culprit remains unrepresentable.

Excluded from every read model in `engine/api.ts` except a debug-only one. The
dashboard may show it; nothing player-facing may.

---

## 4. Goals and schemes

### Goals

```sql
CREATE TABLE world_agent_goals (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  goal_key     STRING NOT NULL,
  priority     INT8 NOT NULL,
  status       STRING NOT NULL CHECK (status IN ('active','suspended','achieved','abandoned')),
  updated_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, agent_id, goal_key),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id)
);
```

Principals — both leaders, the magistrate, the culprit — get goals from scenario.
The culprit gets `provoke_war`.

### Schemes

The instigator's plan is an authored **scheme ladder**: an ordered list of steps,
each gated by preconditions written in the *existing* trigger DSL `Condition`
grammar from `scenario/schema.ts`. No new evaluator and no new attack surface;
scenario JSON still never becomes code.

A scheme names: a claim to push, an audience (faction or location), and a
required precondition. Effects come from the existing allowlisted verb set plus
two additions:

- `instruct_dialogue` — queue an exchange between the culprit and an
  engine-selected agent matching the named audience, pushing the named claim.
- `seed_rumor_via` — seed an existing rumor with the culprit as originator, so
  `from_agent_id` records them as the source.

Both resolve claim and agent ids from scenario keys inside the engine. Neither
accepts a model-supplied identifier.

**The load-bearing invariant:** the engine selects which scheme fires; the model
only writes what the character *says* while executing it. Model output still
never selects an effect, and scheme selection stays deterministic rule logic, so
replay is unaffected.

New module `engine/schemes.ts`. Goal state lives in `engine/goals.ts`.

---

## 5. Agent↔agent dialogue

New module `engine/dialogue.ts`.

**Pair selection is a rule.** Both agents colocated, retell cooldown elapsed, at
least one carrying an agenda or a rumor above `GOSSIP.minHeat`, ordered on
`agent_key` (never `agent_id` — decision 12). The model writes only the line.

**What an exchange produces:**
- A `world_events` row with `kind='dialogue'` — a kind the schema already permits
  and nothing currently writes. This is what finally lets agents perceive each
  other: `loadSituation` already reads `kind IN ('dialogue', ...)`.
- A `world_rumor_spread` row with `from_agent_id` populated — **provenance that is
  already being recorded and is not yet used by anything.** This is the backbone
  of §6.
- Belief and trust movement through the existing `beliefs.ts` path.

**Provenance is written by the rules, never parsed out of generated text.** The
pair selection and the scheme decide who tells whom which claim; the engine
writes the `world_rumor_spread` row and the belief update from *that*, and the
model's line is flavor text attached to a decision already made. Nothing is
extracted from the model's output and turned into a fact.

This is not fastidiousness. Multi-agent dialogue in this exact architecture is
documented to hallucinate and to *propagate* the resulting errors through agent
memory (§11). Every other system tolerates that as a believability cost; here it
would be fatal, because the win condition rests on provenance integrity. An agent
who forms a memory that someone told them something never said produces a
`from_agent_id` chain that lies, sends the player to an innocent townsperson, and
leaves the world unwinnable with no recovery path. Rules-written provenance makes
that unrepresentable, and makes screening-and-regeneration frameworks unnecessary
for correctness — they would only improve prose.

**Budget.** `COGNITION.callBudget` is 400. One exchange per tick over a 360-tick
run is 360 calls on its own, which starves cognition. Resolution: gate to one
exchange per 6 ticks — 60 exchanges over a full run, one model call each — with
the instigator's exchanges taking priority when contended, and degrade to
templated text when the budget is exhausted, the same pattern `think()` already
uses at `cognition.ts:249`. If playtesting shows 60 exchanges is too sparse to
read as a living town, raising `callBudget` is preferred over cutting cognition.

**Determinism and replay.** Dialogue text must be recorded or replay breaks.
Recorded in `cognition_records` under a new `task` discriminator column rather
than in a separate table: the replay machinery in `cognition.ts` already handles
input-hash verification and refusal-on-mismatch, and duplicating it for a second
record type is how the two drift apart. Pair selection draws from the seeded RNG
and must draw **unconditionally**, per decisions 13 and 23.

---

## 6. Deception, evidence, and exposure

### Deception is a data property — and the model is never told the plot

The instigator's own `agent_beliefs` row for the claims they push sits
**negative** — they know it is false; they invented it — while they seed and
accuse anyway. `confidence` is already signed (`-10000..10000`), so nothing new
is needed to represent this. Their public accusations contradicting their private
belief *is* the deception, and it is auditable in existing tables.

Audience-varying contradiction comes from the scheme naming which claim to push
at which faction: blame Corvane at the quay, blame Aldreth at the mill.

**The model is never told it is playing the instigator.** This is a hard rule,
adopted from the hidden-role literature (§11): agents asked to reason as a
concealed role and then speak as an innocent one leak the concealed role, because
the mismatch between private reasoning and public speech confuses the model into
voicing the private thought. Instructing a model to lie well is also a poor bet —
observed deception is mostly equivocation and rarely effective.

So the instigator's dialogue prompt contains the **cover story only**: who they
are, which claim they hold, and who they are speaking to. "You are Rusk Baelen.
You believe House Corvane ordered the prince's death. Say so to Ned Quilley."
The model plays a sincere partisan; it has no concealed role to leak because it
has no concealed role at all. The scheming lives entirely in rule-driven scheme
selection, which the model never sees.

This upgrades the engine's existing invariant from *model output never selects an
effect* to **model output never knows the plot** — and it is cheaper, since the
agenda never enters a prompt.

### Evidence — three channels

**Provenance (`inquire`).** `inquire` is currently a no-op that warms sentiment
(`converse.ts:535`). Wire it to `from_agent_id`: the NPC names who told them,
gated on trust — below a threshold they deflect or misdirect rather than refuse,
since a flat refusal is a tell in itself. Chase enough branches of a false rumor
back and they converge on one person.

**Contradiction.** The engine detects that the player has heard one agent blame
both Houses, and records it as a found clue. Detection is a query over
`world_events` the player has witnessed, not a model judgment.

**Records.** The granary books, the customs ledger, the physician's altered
record — authored, obtained by inquiring of the right person in the right place.

New table `world_player_evidence (world_id, player_id, evidence_key, found_tick)`,
append-only.

### Exposure — the win

A per-world claim `instigator_exposed`, subject = the culprit, `truth='true'`,
absent at tick 0. It unlocks when the player holds all three of: **3 provenance
links** naming the culprit as source, **1 contradiction**, and **1 record**. Once
unlocked the player accuses with it exactly like any other claim, and the
existing rumor machinery carries it.

These three numbers are the difficulty dial and are the most likely thing to be
wrong on first pass; §9 treats winnability as unproven until the harness
measures it.

**The rules decide the ending, never the model** — the same discipline as
`peace.ts`. The check: belief in `instigator_exposed` at or above
`BELIEF.actionableConfidence` in both House leaders *and* Magistrate Thule. On
success: culprit `status='detained'`, goal `suspended`, their seeded rumors cool,
`worlds.ending='exposed'`.

`worlds.ending`'s CHECK constraint gains `'exposed'`. Peace by the existing route
remains reachable and unchanged.

---

## 7. Adaptivity

A `heat_on_culprit` scalar, computed per tick from player inquiries naming them
plus town-wide belief in `instigator_exposed`. Thresholds switch the active goal,
expressed as scheme preconditions in the existing DSL:

```
provoke_war  →  lie_low            (stop seeding; wait it out)
             →  discredit_outsider (seed a claim about the player)
             →  force_war_now      (spend everything before exposure lands)
```

This is what makes the endgame a race rather than a checklist. It is also purely
rule-driven, so it costs nothing in determinism.

---

## 8. Module and schema summary

**New engine modules:** `goals.ts`, `schemes.ts`, `dialogue.ts`, `evidence.ts`,
`exposure.ts`.

**Modified:** `converse.ts` (`inquire` effects, evidence capture),
`runtick.ts` (dialogue and scheme steps), `cognition.ts` (goal-aware prompts,
dialogue record reuse), `config.ts` (new constants),
`scenario/schema.ts` + `instantiate.ts` (culprits block, per-world truth
resolution, 30 agents), `db/schema.sql`, `engine/api.ts` (read models).

**New tables:** `world_culprit`, `world_agent_goals`, `world_player_evidence`.

**Altered:** `worlds.ending` CHECK gains `'exposed'`; `cognition_records` gains a
`task` discriminator.

---

## 9. Consequences and risks

- **The canonical arc moves, twice over.** Dropping to 30 agents changes the
  diffusion curve on its own, and an active instigator accelerates escalation
  further. The 192–288 tick window and the war-at-240 figure must be re-baselined
  against `harness/sim.ts`. `engine/escalation.test.ts` and `engine/runtick.test.ts`
  will fail until re-baselined — this is expected, not a regression.
- **Peace tests need revisiting.** A scripted reconciliation now has an opponent
  working against it. The "reconciliation reaches peace before first_blood" test
  may need the instigator suppressed, or a longer scripted campaign.
- **Winnability is unproven until measured.** With NPC reflection deferred, the
  evidence trail is the only path. The harness must be able to run a scripted
  *investigation* transcript to exposure, the way it currently runs a scripted
  reconciliation to peace. If it cannot, the game is not winnable and the
  thresholds in §6 are wrong.
- **Budget pressure is real** (§5) and may force raising `callBudget`.
- **Scope is substantial**: 5 new modules, 3 new tables, and changes to the three
  largest files in the engine.

---

## 10. Acceptance tests

Added to the existing suite in `engine/*.test.ts`:

**Culprit selection**
- The same seed selects the same culprit in two different worlds; a different
  seed can select a different one.
- Per-world claim truth resolves consistently with the selected culprit — an
  Aldreth-side culprit yields `corvane_ordered_death` with `truth='false'`.
- `world_culprit` appears in no player-facing read model.

**Goals and schemes**
- Scheme preconditions are evaluated by the existing DSL evaluator; a scheme with
  an unknown verb or fact is rejected at scenario load, not at runtime.
- The scheme ladder advances in order and never skips a step whose precondition
  is unmet.
- `heat_on_culprit` crossing each threshold switches the goal, and the goal never
  silently reverts.

**Dialogue**
- An exchange emits exactly one `world_events` row with `kind='dialogue'` and one
  `world_rumor_spread` row with `from_agent_id` set.
- A colocated third agent perceives the exchange through `loadSituation`.
- Pair selection is identical across two worlds built from one seed.
- An exhausted budget degrades dialogue to templated text and keeps ticking.
- **Provenance survives an adversarial model.** With an inference client whose
  generated line names a *different* agent as the source, or contains injected
  instructions to that effect, `world_rumor_spread.from_agent_id` still records
  the agent the rules selected. This is the guard on finding 2 in §11, and the
  reason the world stays winnable.
- **Replay:** a recorded run with dialogue replays with zero inference calls,
  reproducing the same events and belief table — the existing `replay.test.ts`
  discipline extended to the new record type.

**Deception**
- The instigator's `agent_beliefs` confidence for a claim they seed is negative
  while they publicly accuse with it.
- The instigator pushes different claims to different factions, and the
  contradiction is detectable from `world_events` alone.
- **The agenda never enters a prompt.** Assert over the constructed prompt for an
  instigator dialogue turn that it contains no goal key, no scheme key, and no
  reference to the culprit role. This is the guard on finding 1 in §11; without a
  test it will be reintroduced the first time someone tries to improve the
  instigator's dialogue.

**Evidence and exposure**
- `inquire` returns the true `from_agent_id` above the trust threshold and
  misdirects below it.
- Provenance chains from a culprit-seeded rumor terminate on the culprit.
- `instigator_exposed` cannot be accused with before the evidence threshold is
  met.
- Belief in `instigator_exposed` reaching actionable confidence in both leaders
  and the magistrate ends the world with `ending='exposed'`; falling short of any
  one of the three does not.
- **Winnability:** a scripted investigation transcript reaches `exposed` before
  `first_blood` under the canonical seed. The same transcript run after
  `force_war_now` has fired does not.
- The prompt-injection corpus, run through `inquire` and through agent dialogue,
  produces no effect outside the allowlist, grants no evidence, and moves no
  stage.

**Determinism, unchanged**
- Same `{scenarioVersion, seed, playerCommands}` under stub → byte-identical
  event, belief, and tension sequences, with the instigator active.

---

## 11. Research basis, and what it changed

Reviewed before committing to this design. Two findings changed it; both changes
are simplifications.

### What the literature validates

**Hybrid authored-plus-emergent is the consensus, not a compromise.** Interactive
drama work converges on the shape used here: *Drama Llama* (2025) fires authored
"storylets" when story conditions match and injects stage directions into an
otherwise emergent scene; *StoryVerse* (FDG 2024) introduces "abstract acts" to
mediate between authorial intent and emergent LLM character behaviour. The scheme
ladder in §4 — authored steps gated by preconditions over live world state — is
the same construct. Neither pure-scripted nor pure-emergent has a credible
advocate.

**Cost pressure is more severe than assumed, which vindicates the rules-heavy
split.** A four-player GPT-4 simulation has been costed at ~$5,400; the original
25-agent two-day Smallville run cost thousands in credits. *Lyfe Agents* (2023)
reports 10–100× cost reduction chiefly via an **option-action** split — high-level
"options" selected infrequently, low-level actions executed cheaply — which is
structurally the same as goals plus schemes here. The 60-exchange cap in §5 is
the design, not a limitation. Lyfe Agents also had agents solve a murder mystery
collaboratively, so a mystery on this kind of substrate is demonstrated.

### Finding 1 — hidden-role leakage (changed §6)

Agents assigned a concealed role and asked to speak as though they held a
different one **reliably leak the concealed role**: reasoning as X and then
speaking as not-X produces a mismatch that surfaces the private thought in public
speech. This is reported repeatedly across the Werewolf/Avalon/Among Us line of
work. Related: observed deception is mostly *equivocation* rather than lying, and
rarely improves outcomes — so instructing a model to lie well is a bad bet.

The first draft of §6 walked into this by having the model voice a character
whose private belief contradicts their public claim. **Amended:** the model is
never told it is the instigator, and the agenda never enters a prompt. See §6.

### Finding 2 — dialogue hallucination propagates (changed §5)

*Cohesive Conversations* (COLM 2024) found repetition, inconsistency,
hallucination, and **propagation of erroneous information through agent memory**
in exactly the Generative Agents multi-agent dialogue setup §5 adds. Their remedy
is a screening/diagnosis/regeneration pass over generated utterances.

For most systems that is a believability cost. Here it would be fatal: the win
condition rests on provenance integrity, and a hallucinated "who told me" makes
the world unwinnable. **Amended:** provenance is rules-written and never parsed
from model output, which makes the failure unrepresentable rather than corrected
after the fact. See §5.

### Considered and rejected

**A centralised director agent** that watches the simulation and injects beats to
keep the story moving — the main structural alternative in the drama-management
literature. Rejected on two grounds: it undermines "the town did this to itself",
and it introduces a component whose decisions are not auditable from the history,
which is against the grain of every other subsystem here.

**Summarize-and-forget memory** (Lyfe Agents). Real cost savings, but aimed at
long-running agents; a world caps at 30 minutes and 360 ticks. Not needed.

---

## 12. Attribution

Agent architecture continues to follow Park et al., *Generative Agents* (2023).
The antagonist-with-concealed-agenda structure follows the interactive-drama and
drama-management line rather than the social-simulation line; see *Towards
Enhanced Immersion and Agency for LLM-based Interactive Drama* (2025), *HAMLET*
(2025), *Drama Llama* (2025), and *StoryVerse* (FDG 2024). Cost architecture
follows *Lyfe Agents* (2023). Dialogue-integrity handling responds to *Cohesive
Conversations* (COLM 2024). Escalation dynamics remain Crucible-inspired in
dynamics only — original town, characters, and text.
