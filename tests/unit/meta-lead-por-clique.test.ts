import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversaoDeCliqueMetaHandler } from "@/lib/conversoes/clique-meta.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { lerCredencial } from "@/lib/plataformas-de-anuncio/credenciais";
import { transporteDe } from "@/lib/plataformas-de-anuncio/registry";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/credenciais", () => ({ lerCredencial: vi.fn() }));
vi.mock("@/lib/plataformas-de-anuncio/registry", () => ({ transporteDe: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const ACTIVATION = "2026-10-16T10:00:00.000001Z";
const CAPTURED = "2026-10-16T10:01:00.000001Z";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

function click(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    contact_id: CONTACT,
    first_message_id: id(n + 100),
    ctwa_clid: `ctwa-${n}`,
    captured_at: CAPTURED,
    activation_at_capture: ACTIVATION,
    status: "pending",
    event_id: `${id(n)}:LeadSubmitted`,
    ...overrides,
  };
}
function event(n: number): EventRow {
  return {
    id: `event-${n}`,
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: id(n + 100),
    payload: { message_id: id(n + 100), contact_id: CONTACT },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

function database(
  clicks: Array<ReturnType<typeof click>>,
  activations: Array<string | null> = [ACTIVATION],
) {
  let orgReads = 0;
  const byMessage = new Map(clicks.map((c) => [c.first_message_id, c]));
  const byId = new Map(clicks.map((c) => [c.id, c]));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "fn_claim_meta_ctwa_click") {
      const c = byId.get(String(args.p_click));
      if (c?.status === "legacy_sent")
        return { data: { acquired: false, status: "legacy_sent" }, error: null };
      if (!c || c.status === "sent")
        return { data: { acquired: false, status: "sent" }, error: null };
      c.status = "processing";
      return { data: { acquired: true, token: id(999), status: "processing" }, error: null };
    }
    if (name === "fn_settle_meta_ctwa_click") {
      const c = byId.get(String(args.p_click));
      if (c) c.status = String(args.p_status);
      return { data: true, error: null };
    }
    return { data: null, error: { message: "RPC inesperada" } };
  });
  const from = vi.fn((table: string) => {
    const filters = new Map<string, unknown>();
    const q = {
      select: () => q,
      eq: (column: string, value: unknown) => {
        filters.set(column, value);
        return q;
      },
      maybeSingle: async () => {
        if (filters.get("organization_id") !== ORG && filters.get("id") !== ORG)
          return { data: null, error: null };
        if (table === "meta_ctwa_click_dispatches")
          return {
            data: filters.has("first_message_id")
              ? (byMessage.get(String(filters.get("first_message_id"))) ?? null)
              : (byId.get(String(filters.get("id"))) ?? null),
            error: null,
          };
        if (table === "organizations")
          return {
            data: {
              meta_lead_birth_enabled_at: activations[Math.min(orgReads++, activations.length - 1)],
            },
            error: null,
          };
        if (table === "contacts") return { data: { phone_number: "+5511999990000" }, error: null };
        return { data: null, error: { message: `Tabela inesperada: ${table}` } };
      },
    };
    return q;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  return { rpc, from };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lerCredencial).mockResolvedValue({
    ok: true,
    credencial: {
      datasetId: "dataset-sintetico",
      accessToken: "token-sintetico",
      testEventCode: null,
    },
  } as never);
});

describe("LeadSubmitted por clique inbound", () => {
  it("claim recusado por envio legado nao chama transporte nem credencial", async () => {
    const { rpc } = database([click(1, { status: "legacy_sent" })]);
    const enviar = vi.fn();
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    expect((await conversaoDeCliqueMetaHandler.handle(event(1))).detail).toBe(
      "lead_submitted_legado_enviado",
    );
    expect(rpc).toHaveBeenCalledWith("fn_claim_meta_ctwa_click", {
      p_org: ORG,
      p_click: id(1),
    });
    expect(lerCredencial).not.toHaveBeenCalled();
    expect(enviar).not.toHaveBeenCalled();
  });

  it("tres cliques do mesmo contato geram tres IDs sem exigir lead ou card", async () => {
    const clicks = [click(1), click(2), click(3)];
    database(clicks);
    const enviar = vi.fn().mockResolvedValue({ tipo: "ok" });
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    for (const n of [1, 2, 3])
      expect((await conversaoDeCliqueMetaHandler.handle(event(n))).status).toBe("ok");
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(enviar.mock.calls.map((call) => call[1].eventoId)).toEqual(
      clicks.map((c) => c.event_id),
    );
    expect(enviar.mock.calls.map((call) => call[1].cliqueDeOrigem)).toEqual([
      "ctwa-1",
      "ctwa-2",
      "ctwa-3",
    ]);
    expect(enviar.mock.calls.every((call) => call[1].leadId === null)).toBe(true);
  });

  it("mensagem organica e reentrega do clique nao enviam outra conversao", async () => {
    database([click(1)]);
    const enviar = vi.fn().mockResolvedValue({ tipo: "ok" });
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    expect((await conversaoDeCliqueMetaHandler.handle(event(1))).status).toBe("ok");
    expect((await conversaoDeCliqueMetaHandler.handle(event(1))).detail).toBe("ja_enviada");
    expect((await conversaoDeCliqueMetaHandler.handle(event(2))).detail).toBe("sem_clique_novo");
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("evento forjado sem identidade da mensagem ou do clique nao inicia envio", async () => {
    database([click(1)]);
    const enviar = vi.fn().mockResolvedValue({ tipo: "ok" });
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    expect(
      (
        await conversaoDeCliqueMetaHandler.handle({
          ...event(1),
          entity_id: id(700),
        })
      ).detail,
    ).toBe("sem_mensagem");
    expect(
      (
        await conversaoDeCliqueMetaHandler.handle({
          ...event(1),
          event_type: "ad_conversion.click_retry_requested",
          entity_kind: "crm_lead",
          entity_id: id(1),
          payload: { click_id: id(1) },
        })
      ).detail,
    ).toBe("sem_clique");
    expect(enviar).not.toHaveBeenCalled();
  });

  it("503 faz retry com o mesmo event_id e conclui em sent", async () => {
    const c = click(1);
    database([c]);
    const enviar = vi
      .fn()
      .mockResolvedValueOnce({ tipo: "transitorio", detalhe: "503 sintético" })
      .mockResolvedValueOnce({ tipo: "ok" });
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    expect((await conversaoDeCliqueMetaHandler.handle(event(1))).status).toBe("retry");
    expect(
      (
        await conversaoDeCliqueMetaHandler.handle({
          ...event(1),
          event_type: "ad_conversion.click_retry_requested",
          entity_kind: "meta_ctwa_click",
          entity_id: c.id,
          payload: { click_id: c.id },
        })
      ).status,
    ).toBe("ok");
    expect(enviar.mock.calls.map((call) => call[1].eventoId)).toEqual([c.event_id, c.event_id]);
    expect(c.status).toBe("sent");
  });

  it("clique desativado ou de epoch anterior nao gera POST", async () => {
    database(
      [click(1, { activation_at_capture: null }), click(2)],
      [ACTIVATION, "2026-10-16T11:00:00Z"],
    );
    const enviar = vi.fn().mockResolvedValue({ tipo: "ok" });
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    expect((await conversaoDeCliqueMetaHandler.handle(event(1))).detail).toBe(
      "lead_submitted_desativado_no_clique",
    );
    expect((await conversaoDeCliqueMetaHandler.handle(event(2))).detail).toBe(
      "lead_submitted_desativado",
    );
    expect(enviar).not.toHaveBeenCalled();
  });

  it("desativacao durante processamento bloqueia o POST", async () => {
    const { rpc } = database([click(1)], [ACTIVATION, null]);
    const enviar = vi.fn().mockResolvedValue({ tipo: "ok" });
    vi.mocked(transporteDe).mockReturnValue({ plataforma: "meta_ads", enviar });
    expect((await conversaoDeCliqueMetaHandler.handle(event(1))).detail).toBe(
      "lead_submitted_desativado",
    );
    expect(enviar).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "fn_settle_meta_ctwa_click",
      expect.objectContaining({ p_status: "skipped" }),
    );
  });
});
