/**
 * O LEMBRETE DA AGENDA NÃO SAI PARA ORGANIZAÇÃO PARADA.
 *
 * E não abre conversa nem vira `erro_no_envio` a cada 5 minutos: a org parada
 * sai da rodada antes do contato, e a corrida com o assert da porta de saída
 * vira o mesmo `pulado`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

const mocks = vi.hoisted(() => ({
  paradas: vi.fn(),
  enviar: vi.fn(),
  abrirConversa: vi.fn(),
  compromissos: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: mocks.abrirConversa }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/organizacao/operante", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizacao/operante")>()),
  idsDeOrgsParadas: mocks.paradas,
}));
/** PostgREST falso: toda cadeia devolve a si mesma; a lista e as linhas únicas vêm de `mocks`. */
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        contacts: { id: "contato-1", name: "Ana", display_name: null, phone_number: "+5531999998888", is_blocked: false },
        channel_sessions: { id: "canal-1" },
        organizations: { timezone: "America/Sao_Paulo", locale: "pt-BR" },
      };
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "gt", "lte", "order", "limit", "or", "update"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      c.then = (r: (v: unknown) => unknown) =>
        Promise.resolve({ data: tabela === "calendar_appointments" ? mocks.compromissos : null, error: null }).then(r);
      return c;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/agenda-reminder/route";

const pedido = () => new Request("http://localhost/api/v1/cron/agenda-reminder") as never;
const tipo = {
  name: "Consulta", reminder_enabled: true, reminder_minutes_before: 60, reminder_extra_offsets_minutes: null,
  reminder_template_name: null, reminder_body: null, reminder_bodies: null, location_details: null,
};
const compromisso = (id: string, organization_id: string) => ({
  id, organization_id, contact_id: "contato-1", title: "Retorno",
  starts_at: new Date(Date.now() + 30 * 60_000).toISOString(), location_details: null,
  reminder_sent_offsets_minutes: null, calendar_event_types: tipo,
});

beforeEach(() => {
  mocks.paradas.mockReset();
  mocks.enviar.mockReset();
  mocks.abrirConversa.mockReset();
  mocks.abrirConversa.mockResolvedValue("conversa-1");
  mocks.enviar.mockResolvedValue({ id: "msg-1", status: "queued" });
  mocks.compromissos = [compromisso("c-parada", "org-parada"), compromisso("c-ativa", "org-ativa")];
});

describe("agenda-reminder × organização parada", () => {
  it("não abre conversa nem envia para a org parada; a operante segue", async () => {
    mocks.paradas.mockResolvedValue(["org-parada"]);
    const res = await GET(pedido());
    expect(res.status).toBe(200);
    expect(mocks.abrirConversa).toHaveBeenCalledTimes(1);
    expect(mocks.abrirConversa.mock.calls[0]?.[1]).toBe("org-ativa");
    expect(mocks.enviar).toHaveBeenCalledTimes(1);
    expect(mocks.enviar.mock.calls[0]?.[1]).toMatchObject({ organization_id: "org-ativa" });
    expect((await res.json()).data).toMatchObject({ enviados: 1, motivos: { org_nao_operante: 1 } });
  });

  it("corrida com a porta de saída: OrgNaoOperanteError vira pulado org_nao_operante, não erro_no_envio", async () => {
    mocks.paradas.mockResolvedValue([]);
    mocks.enviar.mockRejectedValueOnce(new OrgNaoOperanteError("org-parada", "suspended"));
    const res = await GET(pedido());
    const { data } = await res.json();
    expect(data.motivos).toMatchObject({ org_nao_operante: 1 });
    expect(data.motivos.erro_no_envio).toBeUndefined();
  });

  it("leitura das paradas falha → 500 e nada sai (falha fechada)", async () => {
    mocks.paradas.mockRejectedValue(new Error("connection reset"));
    const res = await GET(pedido());
    expect(res.status).toBe(500);
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(mocks.abrirConversa).not.toHaveBeenCalled();
  });
});
