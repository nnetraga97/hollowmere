'use client';

import type { SocialGraph, TensionPoint } from '@/lib/contracts';

const SCALE = 10_000;

export function TensionChart({ points }: { points: TensionPoint[] }) {
  if (!points.length) return <p className="empty">No tension history yet.</p>;
  const width = 620, height = 150;
  const maxTick = Math.max(1, ...points.map((point) => point.tick));
  const path = points.map((point, index) => {
    const x = 8 + point.tick / maxTick * (width - 16);
    const y = height - 8 - point.globalTension / SCALE * (height - 16);
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Global tension by simulation tick">
    <path d={path} fill="none" stroke="var(--gold)" strokeWidth="2" />
  </svg>;
}

export function SocialGraphView({ graph }: { graph: SocialGraph }) {
  const width = 680, height = 420;
  const nodes = graph.nodes.map((node, index) => {
    const factionOffset = node.factionKey === 'aldreth' ? -150 : node.factionKey === 'corvane' ? 150 : 0;
    const angle = index * 2.399963;
    const radius = 35 + (index % 7) * 18;
    return { ...node, x: width / 2 + factionOffset + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
  });
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return <svg className="social-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Social relationship graph">
    {graph.edges.map((edge, index) => {
      const from = byKey.get(edge.src), to = byKey.get(edge.dst);
      if (!from || !to) return null;
      return <line key={`${edge.src}-${edge.dst}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke={edge.sentiment < 0 ? '#bd6659' : '#7ba271'} strokeOpacity={0.35} strokeWidth={Math.max(1, Math.abs(edge.sentiment) / 2500)} />;
    })}
    {nodes.map((node) => <g key={node.key} transform={`translate(${node.x} ${node.y})`}>
      <circle r="6" fill={node.factionKey === 'aldreth' ? '#78a7ca' : node.factionKey === 'corvane' ? '#ce865f' : '#aaa08e'} />
      <text x="9" y="4">{node.name.split(' ')[0]}</text>
    </g>)}
  </svg>;
}
