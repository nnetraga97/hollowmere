# Hollowmere romance design

## Product contract

Hollowmere has exactly two authored romance routes: Lady Maren Aldreth and
Rowan Corvane. They are the heirs on opposing sides of the central conflict.
Both routes can be completed in one world. Neither route reads, changes, or
locks the status of the other.

The relationships are PG-13, explicitly consensual, and valid as romance,
intimate uncertainty, enduring friendship, a complicated bond, or a strained
relationship. Friendship is authored as an ending rather than treated as a
failed romance. A harsh choice can delay later scenes through the existing
trust/affinity/respect requirements, but ordinary conversation can repair the
bond; there is no permanent “wrong answer” lockout.

## Genre research translated into Hollowmere

- *Fire Emblem: Three Houses* ties support ranks to staged character scenes,
  personal growth, side stories, and mechanical outcomes. Hollowmere uses six
  persistent chapters per route and makes their consequences affect the town.
  Nintendo's overview: <https://www.nintendo.com/au/news-and-articles/fire-emblem-three-houses-101/>
- *Final Fantasy VII Rebirth* lets broad story actions, side activity, and
  dialogue contribute to affinity before a bespoke intimate scene. Hollowmere
  similarly reads the durable four-axis relationship already changed by normal
  conversations; romance is not raised by “correct flirting” alone.
  Mechanics overview: <https://finalfantasy.fandom.com/wiki/Affection_mechanics_(VII_Rebirth)>
- *Persona 5 Royal* uses a sequence of confidant scenes with a plainly signaled
  romantic decision. Hollowmere preserves the staged intimacy and clear choice,
  but removes exclusivity and one-answer permanent lockouts.
  Route structure overview: <https://www.rpgsite.net/feature/5479-persona-5-royal-confidant-guide-conversation-choices-answers-romance-options-gifts-skill-unlocks>

All characters, scenes, choices, dialogue, and outcomes in Hollowmere are
original. The references above informed structure only.

## Route structure

| Chapter | Maren: Salt on the Window | Rowan: Where the River Keeps Its Name | Narrative job |
|---|---|---|---|
| 1 | The Rain Between Bells | The Broken Lantern | Establish how each person receives care and where their boundaries begin. |
| 2 | In the Ledger Margin | What the Tide Carried | Put a true investigation thread inside the bond. |
| 3 | A Name Without a Title | The Long Way Home | Reveal the private wound and ask the player to respond to need, not a role. |
| 4 | A Candle for the Harbour | The Gate Left Open | Force a morally imperfect public decision with faction consequences. |
| 5 | Before the Town Wakes | Stones Beneath the River | Offer an explicit romance, honest uncertainty, or friendship choice. |
| 6 | Two Keys | The Bridge at Low Water | Define a committed, independent, or platonic future. |

Every chapter has three choices and distinct calm/crisis dialogue. Later scenes
recall concrete earlier flags instead of only displaying a larger meter.

## Simulation effects

Romance choices are server-authoritative, idempotent player commands. They can:

- change trust, affinity, fear, respect, and the NPC's durable impression;
- reveal existing claim keys without inventing new objective truth;
- heat or cool an existing rumor;
- change player reputation and house tension;
- make a faction willing to negotiate;
- add one tick of time debt, so intimacy consumes time while the town moves;
- write an append-only romance event and a normal chronicle event;
- alter the relationship context used by future generated conversations; and
- produce route/status-specific epilogues for peace, exposure, or war.

The engine never infers plot effects from prose. Every consequence is selected
from the authored choice definition and applied transactionally in CockroachDB.

## Character behavior under pressure

Maren controls emotion by controlling information. Low tension makes her test
whether the player can respect ambition without worshipping power. As the town
hardens, she protects workers before reputation and becomes willing to expose
her own house if a trusted player helps her separate accountability from
surrender.

Rowan protects vulnerable people by withholding himself. Low tension makes him
quietly investigate while accepting suspicion. As accusations spread, his
silence becomes harmful; a trusted player can help him testify without using a
witness as collateral. His growth is learning that asking for help is not a
debt and that martyrdom is not the same as honor.

The complete authored voice, wounds, desires, contradictions, affection and
conflict styles, tells, boundaries, action logic, 12 scenes, and 36 responses
live in `engine/romance-content.ts`.
