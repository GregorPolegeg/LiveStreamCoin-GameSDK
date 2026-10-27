/**
 * Live sessions on this worker. A session is loaded the first time someone
 * connects to it and dropped again when it sleeps or ends. Concurrent first
 * connections share one wake-up.
 */
import type { Limits } from './limits';
import type { Registry } from './registry';
import type { Store } from './store';
import { Session } from './session';

export class SessionManager {
  private live = new Map<string, Session>();
  private waking = new Map<string, Promise<Session | null>>();

  constructor(
    private readonly limits: Limits,
    private readonly workerId: string,
    private readonly store: Store,
    private readonly registry: Registry,
  ) {}

  get count() { return this.live.size; }
  get connections() { let n = 0; for (const s of this.live.values()) n += s.connections; return n; }
  get actions() { let n = 0; for (const s of this.live.values()) n += s.actionsHandled; return n; }

  /** The running session, waking it if needed. null = unknown session. Throws OwnerBusy. */
  async get(sessionId: string): Promise<Session | null> {
    const s = this.live.get(sessionId);
    if (s) return s;
    let w = this.waking.get(sessionId);
    if (!w) {
      w = this.wake(sessionId).finally(() => this.waking.delete(sessionId));
      this.waking.set(sessionId, w);
    }
    return w;
  }

  private async wake(sessionId: string): Promise<Session | null> {
    const config = await this.registry.load(sessionId);
    if (!config) return null;
    const s = new Session(config, this.store, this.registry, this.limits, this.workerId, (gone) => {
      if (this.live.get(gone.id) === gone) this.live.delete(gone.id);
    });
    await s.wake();
    this.live.set(sessionId, s);
    return s;
  }

  async shutdown() {
    await Promise.all([...this.live.values()].map((s) => s.shutdown()));
  }
}
