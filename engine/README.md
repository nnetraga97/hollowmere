# Engine module map

The engine is organized by responsibility so a change can start in one
predictable place instead of scanning a flat directory.

| Folder | Owns |
| --- | --- |
| `core/` | Deterministic shared primitives: configuration, fixed-point math, random seeds, sequencing, IDs, and logging. |
| `database/` | CockroachDB connection and scheduler/world lifecycle coordination. |
| `simulation/` | Tick orchestration, movement, escalation, endings, world rewinds, and scenario triggers. |
| `social/` | Beliefs, gossip, evidence, and memory retrieval. |
| `agents/` | NPC cognition, goals, dialogue, schemes, hearings, accusations, and model budget decisions. |
| `player/` | Player-facing game reads, conversations, speech actions, and romance routes. |
| `inference/` | Provider-neutral inference contracts plus Azure, Bedrock, and deterministic stub clients. |
| `testing/` | Test-only helpers shared by feature tests. |

Tests live alongside the feature they cover. Keep shared, dependency-light code
in `core/`; have feature modules depend inward on `core/`, `database/`, and
`inference/` rather than the other way around.
