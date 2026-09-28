import { randomUUID } from 'node:crypto';
import type { ElementHandle, Page } from '@playwright/test';
import type { Observation, ObservedElement } from '@qa/contracts';
import { ensureEvalShim } from './shim.ts';
import { installIdentify } from './identify.ts';

/** Bumped whenever extraction semantics change; part of the pinned decision configuration. */
export const OBSERVATION_EXTRACTOR_VERSION = 'observe-v1';

/** Stays below the 255-option provider limit with room for NONE / NEED_MORE_CONTEXT. */
export const DEFAULT_MAX_CANDIDATES = 200;

interface RawExtraction {
  document_id: string;
  route: string;
  title: string;
  viewport: { width: number; height: number };
  elements: Array<ObservedElement & { actionable: boolean }>;
  messages: Array<{ role: string; text: string }>;
  frames: number;
  shadow_roots: number;
  errors: string[];
}

/**
 * Runs in the page. Registers every interactive element in a per-document
 * registry (`window.__qaRegistry`) keyed by an ephemeral node id. A navigation
 * creates a new document and therefore a new registry, so ids from an older
 * observation can never resolve against a newer page.
 */
function extractInPage(maxText: number): RawExtraction {
  type Reg = { documentId: string; next: number; nodes: Map<string, Element>; ids: WeakMap<Element, string> };
  const w = window as unknown as { __qaRegistry?: Reg };
  if (!w.__qaRegistry) w.__qaRegistry = { documentId: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, next: 0, nodes: new Map(), ids: new WeakMap() };
  const reg = w.__qaRegistry;
  const errors: string[] = [];
  const clip = (s: string) => (s.length > maxText ? `${s.slice(0, maxText)}…` : s);
  const norm = (s: string | null | undefined) => clip((s ?? '').replace(/\s+/g, ' ').trim());

  const SELECTOR = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=option],[contenteditable=""],[contenteditable=true]';
  const implicitRole = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    return 'generic';
  };
  const byIds = (ids: string | null) =>
    norm(
      (ids ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  const accessibleName = (el: Element): string => {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) return byIds(labelled);
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '';
      if (norm(labels)) return norm(labels);
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type)) return norm(el.value);
      return norm(el.getAttribute('placeholder') ?? el.getAttribute('title'));
    }
    return norm((el as HTMLElement).innerText || el.textContent || el.getAttribute('title'));
  };
  const context = (el: Element, sel: string): string | undefined => {
    const c = el.closest(sel);
    if (!c) return undefined;
    const name = c.getAttribute('aria-label') ?? (c.getAttribute('aria-labelledby') ? byIds(c.getAttribute('aria-labelledby')) : c.querySelector('h1,h2,h3,legend')?.textContent);
    return norm(name) || c.tagName.toLowerCase();
  };
  const sensitive = (el: Element) =>
    (el instanceof HTMLInputElement && el.type === 'password') || /pass|secret|token|cc-|card/i.test(`${el.getAttribute('autocomplete') ?? ''} ${el.getAttribute('name') ?? ''}`);

  let shadowRoots = 0;
  const all: Element[] = [];
  const collect = (root: Document | ShadowRoot) => {
    root.querySelectorAll(SELECTOR).forEach((e) => all.push(e));
    root.querySelectorAll('*').forEach((e) => {
      if (e.shadowRoot) shadowRoots++;
    });
  };
  collect(document);

  const elements: RawExtraction['elements'] = [];
  for (const el of all) {
    try {
      let id = reg.ids.get(el);
      if (!id) {
        id = `n${reg.next++}`;
        reg.ids.set(el, id);
        reg.nodes.set(id, el);
      }
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden],dialog:not([open])');
      const disabled = (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
      const ident = (window as unknown as { __qaIdentify(e: Element): { role: string; name: string; form?: string; section?: string; tag: string } }).__qaIdentify(el);
      const role = ident.role;
      const tag = ident.tag;
      const editable = !disabled && ((tag === 'input' && role === 'textbox' && !(el as HTMLInputElement).readOnly) || (tag === 'textarea' && !(el as HTMLTextAreaElement).readOnly) || (el as HTMLElement).isContentEditable);
      const ops: ObservedElement['supported_operations'] = [];
      if (visible && !disabled) {
        if (editable) ops.push('TYPE');
        if (tag === 'select') ops.push('SELECT');
        if (!editable && tag !== 'select') ops.push('CLICK');
      }
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (sensitive(el) ? (el.value ? '[REDACTED]' : '') : clip(el.value)) : el instanceof HTMLSelectElement ? norm(el.selectedOptions[0]?.textContent) : undefined;
      const item: RawExtraction['elements'][number] = {
        node_id: id,
        role,
        name: ident.name,
        tag,
        visible,
        enabled: !disabled,
        editable,
        in_viewport: inViewport,
        supported_operations: ops,
        bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        actionable: ops.length > 0,
      };
      if (el instanceof HTMLInputElement) item.input_type = el.type;
      if (value !== undefined) item.value = value;
      if (ident.section) item.section = ident.section;
      if (ident.form) item.form = ident.form;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) item.checked = el.checked;
      const expanded = el.getAttribute('aria-expanded');
      if (expanded !== null) item.expanded = expanded === 'true';
      if (el instanceof HTMLSelectElement) item.options = [...el.options].map((o) => norm(o.textContent));
      elements.push(item);
    } catch (e) {
      errors.push(String(e));
    }
  }
  const messages = [...document.querySelectorAll('[role=alert],[role=status],[aria-live]')]
    .map((m) => ({ role: m.getAttribute('role') ?? 'live', text: norm((m as HTMLElement).innerText) }))
    .filter((m) => m.text);
  return {
    document_id: reg.documentId,
    route: location.pathname,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    elements,
    messages,
    frames: document.querySelectorAll('iframe,frame').length,
    shadow_roots: shadowRoots,
    errors,
  };
}

export interface ObserveOptions {
  pageId: string;
  currentMilestone?: string;
  milestonesCompleted?: string[];
  recentOutcomes?: Observation['recent_outcomes'];
  maxCandidates?: number;
  maxText?: number;
}

/**
 * Acquire a coherent snapshot of the page. Actionable candidates are kept
 * separate from diagnostic elements (disabled/hidden controls), and any
 * truncation or unsupported content is reported rather than silently dropped.
 */
export async function observe(page: Page, o: ObserveOptions): Promise<Observation> {
  await page.waitForLoadState('load');
  await ensureEvalShim(page);
  await installIdentify(page);
  const raw = await page.evaluate(extractInPage, o.maxText ?? 120);
  const max = o.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const actionable = raw.elements.filter((e) => e.actionable);
  // Prefer in-viewport candidates when truncating; document order otherwise.
  const ranked = [...actionable].sort((a, b) => Number(b.in_viewport) - Number(a.in_viewport));
  const kept = new Set(ranked.slice(0, max).map((e) => e.node_id));
  const strip = ({ actionable: _a, ...e }: RawExtraction['elements'][number]): ObservedElement => e;
  return {
    observation_id: randomUUID(),
    document_id: raw.document_id,
    page_id: o.pageId,
    timestamp: new Date().toISOString(),
    route: raw.route,
    title: raw.title,
    viewport: raw.viewport,
    ...(o.currentMilestone ? { current_milestone: o.currentMilestone } : {}),
    milestones_completed: o.milestonesCompleted ?? [],
    recent_outcomes: (o.recentOutcomes ?? []).slice(-5),
    candidates: actionable.filter((e) => kept.has(e.node_id)).map(strip),
    diagnostics: raw.elements.filter((e) => !e.actionable).map(strip),
    messages: raw.messages,
    coverage: {
      candidates_total: actionable.length,
      candidates_included: kept.size,
      truncated: kept.size < actionable.length,
      unsupported_frames: raw.frames,
      shadow_roots_skipped: raw.shadow_roots,
      extraction_errors: raw.errors,
    },
  };
}

export type NodeResolution = { ok: true; handle: ElementHandle<Element> } | { ok: false; reason: 'stale_document' | 'detached' | 'unknown_node' };

/** Resolve a node id from an observation against the *current* document. */
export async function resolveNode(page: Page, documentId: string, nodeId: string): Promise<NodeResolution> {
  await ensureEvalShim(page);
  const handle = await page.evaluateHandle(
    ([doc, id]) => {
      const reg = (window as unknown as { __qaRegistry?: { documentId: string; nodes: Map<string, Element> } }).__qaRegistry;
      if (!reg || reg.documentId !== doc) return 'stale_document';
      const el = reg.nodes.get(id);
      if (!el) return 'unknown_node';
      return el.isConnected ? el : 'detached';
    },
    [documentId, nodeId] as const,
  );
  const el = handle.asElement();
  if (el) return { ok: true, handle: el as ElementHandle<Element> };
  const reason = (await handle.jsonValue()) as 'stale_document' | 'detached' | 'unknown_node';
  await handle.dispose();
  return { ok: false, reason };
}
