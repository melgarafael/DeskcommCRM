/** Signals carry no alert/handoff details. Details must come from an authorized GET. */
export type NoticeKind =
  | "platform_alerts"
  | "tenant_health"
  | "tenant_agents"
  | "handoff_pending"
  | "agent_inbox";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class NoticeGate {
  private seen = new Set<string>();
  constructor(
    private kind: NoticeKind,
    private org?: string,
  ) {}
  consume(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const p = value as { tipo?: unknown; new?: unknown; record?: unknown };
    if (p.tipo === "reassinado" || p.tipo === "invalidado") return true;
    const row = p.new ?? p.record;
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    if (
      r.table_name !== this.kind ||
      typeof r.organization_id !== "string" ||
      !uuid.test(r.organization_id) ||
      (this.org && r.organization_id !== this.org) ||
      typeof r.change_token !== "string" ||
      !uuid.test(r.change_token)
    )
      return false;
    const key = r.organization_id + ":" + r.change_token;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 128)
      this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}
/** Fixed first-event window: sustained traffic cannot postpone the refresh forever. */
export class NoticeBurst {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(
    private refresh: () => void,
    private ms = 100,
  ) {}
  request() {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed) this.refresh();
    }, this.ms);
  }
  close() {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
export interface AuthorizedAlert {
  id: string;
  created_at: string;
  severity: string;
  message: string;
}
/** Seed initial authorized snapshot quietly; never consume a transport payload as an alert. */
export class AuthorizedAlertGate<T extends AuthorizedAlert> {
  private initialized = false;
  private seen = new Set<string>();
  take(items: readonly T[]): T[] {
    const fresh: T[] = [];
    for (const item of items) {
      const key = JSON.stringify([
        item.id,
        item.created_at,
        item.severity,
        item.message,
      ]);
      if (!this.seen.has(key)) {
        if (this.initialized) fresh.push(item);
        this.seen.add(key);
      }
    }
    this.initialized = true;
    while (this.seen.size > 200)
      this.seen.delete(this.seen.values().next().value!);
    return fresh;
  }
}
