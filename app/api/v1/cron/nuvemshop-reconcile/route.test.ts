import { describe, expect, it } from "vitest";
import { decidirQuemReconciliar } from "./route";

const AGORA = new Date("2026-10-08T12:00:00.000Z");
const linha = (org: string, statusOrg = "active") => ({ organization_id: org, organizations: { status: statusOrg } });

describe("decidirQuemReconciliar", () => {
  it("cursor velho (> 25 min) e idle → entra", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map([["a", { status: "idle", cursor_updated_at: "2026-10-08T11:00:00.000Z", trava_ate: null, ultimo_erro: null }]]), AGORA)).toEqual(["a"]);
  });
  it("cursor recente → fica de fora", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map([["a", { status: "idle", cursor_updated_at: "2026-10-08T11:50:00.000Z", trava_ate: null, ultimo_erro: null }]]), AGORA)).toEqual([]);
  });
  it("sem estado (nunca sincronizou) → entra", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map(), AGORA)).toEqual(["a"]);
  });
  it("run vivo → fica de fora; run morto → entra", () => {
    const vivo = { status: "running", cursor_updated_at: null, trava_ate: "2026-10-08T12:10:00.000Z", ultimo_erro: null };
    const morto = { ...vivo, trava_ate: "2026-10-08T11:00:00.000Z" };
    expect(decidirQuemReconciliar([linha("a"), linha("b")], new Map([["a", vivo], ["b", morto]]), AGORA)).toEqual(["b"]);
  });
  it("erro de autorização → fica de fora até reconectar", () => {
    expect(decidirQuemReconciliar([linha("a")], new Map([["a", { status: "error", cursor_updated_at: null, trava_ate: null, ultimo_erro: "auth" }]]), AGORA)).toEqual([]);
  });
  it("organização parada → fica de fora", () => {
    expect(decidirQuemReconciliar([linha("a", "suspended")], new Map(), AGORA)).toEqual([]);
  });
});
