'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';

import styles from './DesignTweaksOverlay.module.css';

const STORAGE_KEY = 'hollowmere.local-design-tweaks.v1';
const CATEGORY_VALUES = ['visual', 'content', 'interaction', 'accessibility'] as const;
const TARGET_SELECTOR = [
  '[data-tweak-id]',
  '[data-testid]',
  '[id]',
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'summary',
  'label',
  '[role]',
  'main',
  'header',
  'nav',
  'section',
  'article',
  'aside',
  'form',
  'fieldset',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
].join(',');

type TweakCategory = typeof CATEGORY_VALUES[number];

interface TweakTarget {
  kind: 'dom';
  label: string;
  stableId?: string;
  selector?: string;
  selectorConfidence: 'stable' | 'derived';
  role?: string;
  accessibleName?: string;
  fingerprint: {
    tag?: string;
    ancestorLabels?: string[];
    textExcerpt?: string;
  };
}

interface TweakNote {
  version: 1;
  id: string;
  createdAt: string;
  route: string;
  viewport: { width: number; height: number };
  target: TweakTarget;
  comment: string;
  category?: TweakCategory;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface HoverState {
  element: HTMLElement;
  rect: Rect;
  label: string;
  blocked: boolean;
}

interface ComposerState {
  mode: 'create' | 'edit';
  noteId?: string;
  target: TweakTarget;
  comment: string;
  category: TweakCategory | '';
}

type Hit =
  | { kind: 'overlay' | 'empty' }
  | { kind: 'blocked'; element: HTMLElement }
  | { kind: 'target'; element: HTMLElement };

function isLocalDevelopment(): boolean {
  if (process.env.NODE_ENV !== 'development' || typeof window === 'undefined') return false;
  const hostname = window.location.hostname.toLowerCase();
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStoredNote(value: unknown): value is TweakNote {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || typeof value.createdAt !== 'string' || typeof value.route !== 'string'
    || typeof value.comment !== 'string' || !isRecord(value.viewport) || !isRecord(value.target)) {
    return false;
  }
  const { viewport, target } = value;
  if (typeof viewport.width !== 'number' || typeof viewport.height !== 'number'
    || target.kind !== 'dom' || typeof target.label !== 'string'
    || (target.selectorConfidence !== 'stable' && target.selectorConfidence !== 'derived')
    || !isRecord(target.fingerprint)) {
    return false;
  }
  return value.category === undefined || CATEGORY_VALUES.includes(value.category as TweakCategory);
}

function readStoredNotes(): TweakNote[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredNote) : [];
  } catch {
    return [];
  }
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{16,}\b/g, '[redacted token]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted email]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted number]')
    .replace(/\b[A-Za-z0-9+/_-]{48,}\b/g, '[redacted value]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeCssValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\\"');
}

function escapeCssId(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^A-Za-z0-9_-]/g, '\\$&');
}

function getImplicitRole(element: HTMLElement): string | undefined {
  const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return 'combobox';
  if (tag !== 'input') return undefined;
  const type = (element.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
  return 'textbox';
}

function labelledByText(element: HTMLElement): string {
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

function labelTextForControl(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  for (const label of Array.from(element.labels ?? [])) {
    // Prefer a dedicated label node when present. This avoids serializing a
    // textarea's current value or a live character counter from its wrapper.
    const explicit = Array.from(label.children).find((child) =>
      child.matches('span, legend, strong, b'));
    if (explicit?.textContent?.trim()) return sanitizeText(explicit.textContent, 120);

    const directText = Array.from(label.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ');
    if (directText.trim()) return sanitizeText(directText, 120);
  }
  return '';
}

function getAccessibleName(element: HTMLElement): string | undefined {
  const labelledBy = labelledByText(element);
  const labelled = element.getAttribute('aria-label') ?? labelledBy;
  if (labelled.trim()) return sanitizeText(labelled, 120);

  if (element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement) {
    const labelText = labelTextForControl(element);
    if (labelText.trim()) return sanitizeText(labelText, 120);
  }

  const tag = element.tagName.toLowerCase();
  const title = element.getAttribute('title');
  if (title?.trim()) return sanitizeText(title, 120);
  if (tag === 'img') {
    const alt = element.getAttribute('alt');
    if (alt?.trim()) return sanitizeText(alt, 120);
  }
  if (['button', 'a', 'summary'].includes(tag)) {
    const text = sanitizeText(element.textContent ?? '', 120);
    if (text) return text;
  }
  return undefined;
}

function isSensitiveElement(element: HTMLElement): boolean {
  if (element.matches('input[type="password"], input[type="hidden"], [data-tweak-exclude]')) return true;
  return element.getAttribute('autocomplete') === 'current-password'
    || element.getAttribute('autocomplete') === 'new-password';
}

function hasStableSelector(element: HTMLElement): { id: string; selector: string } | null {
  const tweakId = element.getAttribute('data-tweak-id');
  if (tweakId) {
    return {
      id: 'data-tweak-id=' + tweakId,
      selector: '[data-tweak-id="' + escapeCssValue(tweakId) + '"]',
    };
  }
  const testId = element.getAttribute('data-testid');
  if (testId) {
    return {
      id: 'data-testid=' + testId,
      selector: '[data-testid="' + escapeCssValue(testId) + '"]',
    };
  }
  if (element.id) return { id: 'id=' + element.id, selector: '#' + escapeCssId(element.id) };
  return null;
}

function structuralSelector(element: HTMLElement): string {
  const direct = hasStableSelector(element);
  if (direct) return direct.selector;

  const segments: string[] = [];
  let current: HTMLElement | null = element;
  let anchor: string | null = null;

  while (current && current !== document.body && segments.length < 6) {
    const stable = hasStableSelector(current);
    if (stable) {
      anchor = stable.selector;
      break;
    }

    const currentTag = current.tagName;
    const tag = currentTag.toLowerCase();
    let segment = tag;
    const role = current.getAttribute('role');
    if (role) segment += '[role="' + escapeCssValue(role) + '"]';

    const container: HTMLElement | null = current.parentElement;
    if (container) {
      const sameType = Array.from(container.children)
        .filter((child: Element) => child.tagName === currentTag);
      if (sameType.length > 1) segment += ':nth-of-type(' + (sameType.indexOf(current) + 1) + ')';
    }
    segments.unshift(segment);

    if (tag === 'main' || tag === 'body') break;
    current = container;
  }

  return [anchor, ...segments].filter(Boolean).join(' > ') || element.tagName.toLowerCase();
}

function fingerprintFor(element: HTMLElement): TweakTarget['fingerprint'] {
  const ancestorLabels: string[] = [];
  let current = element.parentElement;

  while (current && current !== document.body && ancestorLabels.length < 3) {
    const stable = hasStableSelector(current);
    const role = getImplicitRole(current);
    const tag = current.tagName.toLowerCase();
    if (stable) ancestorLabels.push(stable.id);
    else if (role) ancestorLabels.push(tag + '[role=' + role + ']');
    else if (['main', 'header', 'nav', 'section', 'article', 'aside', 'form'].includes(tag)) {
      ancestorLabels.push(tag);
    }
    current = current.parentElement;
  }

  return {
    tag: element.tagName.toLowerCase(),
    ...(ancestorLabels.length ? { ancestorLabels } : {}),
  };
}

function targetFor(element: HTMLElement): TweakTarget {
  const role = getImplicitRole(element);
  const accessibleName = getAccessibleName(element);
  const stable = hasStableSelector(element);
  const namedControl = !stable && role && accessibleName
    && ['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch', 'menuitem', 'tab'].includes(role);
  const fallback = structuralSelector(element);

  const stableId = stable?.id ?? (namedControl ? 'role=' + role + ';name=' + accessibleName : undefined);
  const label = accessibleName
    ? accessibleName + (role ? ' ' + role : '')
    : stable?.id ?? element.tagName.toLowerCase() + (role ? ' ' + role : '');

  return {
    kind: 'dom',
    label: sanitizeText(label, 160),
    ...(stableId ? { stableId: sanitizeText(stableId, 180) } : {}),
    selector: fallback,
    selectorConfidence: stable ? 'stable' : 'derived',
    ...(role ? { role } : {}),
    ...(accessibleName ? { accessibleName } : {}),
    fingerprint: fingerprintFor(element),
  };
}

function findEligibleElement(start: HTMLElement): HTMLElement | null {
  if (isSensitiveElement(start)) return null;
  const candidate = start.closest(TARGET_SELECTOR);
  if (!(candidate instanceof HTMLElement) || isSensitiveElement(candidate)) return null;
  return candidate;
}

function hitAt(x: number, y: number): Hit {
  const raw = document.elementFromPoint(x, y);
  if (!raw) return { kind: 'empty' };
  const element = raw instanceof HTMLElement ? raw : raw.parentElement;
  if (!element) return { kind: 'empty' };
  if (element.closest('[data-design-tweaks-root]')) return { kind: 'overlay' };
  const canvasSurface = element.closest('canvas, .game-canvas');
  if (canvasSurface instanceof HTMLElement) return { kind: 'blocked', element: canvasSurface };
  const target = findEligibleElement(element);
  return target ? { kind: 'target', element: target } : { kind: 'empty' };
}

function rectFor(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'tweak-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function noteContext(note: TweakNote): string {
  const details = [
    note.target.role ? 'role ' + note.target.role : '',
    note.target.accessibleName ? 'name ' + note.target.accessibleName : '',
    note.target.fingerprint.tag ? 'tag ' + note.target.fingerprint.tag : '',
    note.target.fingerprint.ancestorLabels?.length
      ? 'within ' + note.target.fingerprint.ancestorLabels.join(' > ')
      : '',
  ].filter(Boolean);
  return details.join('; ');
}

function handoffFor(notes: TweakNote[]): string {
  const lines = [
    '# Local design-tweak handoff',
    '',
    'Implement only the reviewed changes below. Inspect the source before changing it.',
    '',
  ];

  notes.forEach((note, index) => {
    lines.push(String(index + 1) + '. Comment: ' + sanitizeText(note.comment, 600));
    if (note.category) lines.push('   Category: ' + note.category);
    lines.push('   Page: ' + note.route);
    lines.push('   Viewport: ' + note.viewport.width + 'x' + note.viewport.height);
    lines.push('   Target: ' + note.target.label);
    if (note.target.stableId) lines.push('   Stable target: ' + note.target.stableId);
    if (note.target.selector) {
      lines.push('   Fallback selector: ' + note.target.selector + ' (' + note.target.selectorConfidence + ')');
    }
    const context = noteContext(note);
    if (context) lines.push('   Context: ' + context);
    lines.push('');
  });

  return lines.join('\n').trim() + '\n';
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the local document fallback.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

export function DesignTweaksOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [notes, setNotes] = useState<TweakNote[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isInspectingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<number | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setEnabled(isLocalDevelopment());
  }, []);

  useEffect(() => {
    isInspectingRef.current = isInspecting;
  }, [isInspecting]);

  useEffect(() => {
    if (!enabled) return;
    setNotes(readStoredNotes());
    setNotesLoaded(true);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !notesLoaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch {
      setNotice('Could not save notes in this browser.');
    }
  }, [enabled, notes, notesLoaded]);

  const composerKey = composer
    ? (composer.noteId ?? 'new') + ':' + composer.target.selector
    : null;

  useEffect(() => {
    if (!composerKey) return;
    const frame = window.requestAnimationFrame(() => commentRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [composerKey]);

  useEffect(() => {
    if (!enabled) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isInspectingRef.current && !composer && !trayOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (composer) {
        setComposer(null);
        window.requestAnimationFrame(() => (returnFocusRef.current ?? launcherRef.current)?.focus());
      } else if (isInspectingRef.current) {
        setIsInspecting(false);
        setHovered(null);
        launcherRef.current?.focus();
      } else {
        setTrayOpen(false);
        launcherRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [composer, enabled, trayOpen]);

  useEffect(() => {
    if (!enabled) return;
    const block = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const suppressFollowup = () => {
      suppressClickRef.current = true;
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
      suppressTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressTimerRef.current = null;
      }, 500);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!isInspectingRef.current) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit.kind === 'target') {
        const target = targetFor(hit.element);
        const next: HoverState = {
          element: hit.element,
          rect: rectFor(hit.element),
          label: target.label,
          blocked: false,
        };
        setHovered((current) => current?.element === next.element
          && current.blocked === next.blocked
          && current.rect.top === next.rect.top
          && current.rect.left === next.rect.left
          && current.rect.width === next.rect.width
          && current.rect.height === next.rect.height
          ? current
          : next);
        return;
      }
      if (hit.kind === 'blocked') {
        const next: HoverState = {
          element: hit.element,
          rect: rectFor(hit.element),
          label: 'Phaser map canvas — out of this DOM review scope',
          blocked: true,
        };
        setHovered((current) => current?.element === next.element && current.blocked
          ? current
          : next);
        return;
      }
      setHovered(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!isInspectingRef.current) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (hit.kind === 'overlay') return;
      block(event);
      suppressFollowup();
      if (hit.kind === 'blocked') {
        setNotice('The Phaser map is intentionally excluded from this DOM-only review.');
        return;
      }
      if (hit.kind !== 'target') return;
      returnFocusRef.current = launcherRef.current;
      setComposer({
        mode: 'create',
        target: targetFor(hit.element),
        comment: '',
        category: '',
      });
      setTrayOpen(true);
      setIsInspecting(false);
      setHovered(null);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!suppressClickRef.current || hitAt(event.clientX, event.clientY).kind === 'overlay') return;
      block(event);
    };
    const onClick = (event: MouseEvent) => {
      if (!isInspectingRef.current && !suppressClickRef.current) return;
      if (event.target instanceof Element && event.target.closest('[data-design-tweaks-root]')) return;
      block(event);
      suppressClickRef.current = false;
      if (suppressTimerRef.current !== null) {
        window.clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = null;
      }
    };
    const refreshHover = () => {
      setHovered((current) => current
        ? { ...current, rect: rectFor(current.element) }
        : current);
    };

    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('resize', refreshHover);
    window.addEventListener('scroll', refreshHover, true);
    return () => {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('resize', refreshHover);
      window.removeEventListener('scroll', refreshHover, true);
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current);
    };
  }, [enabled]);

  if (!enabled) return null;

  function closeComposer() {
    setComposer(null);
    window.requestAnimationFrame(() => (returnFocusRef.current ?? launcherRef.current)?.focus());
  }

  function startInspecting() {
    returnFocusRef.current = launcherRef.current;
    setTrayOpen(true);
    setComposer(null);
    setNotice(null);
    setIsInspecting(true);
  }

  function stopInspecting() {
    setIsInspecting(false);
    setHovered(null);
    launcherRef.current?.focus();
  }

  function saveComposer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!composer) return;
    const comment = sanitizeText(composer.comment, 600);
    if (!comment) {
      setNotice('Add a short comment before saving.');
      commentRef.current?.focus();
      return;
    }

    if (composer.mode === 'edit' && composer.noteId) {
      setNotes((current) => current.map((note) => note.id === composer.noteId
        ? {
          ...note,
          comment,
          ...(composer.category ? { category: composer.category } : { category: undefined }),
        }
        : note));
    } else {
      const note: TweakNote = {
        version: 1,
        id: createId(),
        createdAt: new Date().toISOString(),
        route: window.location.pathname,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        target: composer.target,
        comment,
        ...(composer.category ? { category: composer.category } : {}),
      };
      setNotes((current) => [note, ...current]);
    }

    setNotice('Saved locally in this browser.');
    setComposer(null);
    setTrayOpen(true);
    window.requestAnimationFrame(() => launcherRef.current?.focus());
  }

  function openEditor(note: TweakNote, origin: HTMLElement) {
    returnFocusRef.current = origin;
    setIsInspecting(false);
    setComposer({
      mode: 'edit',
      noteId: note.id,
      target: note.target,
      comment: note.comment,
      category: note.category ?? '',
    });
    setTrayOpen(true);
  }

  function deleteNote(note: TweakNote) {
    if (!window.confirm('Delete this local design-tweak note?')) return;
    setNotes((current) => current.filter((item) => item.id !== note.id));
    setNotice('Deleted local note.');
  }

  function clearNotes() {
    if (!notes.length || !window.confirm('Clear all local design-tweak notes?')) return;
    setNotes([]);
    setNotice('Cleared all local notes.');
  }

  async function copyHandoff() {
    if (!notes.length) return;
    const copied = await copyText(handoffFor(notes));
    setNotice(copied ? 'Copied a Markdown handoff. Notes are still saved locally.' : 'Could not copy the handoff.');
  }

  function exportJson() {
    if (!notes.length) return;
    const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'hollowmere-design-tweaks-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setNotice('Exported local notes as JSON.');
  }

  const highlightStyle = hovered
    ? {
      top: hovered.rect.top,
      left: hovered.rect.left,
      width: Math.max(1, hovered.rect.width),
      height: Math.max(1, hovered.rect.height),
    }
    : undefined;

  return createPortal(
    <div className={styles.root} data-design-tweaks-root="true">
      {hovered && <div
        className={hovered.blocked ? styles.blockedHighlight : styles.highlight}
        style={highlightStyle}
        aria-hidden="true"
      >
        <span>{hovered.label}</span>
      </div>}

      <button
        ref={launcherRef}
        className={styles.launcher}
        type="button"
        aria-expanded={trayOpen || Boolean(composer)}
        aria-controls="local-design-tweaks-tray"
        onClick={() => {
          setTrayOpen((open) => !open);
          setComposer(null);
          setIsInspecting(false);
          setHovered(null);
        }}
      >
        Tweaks{notes.length ? ' (' + notes.length + ')' : ''}
      </button>

      {notice && <p className={styles.notice} role="status">{notice}</p>}

      {composer ? <section
        className={styles.composer}
        id="local-design-tweaks-composer"
        role="dialog"
        aria-labelledby="local-design-tweaks-composer-title"
      >
        <header>
          <div>
            <span className={styles.kicker}>Local design tweak</span>
            <h2 id="local-design-tweaks-composer-title">{composer.mode === 'edit' ? 'Edit note' : 'Comment on selection'}</h2>
          </div>
          <button type="button" className={styles.quietButton} onClick={closeComposer}>Cancel</button>
        </header>
        <p className={styles.targetSummary}>{composer.target.label}</p>
        <form onSubmit={saveComposer}>
          <label>
            Comment
            <textarea
              ref={commentRef}
              value={composer.comment}
              maxLength={600}
              onChange={(event) => setComposer((current) => current
                ? { ...current, comment: event.target.value }
                : current)}
              placeholder="Describe the change you want reviewed."
            />
          </label>
          <label>
            Category <span>optional</span>
            <select
              value={composer.category}
              onChange={(event) => setComposer((current) => current
                ? { ...current, category: event.target.value as TweakCategory | '' }
                : current)}
            >
              <option value="">No category</option>
              <option value="visual">Visual</option>
              <option value="content">Content</option>
              <option value="interaction">Interaction</option>
              <option value="accessibility">Accessibility</option>
            </select>
          </label>
          <div className={styles.composerActions}>
            <button type="button" className={styles.quietButton} onClick={closeComposer}>Cancel</button>
            <button type="submit" className={styles.primaryButton}>Save local note</button>
          </div>
        </form>
      </section> : trayOpen && <section
        className={styles.tray}
        id="local-design-tweaks-tray"
        role="region"
        aria-label="Local Design Tweaks"
      >
        <header>
          <div>
            <span className={styles.kicker}>Development only</span>
            <h2>Design Tweaks</h2>
          </div>
          <button type="button" className={styles.quietButton} onClick={() => setTrayOpen(false)}>Close</button>
        </header>
        <p className={styles.description}>Select normal web UI, save a local note, then copy a Codex-ready handoff. The Phaser map is excluded.</p>
        <div className={styles.inspectActions}>
          <button type="button" className={styles.primaryButton} onClick={isInspecting ? stopInspecting : startInspecting}>
            {isInspecting ? 'Stop inspecting' : 'Inspect UI'}
          </button>
          {isInspecting && <span className={styles.inspectHint}>Click a highlighted DOM element. Escape cancels.</span>}
        </div>
        <div className={styles.noteList}>
          {notes.length ? notes.map((note) => <article className={styles.note} key={note.id}>
            <div>
              <span className={styles.noteRoute}>{note.route}</span>
              <strong>{note.target.label}</strong>
              <p>{note.comment}</p>
              {note.category && <small>{note.category}</small>}
            </div>
            <div className={styles.noteActions}>
              <button type="button" onClick={(event) => openEditor(note, event.currentTarget)}>Edit</button>
              <button type="button" onClick={() => deleteNote(note)}>Delete</button>
            </div>
          </article>) : <p className={styles.empty}>No local notes yet.</p>}
        </div>
        <footer className={styles.trayActions}>
          <button type="button" onClick={() => void copyHandoff()} disabled={!notes.length}>Copy handoff</button>
          <button type="button" onClick={exportJson} disabled={!notes.length}>Export JSON</button>
          <button type="button" className={styles.dangerButton} onClick={clearNotes} disabled={!notes.length}>Clear all</button>
        </footer>
      </section>}
    </div>,
    document.body,
  );
}
