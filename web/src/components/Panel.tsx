'use client';

import type { ReactNode } from 'react';

export function Panel({ title, onClose, children, wide = false }: {
  title: string; onClose(): void; children: ReactNode; wide?: boolean;
}) {
  return <aside className={`panel ${wide ? 'panel-wide' : ''}`} aria-label={title}>
    <header className="panel-header"><h2>{title}</h2><button onClick={onClose} aria-label={`Close ${title}`}>×</button></header>
    <div className="panel-body">{children}</div>
  </aside>;
}
