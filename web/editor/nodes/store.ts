// The nodes a view needs: one realtime provider (socket, Y.Doc, awareness,
// threads) per node, opened on demand as mounts are discovered, and dropped
// when they leave the tree. The root's provider is the page's own.

import type { Thread } from '../../lib/api';
import { DocProvider, type DocInfo } from '../provider';
import { MARKER_RE, type NodeText } from './layout';

export interface NodeThread extends Thread { node: string }

type Listener = () => void;

export class NodeStore {
  readonly providers = new Map<string, DocProvider>();
  readonly info = new Map<string, DocInfo & { section: boolean; type: string }>();
  /** Nodes we tried to open and could not (no access, deleted). Their markers stay literal. */
  readonly unavailable = new Set<string>();
  private threadsByNode = new Map<string, Thread[]>();
  private changeListeners = new Set<Listener>();
  private threadListeners = new Set<(threads: NodeThread[], events: { node: string; kind: string; threadId: string; commentId: string; actor: string }[]) => void>();
  private metaListeners = new Set<(id: string) => void>();
  private textObservers = new Map<string, () => void>();
  private destroyed = false;

  constructor(readonly root: string, rootProvider: DocProvider) {
    this.adopt(root, rootProvider);
  }

  get(id: string): DocProvider | undefined { return this.providers.get(id); }
  has(id: string): boolean { return this.providers.has(id); }

  /** Every node currently open, root first. */
  ids(): string[] { return [this.root, ...[...this.providers.keys()].filter((id) => id !== this.root)]; }

  source = (id: string): NodeText | undefined => {
    const p = this.providers.get(id);
    if (!p) {
      if (this.unavailable.has(id)) return undefined;
      // Discovered through a marker: open it (next tick, never inside a Yjs observer).
      queueMicrotask(() => this.open(id));
      return { text: '', title: '', type: 'markdown', loaded: false, readable: true };
    }
    const i = this.info.get(id);
    return { text: p.synced ? p.ytext.toString() : '', title: i?.title ?? '', type: i?.type ?? 'markdown', loaded: p.synced, readable: true };
  };

  /** Open a node's provider if it is not open yet. */
  open(id: string): DocProvider | null {
    if (this.destroyed || this.unavailable.has(id)) return null;
    const have = this.providers.get(id);
    if (have) return have;
    const p = new DocProvider(id);
    this.adopt(id, p);
    return p;
  }

  private adopt(id: string, p: DocProvider) {
    this.providers.set(id, p);
    p.on('hello', ({ doc }) => { if (doc) this.setInfo(id, doc); });
    p.on('meta', (doc) => this.setInfo(id, doc));
    p.on('synced', () => this.fire());
    p.on('threads', (threads, events) => {
      this.threadsByNode.set(id, threads);
      const evs = events.map((e) => ({ ...e, node: id }));
      for (const l of this.threadListeners) l(this.allThreads(), evs);
    });
    p.on('closed', ({ code }) => {
      if (id === this.root) return; // the page handles its own
      if (code === 4003 || code === 4004) this.drop(id, true);
    });
    const obs = () => this.fire();
    p.ytext.observe(obs);
    this.textObservers.set(id, obs);
  }

  private setInfo(id: string, doc: DocInfo) {
    this.info.set(id, { ...doc, section: (doc as { section?: boolean }).section ?? doc.title === '', type: (doc as { type?: string }).type ?? 'markdown' });
    for (const l of this.metaListeners) l(id);
    this.fire();
  }

  /** Close nodes that are no longer reachable from the root through mounts. */
  prune(reachable: Set<string>) {
    for (const id of [...this.providers.keys()]) if (id !== this.root && !reachable.has(id)) this.drop(id, false);
  }

  private drop(id: string, unavailable: boolean) {
    const p = this.providers.get(id);
    if (!p) return;
    const obs = this.textObservers.get(id);
    if (obs) p.ytext.unobserve(obs);
    this.textObservers.delete(id);
    this.providers.delete(id);
    this.threadsByNode.delete(id);
    this.info.delete(id);
    if (unavailable) this.unavailable.add(id);
    p.destroy();
    this.fire();
    for (const l of this.threadListeners) l(this.allThreads(), []);
  }

  /** Ids a body mounts (whether or not they are open). */
  static mountsIn(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split('\n')) { const m = MARKER_RE.exec(line); if (m) out.push(m[1]); }
    return out;
  }

  allThreads(): NodeThread[] {
    const out: NodeThread[] = [];
    for (const [node, ts] of this.threadsByNode) for (const t of ts) out.push({ ...t, node });
    return out;
  }

  onChange(l: Listener): () => void { this.changeListeners.add(l); return () => this.changeListeners.delete(l); }
  onThreads(l: (threads: NodeThread[], events: { node: string; kind: string; threadId: string; commentId: string; actor: string }[]) => void): () => void { this.threadListeners.add(l); return () => this.threadListeners.delete(l); }
  onMeta(l: (id: string) => void): () => void { this.metaListeners.add(l); return () => this.metaListeners.delete(l); }

  private pending = false;
  private fire() {
    if (this.pending || this.destroyed) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; if (!this.destroyed) for (const l of this.changeListeners) l(); });
  }

  /** Everyone's awareness, per node. */
  awarenesses(): { id: string; provider: DocProvider }[] {
    return [...this.providers].map(([id, provider]) => ({ id, provider }));
  }

  destroy() {
    this.destroyed = true;
    for (const id of [...this.providers.keys()]) if (id !== this.root) this.drop(id, false);
    this.changeListeners.clear(); this.threadListeners.clear(); this.metaListeners.clear();
  }
}
