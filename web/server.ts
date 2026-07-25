/**
 * Debug dashboard — read-only.
 *
 * This is an instrument, not a game client. It exists so that a claim like "a
 * false rumour reached thirty-one people and hardened into belief in two
 * houses" can be checked rather than asserted, and so that the engine's own
 * behaviour — tick latency, serialization retries, model spend — is visible
 * while a world runs.
 *
 * It writes nothing. Every route is a read model from engine/api.ts, and the
 * process is meant to be started with `DATABASE_URL` pointing at the read-only
 * role in db/read-only-role.sql, so "read-only" is enforced by the database
 * rather than by this file's good intentions.
 *
 * Deliberately dependency-free: no framework, no bundler, no build step. The
 * Phaser client and the player-facing Next.js service in later phases sit on
 * the same `engine/api.ts` functions, so nothing here is on their critical path
 * and none of it needs to survive them.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  getBeliefHistory, getBeliefSnapshot, getChronicle, getClaims, getCognition,
  getFactions, getSocialGraph, getTensionCurve, getTickMetrics, getWorldSummary,
  listAgents, listWorlds,
} from '../engine/api.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, 'dashboard.html');

const PORT = Number(process.env.DASHBOARD_PORT ?? 8099);

/**
 * Routes, in one table.
 *
 * Every handler takes the query string and returns JSON. `world` is required by
 * all of them except the world list — a read model without a world id is the
 * one shape that could cross the isolation boundary, so there is no route that
 * omits it.
 */
const ROUTES: Record<string, (params: URLSearchParams) => Promise<unknown>> = {
  '/api/worlds': async () => listWorlds(Number(process.env.DASHBOARD_WORLD_LIMIT ?? 25)),

  '/api/world': async (params) => getWorldSummary(required(params, 'world')),

  '/api/agents': async (params) => listAgents(required(params, 'world')),

  '/api/factions': async (params) => getFactions(required(params, 'world')),

  '/api/claims': async (params) => getClaims(required(params, 'world')),

  '/api/tension': async (params) => getTensionCurve(required(params, 'world')),

  '/api/graph': async (params) => getSocialGraph(
    required(params, 'world'),
    Number(params.get('min') ?? 2_500),
  ),

  '/api/chronicle': async (params) => getChronicle(required(params, 'world'), {
    limit: Number(params.get('limit') ?? 60),
    includeMovement: params.get('movement') === '1',
  }),

  '/api/belief': async (params) => getBeliefHistory(
    required(params, 'world'), required(params, 'agent'), required(params, 'claim'),
  ),

  '/api/belief-snapshot': async (params) => getBeliefSnapshot(
    required(params, 'world'), required(params, 'claim'), Number(params.get('tick') ?? 0),
  ),

  '/api/cognition': async (params) => getCognition(
    required(params, 'world'), Number(params.get('limit') ?? 30),
  ),

  '/api/metrics': async (params) => getTickMetrics(required(params, 'world')),
};

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) throw new BadRequest(`missing required parameter "${name}"`);
  return value;
}

class BadRequest extends Error {}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

    // Read-only in the HTTP sense too: nothing here answers a mutating method.
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'this dashboard is read-only' }));
      return;
    }

    // Answered rather than 404'd purely to keep the browser console clean; a
    // stray error there trains you to ignore the console, which is where the
    // real ones show up.
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = await readFile(PAGE, 'utf8');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }

    const handler = ROUTES[url.pathname];
    if (!handler) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'no such route' }));
      return;
    }

    try {
      const body = await handler(url.searchParams);
      response.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    } catch (error) {
      const status = error instanceof BadRequest ? 400 : 500;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }));
      if (status === 500) {
        console.error(JSON.stringify({
          level: 'error', event: 'dashboard_query_failed',
          path: url.pathname,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  })();
});

server.listen(PORT, () => {
  console.log(`dashboard on http://localhost:${PORT}`);
});
