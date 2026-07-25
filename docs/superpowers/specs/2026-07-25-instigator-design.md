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

### The culprit record

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

**Full accounting for a 360-tick run.** An earlier draft of this table costed
cognition at ~180 calls, which is wrong: it counted one embedding per round and
missed that `think()` embeds **twice** — once for the situation query vectors
(`cognition.ts:269`) and again for the memories the round produced
(`cognition.ts:451`). Corrected, at 60 rounds of 6 ticks:

| Consumer | Per round | Total |
|---|---|---|
| Situation embedding | 1 | 60 |
| Plan calls (`spotlightMax` = 2) | 2 | 120 |
| Reflection (2 agents × 30%) | ~0.6 | ~36 |
| Output-memory embedding | 1 | 60 |
| **Cognition subtotal** | **4.6** | **~276** |
| Dialogue speech calls (1 per 6 ticks) | | 60 |
| Instigator strategy calls (1 per 12 ticks) | | 30 |
| **Unattended subtotal** | | **~366** |
| Bursts (`burstMax` 6 rather than 2) | | variable |
| Rumor distortion (`GOSSIP.distortionChance` 15%) | | variable |
| Player conversation (classify + reply) | | ~2 per utterance |
| `inquire` disclosure decisions | | ~1 per inquiry |
| Summon attendance decisions | | ~1 per summon |

So an *unattended* world already spends ~366 of a 400 budget, and this design is
about a world that is not unattended: the investigation is entirely player
conversation, and a hearing costs one attendance decision per summons. A
30-minute session of steady play plausibly reaches 550–650.

**`COGNITION.callBudget` rises from 400 to 900.** That is not a comfortable
round number chosen for headroom; it is ~366 unattended plus room for roughly 150
player utterances and their attendant decisions, which is more than a 30-minute
session can physically produce. The per-world cap still exists and still degrades
to deterministic cognition when hit — the point of the cap is that a runaway
world cannot bill unboundedly, not that a normal world must feel it.

**Cost per world must be measured, not estimated.** `world_budget` already
records `tokens_in`, `tokens_out` and `est_cost_micros`; a real figure comes from
one instrumented Bedrock run of the canonical arc, and the number belongs in the
plan rather than in this spec. Raising the cap by 2.25× raises the worst-case
per-world spend by the same factor, which is the tradeoff being accepted here.

The strategy call remains the cheapest agency in the design — 30 calls buys the
antagonist its entire strategic repertoire, because one strategy decision governs
several ticks of execution. That is the option-action split from *Lyfe Agents*
(§11): decide rarely and expensively, execute often and cheaply. If the budget
needs trimming later, cognition's double embedding pass is the first place to
look, not the antagonist.

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

#### The provenance defect this design originally sat on

An earlier draft made `world_rumor_spread.from_agent_id` the backbone of the
investigation. **That table cannot carry it.** Its primary key is
`(world_id, rumor_id, agent_id)` and `gossip.ts:189` inserts
`ON CONFLICT DO NOTHING` — by deliberate design, documented in the comment above
it, the table records **first contact only** and is never rewritten.

The consequence is fatal to the puzzle rather than merely lossy. Decision 9 in
`docs/plan.md` establishes that belief hardens by *re-hearing*, so being told a
rumor repeatedly is the normal case, not an edge case. If the instigator tells
someone who has already heard it from a neighbour, **the instigator's telling
leaves no trace at all**, and the provenance chain points at whichever
townsperson happened to speak first. The player chases the chain diligently and
arrives at an innocent person, every time, by construction.

So the investigation needs a record of *every telling*, not of first contact.
`world_rumor_spread` stays exactly as it is — it is load-bearing for the
retell cooldown and for the wording an agent received — and a new append-only
table sits beside it. See §8 for `world_rumor_tellings`.

#### The three channels

**Provenance (`inquire`).** `inquire` is currently a no-op that warms sentiment
(`converse.ts:535`). Wire it to `world_rumor_tellings`.

Whether an NPC gives their source up is a character decision, not a threshold:
"do I protect the person who told me this" is exactly the kind of choice that
makes someone feel like a person. The engine supplies trust, sentiment, faction
alignment and who the sources actually were; the model chooses from
`{name_them, deflect, misdirect, demand_something_first}`. A flat refusal is
deliberately not in the set — it is a tell, and it ends the thread.

Because tellings are now plural, `name_them` names **the most recent teller of
that claim to this agent**, which is the one an agent would actually remember and
the one the instigator most likely is. The engine owns the fact in every branch:
under `name_them` it supplies the real `from_agent_id` from the telling row;
under `misdirect` it picks the false name from agents this NPC actually knows.
**The model never types a name that becomes evidence.**

**Contradiction.** The engine detects that one agent has pushed mutually
incompatible claims to the player or in the player's hearing — blaming both
Houses for the same death. Detection is a query over `world_events` the player
witnessed, joined to the claims those events carried. Not a model judgment.

**Records.** The granary books, the customs ledger, the physician's altered
record — authored, obtained by inquiring of the right person in the right place.

Each channel writes a typed `world_player_evidence` row (§8) that references the
immutable history row it was derived from, so the exposure check in §6 can be
recomputed from history rather than trusted as an accumulated counter.

### Exposure — the win

A per-world claim `instigator_exposed`, subject = the culprit, `truth='true'`.

**Instantiated at tick 0 in a locked state, not created at runtime.** An earlier
draft had it absent until unlocked, which does not survive a rewind:
`rewind.ts` clears the tables in `HISTORY_TABLES` and `world_claims` is not among
them — correctly, since claims are instantiated rather than accumulated. A
runtime-created claim would therefore persist through a rewind and come back
already unlocked. The claim row exists from the start with
`locked = true`; unlocking is a `world_events` row and a flag flip, both of which
a rewind removes and re-derives. Locked claims are excluded from every
player-facing read model and cannot be the subject of an accusation.

It unlocks when the player holds all three of: **3 provenance links** — three
distinct `world_rumor_tellings` rows naming the culprit as `from_agent_id`, for
at least two distinct claims, so a single rumor told three times does not qualify
— **1 contradiction**, and **1 record**. Once unlocked the player accuses with it
exactly like any other claim, and the existing rumor machinery carries it.

Evidence is *recomputed* from the referenced history rows at check time rather
than trusted as a counter, so a rewound world re-derives the same answer.

These numbers are the difficulty dial and are the most likely thing to be wrong
on first pass; §9 treats winnability as unproven until the harness measures it.

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

**(c) A hearing is an entity, not a set of loose commitments.** Commitments alone
cannot answer which summons belong to one hearing, who convened it, when it
starts, how long people stay, or who is in the audience when the reveal lands —
and an agent marked `kept` on early arrival is free to wander off before anyone
else shows up. So `world_hearings` owns the event and commitments reference it.
DDL in §8.

**Lifecycle:** `announced → gathering → in_session → resolved | abandoned`.

- **Location and due tick are resolved by the engine, not the model.** The
  `summon` classification yields a location key from the scenario's own list and
  a phase offset; the engine converts these to ids and a tick. An unresolvable
  location makes the summon a no-op that still records the utterance.
- **Minimum feasible travel.** `due_tick` must be at least
  `max(shortest-path cost from each summoned agent's current location)` plus a
  slack constant, computed from the route graph. A hearing nobody can physically
  reach is rejected at `converse` time with a reason, rather than silently
  producing an empty room.
- **Hold window.** An attendee who arrives stays until `due_tick + HEARING.holdTicks`
  or until the hearing resolves, whichever is first — implemented as the
  commitment remaining `pending` through the window rather than flipping to
  `kept` on arrival. `kept` is set at resolution for those actually present;
  `broken` for those who never came.
- **Concurrency.** Multiple hearings may exist at one location and tick; the
  audience of a reveal is the attendee set of *that* `hearing_id`, never everyone
  standing there. Agents present but not summoned are perceivers of the
  `world_event` — as they are for any event — but are not audience for the
  belief effects.

`movement.ts` checks commitments **before** routine: a pending commitment whose
`due_tick` is within travel distance overrides the phase's scheduled location.
This is the same multi-tick-intent machinery §4 builds for goals, so it is
largely already paid for.

**Whether they come is a character decision**, per §4's principle — the model
chooses from `{come, decline, come_but_tell_someone}` given trust, sentiment,
reputation, and faction. The third option is the interesting one: an agent may
agree in good faith and then mention it to the wrong person. **The player's own
witnesses can leak the hearing.**

**(d) Audience-scoped effects, resolved inside the tick.** An accusation made to
a hearing applies belief movement to **every attendee**, scaled by each
listener's own alignment through the existing `beliefs.ts` path. Saying it to a
room is materially different from saying it five times in five streets, which
today it is not.

**The reveal is resolved by `runTick`, not by `converse`** — a deliberate
departure from how every other player utterance works, forced by two facts about
the existing engine:

1. **Sequence space.** `PLAYER_SEQ_STRIDE` is 16 and `SEQ_REPLY` is pinned at
   offset 15 (`converse.ts:71`), leaving 14 sequence slots for a command's
   effects. A hearing with up to 29 attendees needs a `belief_updates` row each;
   it would overrun its own reply and then the next command's band, and
   `(world_id, tick, seq)` is UNIQUE, so this is a hard failure rather than a
   cosmetic one.
2. **The tension cap.** `TENSION.maxRisePerTick` is enforced in tick escalation.
   Effects applied directly in `converse` bypass it — tolerable for a single
   accusation, not for the largest event the engine can produce.

Resolving in the tick fixes both at once: the tick's own `Seq` allocates freely,
and the aggregate rise passes through the existing cap so a hearing cannot vault
a stage. It also matches the fiction — a hearing is a scheduled event that
happens at a tick, not an utterance that happens instantly.

The player's utterance is still recorded and answered immediately by `converse`;
what defers is the audience effect. `converse` writes a `hearing_reveal` intent
onto the hearing row, and the next tick drains it in step 6 alongside the other
pending commands.

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
dropped and the previous posture holds — which requires the previous posture to
be *stored*. It lives in `world_scheme_state` (§8), alongside the ladder
position and the tactic currently being executed; `world_agent_goals` carries
priority and status only and cannot hold any of it.

The world still cannot be ended by a model — see §6.

---

## 8. Persistence, state, and replay

### 8.1 Scenario content — where culprits, goals and schemes live

`publish.ts` writes `scenario_versions` (with `opening` as JSONB) plus normalized
template tables for factions, locations, agents, claims and triggers;
`instantiate.ts` can only reload what those tables hold. There is currently
nowhere for a culprit candidate, a principal's goal, or a scheme template to go.

Three new template tables, following the existing normalized style rather than
adding JSONB blobs, so that validation happens at publish and loading is a plain
ordered query:

```sql
CREATE TABLE culprit_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions,
  culprit_key         STRING NOT NULL,       -- == the agent_key
  motive_key          STRING NOT NULL,
  profit_claim_key    STRING NOT NULL,       -- how war pays them
  record_claim_key    STRING NOT NULL,       -- the ledger that documents it
  -- Per-candidate truth resolution: claim_key -> 'true'|'false'|'unknown'.
  -- The only JSONB here, because it is a variable-length map the rules never
  -- order on — schema convention 9.
  claim_truth         JSONB NOT NULL,
  PRIMARY KEY (scenario_version_id, culprit_key)
);

CREATE TABLE agent_goal_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions,
  agent_key           STRING NOT NULL,
  goal_key            STRING NOT NULL,
  priority            INT8 NOT NULL,
  PRIMARY KEY (scenario_version_id, agent_key, goal_key)
);

CREATE TABLE scheme_templates (
  scenario_version_id UUID NOT NULL REFERENCES scenario_versions,
  scheme_key          STRING NOT NULL,
  ladder_index        INT8 NOT NULL,         -- stub-mode execution order
  tactic              STRING NOT NULL,       -- validated against the closed set
  audience            STRING NOT NULL,       -- faction key or location key
  claim_key           STRING NULL,
  condition           JSONB NOT NULL,        -- existing trigger DSL Condition
  PRIMARY KEY (scenario_version_id, scheme_key),
  UNIQUE (scenario_version_id, ladder_index)
);
```

**Validation at publish**, not at runtime: every `claim_key`, `agent_key` and
`audience` must resolve against the same scenario version; every `tactic` must
be in the closed set; every `condition` must parse under the existing allowlisted
grammar. A scenario naming an agent that does not exist is rejected at
`publish.ts`, which is where every other referential check already happens.

**Deterministic culprit selection.** The chosen candidate is derived by hashing
`(seed, scenario_version_id)` and indexing into the candidate list **ordered by
`culprit_key`** — never by a UUID (decision 12), and *not* by drawing from the
simulation RNG. Deriving it rather than drawing it means instantiation cannot
shift the generator stream that every later tick depends on, which is decision
13's rule applied at world-creation time. Same seed, same culprit, always.

At instantiation the chosen candidate's `claim_truth` map overwrites the
per-world `world_claims.truth` values, which is what makes the same claim `false`
in one world and `true` in another (§3).

### 8.2 Per-world state

```sql
-- The instigator's live strategy. One row per scheming agent.
CREATE TABLE world_scheme_state (
  world_id          UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id          UUID NOT NULL,
  posture           STRING NOT NULL
                      CHECK (posture IN ('press','lie_low','redirect','force')),
  ladder_index      INT8 NOT NULL,          -- stub-mode position
  current_tactic    STRING NULL,
  target_agent_id   UUID NULL,
  claim_id          UUID NULL,
  executes_until    INT8 NOT NULL,          -- tactic runs to this tick
  next_strategy_tick INT8 NOT NULL,         -- when to think again
  updated_tick      INT8 NOT NULL,
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, target_agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, claim_id) REFERENCES world_claims (world_id, claim_id)
);

-- Every telling, append-only. NOT a replacement for world_rumor_spread, which
-- keeps its first-contact semantics for the retell cooldown and the wording an
-- agent received. This is the forensic record the investigation reads.
CREATE TABLE world_rumor_tellings (
  world_id      UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  telling_id    UUID NOT NULL,
  rumor_id      UUID NOT NULL,
  claim_id      UUID NOT NULL,
  from_agent_id UUID NULL,                  -- NULL when seeded by the world
  to_agent_id   UUID NOT NULL,
  event_id      UUID NULL,                  -- the dialogue/accusation it rode on
  tick          INT8 NOT NULL,
  seq           INT8 NOT NULL,
  channel       STRING NOT NULL
                  CHECK (channel IN ('gossip','dialogue','accusation','player')),
  PRIMARY KEY (world_id, telling_id),
  UNIQUE (world_id, tick, seq),
  FOREIGN KEY (world_id, rumor_id) REFERENCES world_rumors (world_id, rumor_id),
  FOREIGN KEY (world_id, to_agent_id) REFERENCES world_agents (world_id, agent_id)
);

CREATE INDEX world_rumor_tellings_source_idx
  ON world_rumor_tellings (world_id, to_agent_id, claim_id, tick DESC);

CREATE TABLE world_hearings (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  hearing_id   UUID NOT NULL,
  convener_id  UUID NOT NULL,               -- world_players
  location_id  UUID NOT NULL,
  due_tick     INT8 NOT NULL,
  status       STRING NOT NULL CHECK (status IN
                 ('announced','gathering','in_session','resolved','abandoned')),
  reveal_claim_id UUID NULL,                -- set by converse, drained by the tick
  announced_tick  INT8 NOT NULL,
  resolved_tick   INT8 NULL,
  PRIMARY KEY (world_id, hearing_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);

CREATE TABLE world_agent_commitments (
  world_id     UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL,
  hearing_id   UUID NULL,                   -- NULL for non-hearing commitments
  location_id  UUID NOT NULL,
  due_tick     INT8 NOT NULL,
  source       STRING NOT NULL CHECK (source IN ('player','trigger','agent')),
  response     STRING NOT NULL CHECK (response IN
                 ('come','decline','come_but_tell_someone')),
  status       STRING NOT NULL CHECK (status IN ('pending','kept','broken')),
  created_tick INT8 NOT NULL,
  PRIMARY KEY (world_id, agent_id, due_tick),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_agents (world_id, agent_id),
  FOREIGN KEY (world_id, hearing_id) REFERENCES world_hearings (world_id, hearing_id),
  FOREIGN KEY (world_id, location_id) REFERENCES world_locations (world_id, location_id)
);

-- Typed, and referencing the immutable row it was derived from, so the exposure
-- check recomputes from history rather than trusting an accumulated counter.
CREATE TABLE world_player_evidence (
  world_id      UUID NOT NULL REFERENCES worlds (world_id) ON DELETE CASCADE,
  player_id     UUID NOT NULL,
  evidence_id   UUID NOT NULL,
  kind          STRING NOT NULL
                  CHECK (kind IN ('provenance','contradiction','record')),
  -- provenance: the telling that was disclosed. contradiction/record: the event.
  telling_id    UUID NULL,
  event_id      UUID NULL,
  claim_id      UUID NULL,
  accused_id    UUID NULL,                  -- who this points at
  genuine       BOOL NOT NULL,              -- false when the NPC misdirected
  found_tick    INT8 NOT NULL,
  PRIMARY KEY (world_id, evidence_id),
  -- One disclosure per source row per player: re-asking is not more evidence.
  UNIQUE (world_id, player_id, kind, telling_id, event_id),
  FOREIGN KEY (world_id, telling_id) REFERENCES world_rumor_tellings (world_id, telling_id)
);
```

**`genuine = false` rows are stored, not discarded.** A misdirection the player
believed is exactly the kind of thing the dashboard should be able to show, and
the exposure check simply filters on `genuine = true` — so a player who chased
three false leads has three evidence rows and no unlock, which is the correct
and legible outcome.

### 8.3 `detained` is a new agent status

Exposure sets the culprit to `status='detained'`, but `world_agents.status`
permits only `alive | injured | missing | dead` (`schema.sql:257`). Adding the
ending value alone is not enough. Required changes:

- The `status` CHECK gains `'detained'`.
- Every rule query filtering `status = 'alive'` must be audited — spotlight
  selection (`cognition.ts:118`), gossip listener loading, accusation candidates,
  and movement. A detained agent neither acts nor is acted upon, but is **not**
  dead: hard triggers keyed on `agent_status = 'dead'` must not fire for them.
- `api.ts` read models and the dashboard legend.
- Scenario validation, which currently accepts a template `status` from the same
  four values.
- `rewind.ts`, which must restore the culprit to their instantiated status.

### 8.4 Rewind and replay

`rewind.ts` clears `HISTORY_TABLES` and rebuilds projections. The new state
divides in two, and getting the split wrong is how a rewound world silently
starts already-solved.

**Appended to `HISTORY_TABLES`** (removed by a rewind, re-derived by replay):
`world_rumor_tellings`, `world_player_evidence`, `world_agent_commitments`,
`world_hearings`.

**Reset in place** (rows exist from instantiation; a rewind restores initial
values rather than deleting them): `world_scheme_state` back to
`posture='press'`, `ladder_index=0`, null tactic; `world_agent_goals` back to
template status; `world_culprit.exposed_tick` to NULL; the culprit's
`world_agents.status` back to its instantiated value; `world_claims.locked` back
to `true` for `instigator_exposed`.

**Not touched:** `world_culprit.agent_id`. The culprit is a property of
`(seed, scenario_version)`, not of the run, so a rewind must not reselect — a
world that changed murderer on rewind would fail its own replay on the first
divergent belief update.

**Model decisions and where each is recorded.** The engine already has two
recording mechanisms and they stay separate:

| Decision | Made during | Recorded in |
|---|---|---|
| plan, reflect | tick | `cognition_records`, `task='plan' \| 'reflect'` |
| dialogue line | tick | `cognition_records`, `task='dialogue'` |
| instigator strategy | tick | `cognition_records`, `task='strategy'` |
| summon attendance | tick | `cognition_records`, `task='attendance'` |
| utterance classification | converse | `world_commands` outcome payload |
| `inquire` disclosure choice | converse | `world_commands` outcome payload |
| NPC reply text | converse | `world_commands` outcome payload |

Converse-time decisions already replay through the command log and its
idempotency guard (decision 18); they need no new machinery, only to be included
in the outcome payload stamped inside the effects transaction. Tick-time
decisions go through `cognition_records` and its input-hash refusal.

`cognition_records.task` therefore takes `plan | reflect | dialogue | strategy |
attendance`.

### 8.5 Module summary

**New engine modules:** `goals.ts`, `schemes.ts`, `dialogue.ts`, `evidence.ts`,
`exposure.ts`, `hearings.ts`.

**Modified:** `converse.ts` (`inquire` effects and disclosure recording, evidence
capture, the `summon` act, deferred hearing reveal, reputation-weighted
persuasion), `runtick.ts` (dialogue, scheme, hearing-resolution and
commitment steps), `cognition.ts` (goal-aware prompts, new record tasks),
`gossip.ts` (**write a `world_rumor_tellings` row on every transmission**, beside
the unchanged first-contact `world_rumor_spread` upsert), `movement.ts`
(commitments outrank routine), `accusations.ts` (tellings on public accusation),
`rewind.ts` (§8.4), `peace.ts` (the `exposed` ending path),
`config.ts` (new constants), `scenario/schema.ts`, `scenario/publish.ts` and
`scenario/instantiate.ts` (culprit/goal/scheme templates, deterministic
selection, per-world truth resolution, 30 agents), `db/schema.sql`,
`engine/api.ts` (read models, locked-claim and detained filters).

**New tables:** `world_culprit`, `world_agent_goals`, `world_scheme_state`,
`world_rumor_tellings`, `world_hearings`, `world_agent_commitments`,
`world_player_evidence` — plus scenario templates `culprit_templates`,
`agent_goal_templates`, `scheme_templates` (§8.1).

**New speech act:** `summon` — the tenth, and the first that asks for something
rather than asserting something. `SPEECH_ACTS`, the classifier's allowlist, and
`world_commands.kind` all grow by one.

**Altered:** `worlds.ending` CHECK gains `'exposed'`; `world_agents.status` CHECK
gains `'detained'` (§8.3); `world_claims` gains `locked BOOL NOT NULL DEFAULT
false`; `cognition_records` gains a `task` discriminator taking `plan`,
`reflect`, `dialogue`, `strategy`, `attendance`.

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
- **Scope is substantial and grew under review**: 6 new modules, 7 new per-world
  tables plus 3 scenario template tables, three altered CHECK constraints, and
  changes to the three largest files in the engine. The implementation plan
  should sequence this so that persistence and replay land *before* the
  behavioural work, since every later step writes to the tables in §8.
- **There is a pre-existing test failure to triage first.** A review run reported
  the existing "accusation is carried onward" test failing, alongside heavy
  CockroachDB contention that stopped the integration suite after five minutes.
  Whether that is a genuine regression on `main` or an artefact of contention is
  unknown, and it must be settled before any of this work starts — building on a
  red suite makes every later failure ambiguous.

---

## 10. Acceptance tests

Added to the existing suite in `engine/*.test.ts`:

**Scenario persistence**
- A published scenario round-trips: `publish` then `instantiate` reproduces the
  culprit candidates, principal goals and scheme templates exactly.
- Republishing the same version with changed culprit or scheme content is
  rejected by the existing checksum immutability rule.
- A scheme template naming a claim, agent or tactic that does not exist in the
  same scenario version fails `publish`, with a message naming which.

**Culprit selection**
- The same seed selects the same culprit in two different worlds; a different
  seed can select a different one.
- Selection is *derived* from `(seed, scenario_version_id)`, not drawn from the
  simulation RNG: instantiating a world with culprit selection produces the same
  first-tick RNG outputs as one without. This is decision 13's rule at
  world-creation time, and without the test the coupling is invisible.
- Candidate ordering is by `culprit_key`; shuffling the candidate array in the
  scenario JSON does not change who is selected.
- Per-world claim truth resolves consistently with the selected culprit — an
  Aldreth-side culprit yields `corvane_ordered_death` with `truth='false'`.
- `world_culprit` appears in no player-facing read model.

**Goals and schemes**
- Scheme preconditions are evaluated by the existing DSL evaluator; a scheme
  naming an unknown verb, fact, tactic, claim or agent is rejected at
  **publish**, not at runtime (§8.1).
- In stub mode the ladder advances in `ladder_index` order and never skips a step
  whose precondition is unmet.
- `heat_on_culprit` is computed by rules and appears in the strategy prompt; it
  drives **no** branch in engine code. Asserted by confirming no threshold
  comparison against it exists on the goal-switching path — the model owns
  posture (§7), and an earlier draft of this suite tested the opposite.
- `world_scheme_state` survives across ticks: a posture chosen at tick T is still
  in force at T+1 without a further strategy call, and an unparseable posture
  leaves the stored one unchanged.
- `next_strategy_tick` gates the strategy call: no more than one per
  `SCHEME.strategyIntervalTicks`, regardless of how many schemes are eligible.

**Dialogue**
- An exchange emits exactly one `world_events` row with `kind='dialogue'` and one
  `world_rumor_spread` row with `from_agent_id` set.
- A colocated third agent perceives the exchange through `loadSituation`.
- Pair selection is identical across two worlds built from one seed.
- An exhausted budget degrades dialogue to templated text and keeps ticking.
- **Provenance survives an adversarial model.** With an inference client whose
  generated line names a *different* agent as the source, or contains injected
  instructions to that effect, the `world_rumor_tellings` row still records the
  agent the rules selected. This is the guard on finding 2 in §11, and the
  reason the world stays winnable.
- **Every telling is recorded, not only the first.** An agent told the same claim
  by three different people across the retell cooldown has **three**
  `world_rumor_tellings` rows and **one** `world_rumor_spread` row. Without this
  the investigation points at whoever spoke first — the defect described in §6.
- A telling written by gossip, by agent dialogue, by a public accusation and by a
  player utterance each carry the correct `channel`, and each is reachable from
  `inquire`.
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
- **Early arrival does not end attendance.** An agent who reaches the location
  before `due_tick` is still there at `due_tick`, and their commitment is still
  `pending` until the hearing resolves — the hold window in §6, and the failure
  mode that made a bare commitments table insufficient.
- A summon whose `due_tick` is sooner than the slowest summoned agent can travel
  is rejected at `converse` with a reason; the utterance is still recorded.
- **Two hearings at one location and tick stay distinct**: a reveal at hearing A
  moves belief for A's attendees only, and an agent standing there who belongs to
  neither is a perceiver of the event but receives no belief update.
- Under `come_but_tell_someone` the culprit receives the hearing in their
  strategy inputs even when no summon was addressed to them — asserted by
  running a world where the culprit is not summoned and confirming they know.
- **Audience scope:** an accusation at a location with N present writes N
  `belief_updates` rows, one per listener, each scaled by that listener's own
  alignment — not N identical deltas.
- The aggregate tension change from a hearing is clamped by
  `TENSION.maxRisePerTick`, and a hearing cannot advance a stage within its own
  tick. This holds specifically because the reveal resolves in `runTick`, not in
  `converse` — a test that applies the reveal through the conversation path must
  fail.
- **Sequence safety:** a hearing with the maximum possible audience writes all
  its `belief_updates` without colliding with the conversation's reply slot or
  the next command's band. Asserted at 29 attendees, above the 14 usable slots in
  `PLAYER_SEQ_STRIDE`, since this is precisely the case the old design broke on.
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

**Detained**
- Setting the culprit to `detained` is accepted by the `world_agents.status`
  CHECK, and a detained agent is excluded from spotlight selection, gossip
  listeners, accusation candidates and movement.
- A detained culprit does **not** fire the `agent_status = 'dead'` hard triggers.
  Exposing the instigator must not read as an assassination and jump the world
  to war — which is exactly what would happen if `detained` were modelled as a
  flavour of `dead`.
- `rewind.ts` restores the culprit's instantiated status.

**Rewind and replay of the new state**
- After a rewind, `instigator_exposed` is locked again and cannot be accused
  with. This currently cannot fail because the claim does not exist; it is the
  regression guard on the defect in §6, where a runtime-created claim survived
  rewind because `world_claims` is deliberately not in `HISTORY_TABLES`.
- After a rewind: no tellings, no evidence, no commitments, no hearings;
  `world_scheme_state` back to `press` / index 0 / null tactic; goals back to
  template status; `world_culprit.exposed_tick` NULL.
- **The culprit does not change on rewind.** Re-running a rewound world produces
  the same culprit and the same claim truths — a world that reselected would
  diverge from its own recording at the first belief update.
- A recorded run containing dialogue, a strategy call, an attendance decision, an
  `inquire` disclosure and a hearing replays with **zero** inference calls,
  reproducing the same stage, tension, belief table and evidence set.

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
