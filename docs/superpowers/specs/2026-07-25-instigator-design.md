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

**In scope for this spec:** agent↔agent dialogue, goals with multi-tick plans,
and — following from both — player-convened hearings (§6), which need the same
multi-tick-intent machinery to let an agent be somewhere on purpose.

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

### The governing principle

> **The model decides what a character does. The rules decide what is true.**

Character decisions — who to work on, what to say, which grievance to press,
whether to protect a source, how to misdirect — belong to the model, chosen from
an engine-built allowlist and recorded for replay. World-fact decisions — what
actually happened, who actually told whom, what the tension is, whether the world
ends in war, peace or exposure — belong to the rules, always.

This is stated as an invariant rather than left implicit, because the first draft
of this spec got it wrong by leaving it implicit. Two arguments were stretched
past what they support:

- **Determinism does not require rule-derivation.** `cognition_records` already
  replays *model* decisions with zero Bedrock calls. A recorded model decision is
  exactly as replayable as a computed one. Determinism argues for recording, not
  for rules.
- **"Model output never selects an effect" is about allowlisting, not authorship.**
  `parsePlan` already lets a model genuinely choose a destination and whether to
  accuse — from a list the engine built. Constraining the space of a decision is
  not the same as making the decision.

### Schemes — the instigator strategises

The instigator does not execute a script. Each time a scheme slot opens, a
**strategy call** gives the model the situation and asks it to devise the next
move. This is real deception: the misdirection is the model's, not the author's.

**What the strategy call sees:** its own agenda, its goal, the claims it holds,
who is present and reachable, what those people currently believe, how talkative
and trusting they are, which witnesses are close to exposing it, the current
`heat_on_culprit`, and **any hearing the player has announced within earshot**
(§6) — who was summoned, where, and by when.

**What it returns**, structured and allowlist-validated:

| Field | Chosen from |
|---|---|
| `tactic` | a closed set (below) |
| `target` | agents actually present or reachable |
| `claim` | claims the instigator actually holds |
| `posture` | `press`, `lie_low`, `redirect`, `force` |

Tactics are the strategic vocabulary, and they are what make the antagonist feel
like an opponent:

- `blame_shift` — push a claim against the House opposite the listener's own.
- `corroborate_false` — back a rumor already circulating, to harden it rather
  than start a new one.
- `poison_the_well` — discredit a witness *before* they can testify. Working on
  the ferryman's reputation before he speaks is a strategy the model should be
  able to find on its own; an announced hearing (§6) gives it both an obvious
  target and a deadline.
- `feign_moderation` — publicly counsel calm, to build trust with someone worth
  spending later.
- `redirect_suspicion` — under heat, seed a claim against a *different* culprit
  candidate. The other four candidates exist partly to make this possible.
- `recruit_amplifier` — target a high-talkativeness hub rather than someone who
  already believes.

Authored scheme templates remain, but as **eligibility and fallback**, not as the
plan: preconditions in the existing trigger DSL `Condition` grammar determine
which tactics are available this turn, and a budget-exhausted world falls back to
the authored ladder. Scenario JSON still never becomes code.

Effects still come from the allowlisted verb set plus two additions:

- `instruct_dialogue` — queue an exchange between the culprit and the chosen
  target, pushing the chosen claim.
- `seed_rumor_via` — seed a rumor with the culprit as originator, so
  `from_agent_id` records them as the source.

Both resolve claim and agent ids from scenario keys **inside the engine**. A
tactic, target or claim outside the supplied allowlist is dropped rather than
corrected, exactly as `parsePlan` drops an unreachable destination.

New module `engine/schemes.ts`. Goal state lives in `engine/goals.ts`.

---

## 5. Agent↔agent dialogue

New module `engine/dialogue.ts`.

**Pair selection is a rule** — for cost, not principle: deciding it with a model
would be a call every tick. Both agents colocated, retell cooldown elapsed, at
least one carrying an agenda or a rumor above `GOSSIP.minHeat`, ordered on
`agent_key` (never `agent_id` — decision 12).

The exception is the instigator, whose target *is* chosen by the model as part of
the strategy call (§4). The rules then confirm the chosen target is genuinely
reachable and drop the tactic if not.

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
exchange per 6 ticks — 60 exchanges over a full run, one speech call each — with
the instigator's exchanges taking priority when contended, and degrade to
templated text when the budget is exhausted, the same pattern `think()` already
uses at `cognition.ts:249`.

Full accounting for a 360-tick run:

| Consumer | Calls |
|---|---|
| Cognition (2 agents per 6 ticks) | ~120 |
| Dialogue speech calls (1 per 6 ticks) | 60 |
| Instigator strategy calls (1 per 12 ticks) | 30 |
| Embeddings (1 per cognition round) | ~60 |
| Player conversation | player-driven |

That leaves headroom inside 400. The strategy call is the cheapest agency in the
design — 30 calls buys the antagonist its entire strategic repertoire, because
one strategy decision governs several ticks of execution. This is the
option-action split from *Lyfe Agents* (§11): decide rarely and expensively,
execute often and cheaply.

**Stub mode falls back to the authored ladder.** The determinism tests run on the
stub, which cannot devise a strategy, so the stub's strategy policy *is* the
authored scheme ladder — which is why §4 keeps those templates rather than
deleting them. The canonical arc is therefore reproducible without a model, as it
is today.

**Determinism and replay.** Dialogue text must be recorded or replay breaks.
Recorded in `cognition_records` under a new `task` discriminator column rather
than in a separate table: the replay machinery in `cognition.ts` already handles
input-hash verification and refusal-on-mismatch, and duplicating it for a second
record type is how the two drift apart. Pair selection draws from the seeded RNG
and must draw **unconditionally**, per decisions 13 and 23.

---

## 6. Deception, evidence, and exposure

### Deception is a data property, and a strategy the model devises

The instigator's own `agent_beliefs` row for the claims they push sits
**negative** — they know it is false; they invented it — while they seed and
accuse anyway. `confidence` is already signed (`-10000..10000`), so nothing new
is needed to represent this. Their public accusations contradicting their private
belief *is* the deception, and it is auditable in existing tables.

Audience-varying contradiction comes from the scheme naming which claim to push
at which faction: blame Corvane at the quay, blame Aldreth at the mill.

### Two calls, two contexts

The instigator must be able to *devise* deception, not merely deliver authored
lines. That is the whole point of an antagonist. But the hidden-role literature
(§11) shows that agents asked to reason as a concealed role and then speak as an
innocent one leak the role.

The failure is not caused by holding a hidden agenda. It is caused by **private
reasoning sitting in the same context as public speech** — the model reasons "I
am the culprit, I must deflect," and fragments of that reasoning surface in the
line it speaks. The remedy in that literature is separation, not suppression.

So the instigator gets two calls with **two separate contexts**:

**1. Strategy call — private.** The model is fully the instigator here: it has
the agenda, the goal, the social graph, current beliefs, and the heat on it. It
devises the misdirection and returns the structured tactic in §4. Recorded to
`cognition_records` under `task='strategy'`.

**2. Speech call — fresh context.** Contains the cover story and the chosen
tactic *as a directive*, and nothing else. No agenda, no goal, no role, and
critically **no reasoning trace from call 1**. "You are Rusk Baelen, speaking to
Ned Quilley. Tell him you saw Corvane men at the quay that night."

The model genuinely schemes; the reasoning that would leak is simply not present
when the character speaks. The invariant is therefore not "the model never knows
the plot" — it is:

> **The context that plans is never the context that speaks.**

This is enforceable and testable in a way that "don't leak" is not, and it is
what lets the antagonist have real strategic agency without the documented
failure mode.

Every other agent's dialogue is a single speech call, unchanged.

### Evidence — three channels

**Provenance (`inquire`).** `inquire` is currently a no-op that warms sentiment
(`converse.ts:535`). Wire it to `from_agent_id`.

Whether an NPC gives their source up is a character decision, not a threshold:
"do I protect the person who told me this" is exactly the kind of choice that
makes someone feel like a person. The engine supplies trust, sentiment, faction
alignment and who the source actually is; the model chooses from
`{name_them, deflect, misdirect, demand_something_first}`. A flat refusal is
deliberately not in the set — it is a tell, and it ends the thread.

The engine still owns the fact. If the model chooses `name_them`, the engine
supplies the real `from_agent_id`; if it chooses `misdirect`, the engine picks the
false name from agents that NPC actually knows. **The model never types a name
that becomes evidence.** Chase enough branches of a false rumor back and they
converge on one person.

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

### Convening a hearing — the primary exposure route

Reaching three specific people's belief thresholds by talking to each of them
separately is arithmetically correct and dramatically dead. The natural way to
expose someone is to gather credible witnesses and say it in front of them, so
the accused cannot deny it privately one listener at a time. The fiction already
knows this: `magistrate_opens_inquiry` summons both Houses to the plaza. It is
simply not available to the player.

Four things are missing, and the first is a defect in the existing engine.

**(a) Reputation is write-only.** `player_reputation` is written at
`converse.ts:570` and **read by nothing** — a grep of the engine returns one
write and no reads. `CONVERSE.persuasion` is a flat 160% applied identically
whether the player is trusted or has spent twenty minutes slandering people. The
game tracks standing, displays it, and ignores it.

Fixed independently of the hearing: persuasion becomes
`base × f(reputation with the listener's faction) × g(trust)`, all fixed-point,
clamped. This changes existing balance — see §9.

**(b) A tenth speech act, `summon`.** Carries a location and a due tick. This is
the first player utterance that asks for something rather than asserting
something, which is why none of the existing nine fit.

**(c) Commitments, so agents can be somewhere on purpose.**

```sql
CREATE TABLE world_agent_commitments (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  location_id  UUID NOT NULL,
  due_tick     INT8 NOT NULL,
  source       STRING NOT NULL CHECK (source IN ('player','trigger','agent')),
  status       STRING NOT NULL CHECK (status IN ('pending','kept','broken')),
  created_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, agent_id, due_tick),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);
```

`movement.ts` checks commitments **before** routine: a pending commitment whose
`due_tick` is within travel distance overrides the phase's scheduled location.
This is the same multi-tick-intent machinery §4 builds for goals, so it is
largely already paid for.

**Whether they come is a character decision**, per §4's principle — the model
chooses from `{come, decline, come_but_tell_someone}` given trust, sentiment,
reputation, and faction. The third option is the interesting one: an agent may
agree in good faith and then mention it to the wrong person. **The player's own
witnesses can leak the hearing.**

**(d) Audience-scoped effects.** An accusation made where N agents are present
applies belief movement to **all of them**, not only the conversational partner —
scaled by each listener's own alignment through the existing `beliefs.ts` path,
and with the aggregate tension change routed through `TENSION.maxRisePerTick` so
a mass reveal cannot vault a stage. Saying it to a room is materially different
from saying it five times in five streets, which today it is not.

### Why this makes the antagonist better

Summoning is **loud**. Each `summon` writes a `world_event` at the listener's
location, and those events are exactly what the instigator's strategy call reads.
So a hearing hands the antagonist a target and a deadline:

- `poison_the_well` acquires an obvious use — discredit one of the announced
  witnesses before the due tick.
- `redirect_suspicion` acquires urgency.
- If the culprit attends, they answer in front of the same audience, and the
  audience-scoped effects cut both ways.

The endgame stops being "accumulate three provenance links, then accuse" and
becomes a confrontation with a race attached. The quiet route — persuading the
leaders and the magistrate individually — remains valid for players who never
think of convening anything, and is the fallback the winnability test in §10
measures separately.

---

## 7. Adaptivity

The rules compute `heat_on_culprit` per tick from player inquiries naming them
plus town-wide belief in `instigator_exposed`. That is a **fact about the world**,
so it is rule-derived.

What to *do* about it is a character decision, so it belongs to the strategy call.
`heat_on_culprit` is an input to the prompt, not a branch in a threshold table,
and the model chooses its `posture`:

| Posture | What it means |
|---|---|
| `press` | Carry on escalating; nobody is close. |
| `lie_low` | Stop seeding and wait it out. |
| `redirect` | Seed suspicion onto a different culprit candidate. |
| `force` | Spend everything to reach war before exposure lands. |

An earlier draft made this a threshold table, on the grounds that telling the
model it was under investigation would reveal its role. The two-context split in
§6 removes that objection — the strategy context already knows exactly who it is.
Handing the decision back is the single largest gain in the design: *"they are
closing in, so put it on Cuthbert Ash"* is the best beat available here, and a
threshold table cannot produce it.

Posture is validated against the closed set above, so an unrecognised value is
dropped and the previous posture holds. The world still cannot be ended by a
model — see §6.

---

## 8. Module and schema summary

**New engine modules:** `goals.ts`, `schemes.ts`, `dialogue.ts`, `evidence.ts`,
`exposure.ts`, `hearings.ts`.

**Modified:** `converse.ts` (`inquire` effects, evidence capture, the `summon`
act, audience-scoped effects, reputation-weighted persuasion),
`runtick.ts` (dialogue and scheme steps), `cognition.ts` (goal-aware prompts,
dialogue record reuse), `movement.ts` (commitments outrank routine),
`config.ts` (new constants), `scenario/schema.ts` + `instantiate.ts` (culprits
block, per-world truth resolution, 30 agents), `db/schema.sql`,
`engine/api.ts` (read models).

**New tables:** `world_culprit`, `world_agent_goals`, `world_player_evidence`,
`world_agent_commitments`.

**New speech act:** `summon` — the tenth, and the first that asks for something
rather than asserting something. `SPEECH_ACTS` and the classifier's allowlist
both grow by one.

**Altered:** `worlds.ending` CHECK gains `'exposed'`; `cognition_records` gains a
`task` discriminator taking `plan`, `reflect`, `dialogue`, and `strategy`.

**New prompt versions:** `strategy-v1` (private, instigator-only), `speech-v1`
(public, all agents), `inquire-v1`. Each is version-gated for replay exactly as
`PLAN_PROMPT_VERSION` is today, so a changed prompt refuses a stale recording
rather than replaying against it.

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
- **Wiring reputation into persuasion rebalances every existing conversation
  test.** `player_reputation` is currently write-only (§6), so every scripted
  transcript in the suite — including the reconciliation-reaches-peace test —
  has been running at a flat 160% persuasion. Once standing matters, an early
  reconciliation campaign is *weaker* than it is today (the player starts at
  zero) and a late one is stronger. Expect `converse.test.ts` and the peace path
  to need re-baselining alongside the escalation tests, and expect the fix to
  make the peace route slightly harder, which is probably correct.
- **Audience-scoped effects are a tension amplifier.** N listeners means N belief
  updates from one utterance. The `TENSION.maxRisePerTick` cap contains the
  aggregate, but a hearing in a crowded plaza is the largest single event the
  engine can produce, and it is player-triggerable at will. Worth watching for a
  degenerate strategy where the player farms assemblies rather than investigating.
- **A strategising antagonist is less tunable than a scripted one.** Under
  Bedrock the instigator's choices vary run to run, so the escalation curve is a
  distribution rather than a number. Two consequences: the canonical-arc
  guarantees are stated against **stub mode**, where the authored ladder governs
  and behaviour is exactly reproducible; and live-model runs need a batch harness
  measuring *how often* war is reached by tick N, not a single assertion. This is
  the price of the agency and it is worth paying, but it should not be discovered
  on the day of the recording.
- **A model-devised strategy can be strategically inert** — the equivocation
  finding in §11. The mitigation is that tactics are a closed vocabulary with
  engine-supplied effects, so even a weakly-argued `poison_the_well` moves belief
  by the same arithmetic as a well-argued one. The prose can be bad without the
  game breaking.
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
- **The context that plans is never the context that speaks.** Assert over the
  constructed *speech* prompt for an instigator dialogue turn that it contains no
  goal key, no posture, no culprit role, and no text from the strategy call's
  output beyond the single chosen tactic directive. This is the guard on finding 1
  in §11; without a test it will be reintroduced the first time someone tries to
  give the instigator "better context" for its dialogue.
- The strategy call and the speech call are separate `inference.complete`
  invocations with disjoint message contents — asserted by inspecting the
  recorded calls, not by inspecting the implementation.
- A `tactic`, `target`, `claim` or `posture` outside the supplied allowlist is
  dropped, not corrected; an unrecognised posture leaves the previous posture in
  force. Same discipline as `parsePlan`.
- The strategy call is recorded under `task='strategy'` and a replayed run reuses
  it without reaching a model.

**Evidence and exposure**
- `inquire` under `name_them` returns the true `from_agent_id`; under `misdirect`
  it returns a false name **chosen by the engine** from agents that NPC knows.
  A name appearing in the model's generated text never becomes evidence.
- A model that returns `refuse` — deliberately absent from the allowlist — is
  treated as `deflect`, and the thread stays open.
- Provenance chains from a culprit-seeded rumor terminate on the culprit.
- `instigator_exposed` cannot be accused with before the evidence threshold is
  met.
- Belief in `instigator_exposed` reaching actionable confidence in both leaders
  and the magistrate ends the world with `ending='exposed'`; falling short of any
  one of the three does not.
- **Winnability, both routes:** a scripted investigation transcript reaches
  `exposed` before `first_blood` under the canonical seed — measured separately
  for the quiet route (persuading the leaders and magistrate individually) and
  the hearing route. Both must be winnable; if only one is, the other is
  mistuned. The same transcripts run after `force` posture has fired do not.
- The prompt-injection corpus, run through `inquire` and through agent dialogue,
  produces no effect outside the allowlist, grants no evidence, and moves no
  stage.

**Hearings**
- A `summon` writes a `world_agent_commitments` row and a `world_event` at the
  listener's location. The event is visible to the instigator's strategy inputs.
- An agent under `come` diverts from routine and is at the location by
  `due_tick`; `movement.ts` prefers the commitment over the phase's scheduled
  location, and the commitment is marked `kept`.
- An agent under `decline` never diverts; the commitment is marked `broken` at
  `due_tick` and no movement event is written.
- Under `come_but_tell_someone` the culprit receives the hearing in their
  strategy inputs even when no summon was addressed to them — asserted by
  running a world where the culprit is not summoned and confirming they know.
- **Audience scope:** an accusation at a location with N present writes N
  `belief_updates` rows, one per listener, each scaled by that listener's own
  alignment — not N identical deltas.
- The aggregate tension change from a hearing is clamped by
  `TENSION.maxRisePerTick`, and a hearing cannot advance a stage within its own
  tick.
- A hearing with both leaders and the magistrate present, at sufficient evidence
  and reputation, reaches `ending='exposed'`; the same hearing missing any one of
  the three does not.

**Reputation**
- Persuasion scales with `player_reputation` against the listener's faction: the
  identical utterance from a high-standing and a low-standing player produces
  different belief deltas. This currently cannot fail, because nothing reads the
  column.
- Reputation is bounded, so no amount of standing lets one utterance exceed
  `BELIEF.maxShiftPerTransmission`.

**Determinism, unchanged**
- Same `{scenarioVersion, seed, playerCommands}` under stub → byte-identical
  event, belief, and tension sequences, with the instigator active.
- A commitment kept or broken is deterministic across two worlds from one seed.

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
rarely improves outcomes.

The first draft of §6 walked into this by having one call voice a character whose
private belief contradicts their public claim.

**First amendment, since superseded:** never tell the model it is the instigator.
This removed the failure mode but bought safety with the antagonist's entire
strategic agency — it reduced the instigator to delivering authored lines, which
is precisely the "agents feel rudimentary" complaint this spec exists to answer.

**Current amendment:** separate the contexts instead of suppressing the agenda.
The literature's own mitigation is separated private reasoning and public speech —
an agent may privately note a suspicion and publicly say something else, provided
the private note is not in the context that generates the public line. A strategy
call plans with full knowledge; a speech call executes in a fresh context holding
only the cover story and the chosen tactic. See §6.

The distinction matters because it changes what is being defended. "The model
never knows the plot" is a capability restriction. "The context that plans is
never the context that speaks" is a plumbing constraint — testable, and it costs
the antagonist nothing.

The equivocation finding still stands as a caution: the model devises the
*strategy*, and the engine supplies the *facts* the strategy operates on, so a
weakly-worded lie still moves belief by the same arithmetic as a strong one.

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
