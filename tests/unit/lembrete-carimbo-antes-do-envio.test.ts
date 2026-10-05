/**
 * O LEMBRETE DA AGENDA CARIMBA ANTES DE ENVIAR, E NÃO ENVIA SE O CARIMBO FALHA
 * (issue #2223).
 *
 * Carimbo depois do envio transformava qualquer falha no meio em REENVIO na
 * varredura seguinte (medido: a mesma mensagem às 18:35:01 e às 18:40:01).
 * Este arquivo prende o comportamento, não a posição no fonte: um teste de
 * `indexOf` fica verde se alguém tornar o `if (erroCarimbo)` inalcançável.
 *
 * Arnês: o mesmo PostgREST falso de `lembrete-pula-org-parada.test.ts`, com o
 * `update` registrado na mesma linha do tempo que o envio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  ordem: [] as string[],
  carimbos: [] as Array<Record<string, unknown>>,
  erroNoCarimbo: null as { message: string } | null,
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: async () => "conversa-1" }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        contacts: { id: "contato-1", name: "Ana", display_name: null, phone_number: "+5531999998888", is_blocked: false },
        channel_sessions: { id: "canal-1" },
        organizations: { timezone: "America/Sao_Paulo", locale: "pt-BR" },
      };
      let ehCarimbo = false;
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "gt", "lte", "order", "limit", "or"]) c[m] = () => c;
      c.update = (valores: Record<string, unknown>) => {
        ehCarimbo = true;
        mocks.ordem.push("carimbo");
        mocks.carimbos.push(valores);
        return c;
      };
      c.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      c.then = (r: (v: unknown) => unknown) =>
        Promise.resolve(
          ehCarimbo
            ? { data: null, error: mocks.erroNoCarimbo }
            : { data: tabela === "calendar_appointments" ? [compromisso] : null, error: null },
        ).then(r);
      return c;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/agenda-reminder/route";

const pedido = () => new Request("http://localhost/api/v1/cron/agenda-reminder") as never;
const compromisso = {
  id: "c-1", organization_id: "org-1", contact_id: "contato-1", title: "Retorno",
  starts_at: new Date(Date.now() + 30 * 60_000).toISOString(), created_at: null, location_details: null,
  reminder_sent_offsets_minutes: null, organizations: { status: "active" },
  calendar_event_types: {
    name: "Consulta", reminder_enabled: true, reminder_minutes_before: 60, reminder_extra_offsets_minutes: null,
    reminder_template_name: null, reminder_body: null, reminder_bodies: null, location_details: null,
  },
};

beforeEach(() => {
  mocks.ordem.length = 0;
  mocks.carimbos.length = 0;
  mocks.erroNoCarimbo = null;
  mocks.enviar.mockReset();
  mocks.enviar.mockImplementation(async () => {
    mocks.ordem.push("enviar");
    return { id: "msg-1", status: "queued" };
  });
});

describe("agenda-reminder × carimbo antes do envio (#2223)", () => {
  it("caminho feliz: carimba o degrau e só depois envia", async () => {
    const { data } = await (await GET(pedido())).json();
    expect(mocks.ordem).toEqual(["carimbo", "enviar"]);
    expect(mocks.carimbos[0]).toMatchObject({ reminder_sent_offsets_minutes: [60] });
    expect(data.enviados).toBe(1);
  });

  it("carimbo recusado pelo banco: não envia, e a rodada conta carimbo_falhou", async () => {
    mocks.erroNoCarimbo = { message: "permission denied" };
    const { data } = await (await GET(pedido())).json();
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(data.enviados).toBe(0);
    expect(data.motivos.carimbo_falhou).toBe(1);
  });

  it("envio que falha depois do carimbo: o degrau já estava carimbado, e não há segundo carimbo", async () => {
    mocks.enviar.mockImplementation(async () => {
      mocks.ordem.push("enviar");
      throw new Error("waha fora");
    });
    const { data } = await (await GET(pedido())).json();
    expect(mocks.ordem).toEqual(["carimbo", "enviar"]);
    expect(data.motivos.erro_no_envio).toBe(1);
  });
});
