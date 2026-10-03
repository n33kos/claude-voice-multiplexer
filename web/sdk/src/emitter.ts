/** Tiny typed event emitter. Listeners that throw are logged, not propagated. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    (this.listeners[event] ??= new Set()).add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    this.listeners[event]?.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of [...(this.listeners[event] ?? [])]) {
      try {
        listener(payload);
      } catch (err) {
        console.error(`[vmux] ${String(event)} listener failed`, err);
      }
    }
  }
}
