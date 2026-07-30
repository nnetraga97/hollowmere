import type { AgentDetail } from './contracts';

type MemoryPath = AgentDetail['memoryTrace'][number]['candidatePaths'][number];

const PATH_LABELS: Record<MemoryPath, string> = {
  ann: 'ANN / vector',
  importance: 'importance',
  recency: 'recency',
  pinned_anchor: 'pinned anchor',
};

export function memoryPathLabel(path: MemoryPath): string {
  return PATH_LABELS[path];
}

export function memoryPathAriaLabel(paths: readonly MemoryPath[]): string {
  return `Retrieval paths: ${paths.map(memoryPathLabel).join(', ')}`;
}
