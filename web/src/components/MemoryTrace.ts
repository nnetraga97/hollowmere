import { createElement as h, type ReactNode } from 'react';

import type { AgentDetail } from '../lib/contracts.ts';
import { memoryPathAriaLabel, memoryPathLabel } from '../lib/memoryTrace.ts';

export function MemoryTrace({ memories }: { memories: AgentDetail['memoryTrace'] }) {
  return h('section', { className: 'memory-trace', 'aria-labelledby': 'memory-trace-title' },
    h('h3', { id: 'memory-trace-title' }, 'Memory trace'),
    h('p', { className: 'memory-trace-note' },
      'Grounded memories from this world only. Identifiers are selectable for verification.'),
    memories.length === 0
      ? h('p', { className: 'empty' }, 'No grounded memory has formed yet.')
      : memories.map((memory) => h('article', {
        className: 'memory-trace-card', key: memory.memoryId,
      },
      h('header', null,
        h('b', null, memory.kind),
        h('span', null, `formed t${memory.formedTick}`)),
      h('p', null, memory.excerpt),
      h('dl', null,
        traceField('memory', h('code', { title: memory.memoryId }, memory.memoryId)),
        traceField('source', h('span', null, memory.sourceKind),
          h('code', { title: memory.sourceId }, memory.sourceId)),
        traceField('last accessed',
          memory.lastAccessedTick == null ? 'not recalled' : `t${memory.lastAccessedTick}`),
        memory.claimKey ? traceField('claim', memory.claimKey) : null,
        memory.recalledByTurnId
          ? traceField('recalled by', h('code', {
            title: memory.recalledByTurnId,
          }, memory.recalledByTurnId))
          : null),
      memory.candidatePaths.length > 0
        ? h('div', {
          className: 'memory-paths',
          'aria-label': memoryPathAriaLabel(memory.candidatePaths),
        }, memory.candidatePaths.map((path) => h('span', { key: path }, memoryPathLabel(path))))
        : null)),
  );
}

function traceField(label: string, ...values: ReactNode[]) {
  return h('div', { key: label }, h('dt', null, label), h('dd', null, ...values));
}
