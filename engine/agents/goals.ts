import type { Client } from '../database/db.ts';

export interface AgentGoal {
  key: string;
  priority: number;
  status: 'active' | 'suspended' | 'achieved' | 'abandoned';
}

export async function loadAgentGoals(
  client: Client,
  worldId: string,
  agentId: string,
): Promise<AgentGoal[]> {
  const result = await client.query<{
    goal_key: string;
    priority: number;
    status: AgentGoal['status'];
  }>(
    `SELECT goal_key, priority, status
       FROM world_agent_goals
      WHERE world_id = $1 AND agent_id = $2
      ORDER BY priority DESC, goal_key`,
    [worldId, agentId],
  );
  return result.rows.map((row) => ({
    key: row.goal_key,
    priority: row.priority,
    status: row.status,
  }));
}

export async function suspendGoals(
  client: Client,
  worldId: string,
  agentId: string,
  tick: number,
): Promise<void> {
  await client.query(
    `UPDATE world_agent_goals SET status = 'suspended', updated_tick = $3
      WHERE world_id = $1 AND agent_id = $2 AND status = 'active'`,
    [worldId, agentId, tick],
  );
}
