# Town Archivist query guide

The Town Archivist is a read-only investigation workflow for one explicitly
selected Hollowmere world. It never infers a world from a browser cookie and it
never queries embeddings, prompt inputs, provider responses, or connection
configuration.

## Required boundary

Replace `$1` with the exact world UUID visible in the public demo. Every query
must keep `WHERE world_id = $1`; a query without that predicate is incomplete
and must not be used in the recorded workflow.

The three stable views are:

- `archivist_memory_sources`: durable memories and their originating turn,
  event, or memory edge.
- `archivist_memory_accesses`: append-only records proving when a memory was
  retrieved.
- `archivist_cognition`: bounded NPC and player-turn outcomes with recalled
  memory identifiers, without replay vectors or hidden prompt inputs.

## Canonical trace queries

Find the demonstrated memory and its source:

```sql
SELECT memory_id, agent_key, memory_tick, memory_kind, memory_excerpt,
       claim_key, source_kind, source_id, source_turn_ordinal,
       source_player_text, source_reply, source_event_tick,
       source_event_kind, source_event_description
  FROM archivist_memory_sources
 WHERE world_id = $1
   AND agent_key = 'tobias_reeve'
   AND claim_key = 'physician_was_paid'
 ORDER BY memory_tick, memory_id, edge_id;
```

Trace retrieval of that memory:

```sql
SELECT access_id, memory_id, agent_key, claim_key, memory_tick, accessed_tick
  FROM archivist_memory_accesses
 WHERE world_id = $1
   AND memory_id = $2
 ORDER BY accessed_tick, access_id;
```

Find the later outcome that names the recalled memory:

```sql
SELECT outcome_kind, outcome_id, agent_key, tick, task, model_id,
       prompt_version, recalled_memories, outcome_summary
  FROM archivist_cognition
 WHERE world_id = $1
   AND agent_key = 'tobias_reeve'
 ORDER BY tick, outcome_kind, outcome_id;
```

The `recalled_memories` value on a `conversation_turn` contains the recorded
memory IDs and all candidate paths. The canonical proof passes only when the
demonstrated memory includes `ann`; `importance`, `recency`, or
`pinned_anchor` alone is not vector-retrieval evidence.

## Canonical prompt

> For world `<world_id>`, trace how the claim `physician_was_paid` reached
> `tobias_reeve`. Return the originating conversation turn, durable memory,
> retrieval/access event, later cognition or dialogue outcome, and simulation
> ticks. Use identifiers from the database and state when a link is inferred
> rather than directly recorded.

Use CockroachDB Cloud Managed MCP over HTTPS with OAuth `mcp:read` only. The
direct SQL role `hollowmere_reader` remains for first-party read models and is
not the Managed MCP authentication mechanism.
