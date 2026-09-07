import { describe, it, expect } from "vitest";
import {
  checkpoint,
  compare,
  delta,
  hash,
  localProjection,
  remoteProjection,
} from "@/lib/agenda/google/sync-model";
import type { AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
const a: AgendamentoParaGoogle & { guest_email: string | null } = {
  id: "a",
  organization_id: "o",
  title: "Consulta",
  starts_at: "2026-09-10T12:00:00Z",
  ends_at: "2026-09-10T13:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  location_kind: "in_person",
  guest_email: null,
};
const local = localProjection(a);
const event = {
  id: "remote",
  summary: "Consulta",
  start: { dateTime: a.starts_at, timeZone: a.time_zone },
  end: { dateTime: a.ends_at },
};
const remote = remoteProjection(event, local, null);
const base = checkpoint(null, local, remote, ["title", "description", "location", "guest"], true);
describe("reconciliação compartilhada, sem importar títulos nem apagar convidados externos", () => {
  it("checkpoint de outbound contém hashes, não dados pessoais", () => {
    expect(JSON.stringify(base)).not.toContain("Consulta");
    expect(base.local.title).toHaveLength(64);
  });
  it("horário local preserva título remoto alterado", () => {
    const changed = { ...a, starts_at: "2026-09-10T14:00:00Z", ends_at: "2026-09-10T15:00:00Z" };
    const l = localProjection(changed),
      r = remoteProjection({ ...event, summary: "Retorno" }, l, base);
    const result = compare(base, l, r);
    expect(result.kind).toBe("publish");
    expect(result.groups).toEqual([]);
    expect(delta(changed, event, base, result.groups, result.shared)).toEqual({
      start: { dateTime: "2026-09-10T14:00:00.000Z", timeZone: a.time_zone },
      end: { dateTime: "2026-09-10T15:00:00.000Z", timeZone: a.time_zone },
    });
  });
  it("mudanças distintas de horário exigem decisão, nunca last-write-wins", () => {
    const l = { ...local, shared: { ...local.shared, starts_at: "2026-09-10T14:00:00Z" } };
    const r = { ...remote, shared: { ...remote.shared, starts_at: "2026-09-10T16:00:00Z" } };
    expect(compare(base, l, r)).toMatchObject({ kind: "conflict", reason: "shared" });
  });
  it("convergência não exige nova escrita", () => {
    const l = { ...local, shared: { ...local.shared, starts_at: "2026-09-10T14:00:00Z" } };
    expect(compare(base, l, l).kind).toBe("converged");
  });
  it("remoto sozinho muda o shared e conserva outbound local pendente", () => {
    const l = { ...local, outbound: { ...local.outbound, title: hash("Avaliação") } };
    const r = { ...remote, shared: { ...remote.shared, starts_at: "2026-09-10T14:00:00Z" } };
    expect(compare(base, l, r).kind).toBe("accept_remote");
    const next = checkpoint(base, l, r, [], true);
    expect(next.local.title).toBe(hash("Consulta"));
  });
  it("intenção de título local que substituiria o Google é conflito explícito", () => {
    expect(
      compare(
        base,
        { ...local, outbound: { ...local.outbound, title: hash("Avaliação") } },
        { ...remote, outbound: { ...remote.outbound, title: hash("Retorno") } },
      ),
    ).toMatchObject({ kind: "conflict", reason: "outbound", groups: ["title"] });
  });
  it("lápide mínima não exige horário", () => {
    expect(
      remoteProjection({ id: "remote", status: "cancelled" }, local, base).shared.cancelled,
    ).toBe(true);
  });
  it("ausência de base divergente não inventa sucesso legado", () => {
    expect(
      compare(null, local, { ...remote, outbound: { ...remote.outbound, title: hash("Retorno") } })
        .reason,
    ).toBe("legacy");
  });
  it("grupo convidado só remove identidade gerida e preserva RSVP/externos", () => {
    const b = structuredClone(base);
    b.remote.guest = hash("old@example.test");
    const patch = delta(
      { ...a, guest_email: "new@example.test" },
      {
        ...event,
        attendees: [
          { email: "old@example.test", responseStatus: "accepted" },
          { email: "external@example.test", responseStatus: "tentative" },
          { email: "owner@example.test", organizer: true, responseStatus: "accepted" },
        ],
      },
      b,
      ["guest"],
      false,
    );
    expect(patch.attendees).toEqual([
      { email: "external@example.test", responseStatus: "tentative" },
      { email: "owner@example.test", organizer: true, responseStatus: "accepted" },
      { email: "new@example.test", responseStatus: "needsAction" },
    ]);
  });
});
