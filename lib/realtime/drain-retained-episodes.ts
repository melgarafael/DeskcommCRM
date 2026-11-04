/** Separate consumer prototype. Its page adapter must reject errors, never return cached data as success. */
export interface RetainedEpisode {
  id: string;
  revision: string;
}
export interface RetainedPage<T extends RetainedEpisode> {
  items: T[];
  has_more: boolean;
  coverage: "retained_agent_inbox_items" | "persisted_derived_episodes";
  history_complete: false;
}
export class EpisodeDrainCancelled extends Error {}
export class RetainedEpisodeDrain<T extends RetainedEpisode> {
  private closed = false;
  private running: Promise<{ presented: number; more: boolean }> | null = null;
  private pending = new Set<string>();
  constructor(
    private readonly io: {
      page: () => Promise<RetainedPage<T>>;
      present: (item: T) => Promise<void>;
      ack: (items: RetainedEpisode[]) => Promise<void>;
      isCurrent: () => boolean;
    },
    private readonly maxPages = 10,
    private readonly coverage:
      | "retained_agent_inbox_items"
      | "persisted_derived_episodes" = "retained_agent_inbox_items",
  ) {}
  cancel() {
    this.closed = true;
    this.pending.clear();
  }
  private current() {
    if (this.closed || !this.io.isCurrent()) throw new EpisodeDrainCancelled();
  }
  drain() {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async perform() {
    let presented = 0;
    for (let round = 0; round < this.maxPages; round++) {
      this.current();
      const page = await this.io.page();
      this.current();
      if (
        page.coverage !== this.coverage ||
        page.history_complete !== false ||
        !Array.isArray(page.items) ||
        page.items.length > 100 ||
        typeof page.has_more !== "boolean"
      )
        throw new Error("invalid retained episode page");
      const keys = new Set<string>();
      for (const item of page.items) {
        if (
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            item.id,
          ) ||
          !/^[0-9a-f]{64}$/.test(item.revision)
        )
          throw new Error("invalid retained episode");
        keys.add(item.id + ":" + item.revision);
      }
      // Only pending presentation receipts for the fresh head are held in memory.
      this.pending = new Set([...this.pending].filter((key) => keys.has(key)));
      for (const item of page.items) {
        const key = item.id + ":" + item.revision;
        this.current();
        if (!this.pending.has(key)) {
          await this.io.present(item);
          this.current();
          this.pending.add(key);
          presented++;
        }
      }
      if (page.items.length) {
        this.current();
        await this.io.ack(
          page.items.map(({ id, revision }) => ({ id, revision })),
        );
        this.current();
        for (const key of keys) this.pending.delete(key);
      }
      if (!page.has_more) return { presented, more: false };
      if (!page.items.length)
        throw new Error("empty page cannot advertise more");
    }
    return { presented, more: true }; // schedule another bounded drain; never pretend the backlog ended.
  }
}
