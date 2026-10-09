/**
 * O LEMBRETE DA AGENDA ESCOLHE O CANAL PELA JANELA DE 24 H, PELA ROTA (#2595).
 *
 * `route.test.ts` prende a regra pura (`escolherCanalDoLembrete`) e a ORDEM no
 * fonte. Isto prende o fio entre as duas: a rota lê `last_inbound_at` da
 * conversa do contato em CADA canal e entrega à regra. Um `indexOf` fica verde
 * se o mapa nunca for preenchido — e aí todo canal com janela ficaria fechado
 * para sempre, o defeito simétrico ao da issue.
 *
 * Arnês: o mesmo PostgREST falso de `lembrete-carimbo-antes-do-envio.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNEL_PROVIDER_SOCIAL, DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

const mocks = vi.hoisted(() => ({
  enviar: vi.fn(),
  carimbos: [] as Array<Record<string, unknown>>,
  canais: [] as Array<{ id: string; provider: string }>,
  conversas: [] as Array<{ channel_session_id: string; last_inbound_at: string | null }>,
  canalDaConversa: [] as string[],
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: mocks.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({
  ensureConversation: async (_a: unknown, _o: string, _c: string, canal: string) => {
    mocks.canalDaConversa.push(canal);
    return "conversa-1";
  },
}));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const unico: Record<string, unknown> = {
        contacts: { id: "contato-1", name: "Ana", display_name: null, phone_number: "+5531999998888", is_blocked: false },
        organizations: { timezone: "America/Sao_Paulo", locale: "pt-BR" },
      };
      let ehCarimbo = false;
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "gt", "lte", "order", "limit", "or", "in"]) c[m] = () => c;
      c.update = (valores: Record<string, unknown>) => {
        ehCarimbo = true;
        mocks.carimbos.push(valores);
        return c;
      };
      c.maybeSingle = async () => ({ data: unico[tabela] ?? null, error: null });
      const lista: Record<string, unknown> = {
        calendar_appointments: [compromisso],
        channel_sessions: mocks.canais,
        conversations: mocks.conversas,
      };
      c.then = (r: (v: unknown) => unknown) =>
        Promise.resolve(ehCarimbo ? { data: null, error: null } : { data: lista[tabela] ?? null, error: null }).then(r);
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
const ha = (horas: number) => new Date(Date.now() - horas * 3_600_000).toISOString();

beforeEach(() => {
  mocks.carimbos.length = 0;
  mocks.canalDaConversa.length = 0;
  mocks.canais = [];
  mocks.conversas = [];
  mocks.enviar.mockReset();
  mocks.enviar.mockImplementation(async () => ({ id: "msg-1", status: "queued" }));
});

describe("agenda-reminder × janela de 24 h do canal (#2595)", () => {
  it("canal com janela, cliente calado há 3 dias: não carimba, não envia, motiva", async () => {
    mocks.canais = [{ id: "canal-social", provider: CHANNEL_PROVIDER_SOCIAL }];
    mocks.conversas = [{ channel_session_id: "canal-social", last_inbound_at: ha(72) }];
    const { data } = await (await GET(pedido())).json();
    expect(mocks.carimbos).toEqual([]);
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(data.motivos.canal_fora_da_janela_24h).toBe(1);
  });

  it("o MESMO canal com o cliente escrevendo há 1 hora: a rota lê a conversa e envia", async () => {
    mocks.canais = [{ id: "canal-social", provider: CHANNEL_PROVIDER_SOCIAL }];
    mocks.conversas = [{ channel_session_id: "canal-social", last_inbound_at: ha(1) }];
    const { data } = await (await GET(pedido())).json();
    expect(mocks.carimbos).toHaveLength(1);
    expect(mocks.canalDaConversa).toEqual(["canal-social"]);
    expect(data.enviados).toBe(1);
  });

  it("o inbound recente em OUTRO canal não abre a janela deste", async () => {
    mocks.canais = [{ id: "canal-social", provider: CHANNEL_PROVIDER_SOCIAL }];
    mocks.conversas = [{ channel_session_id: "canal-outro", last_inbound_at: ha(1) }];
    const { data } = await (await GET(pedido())).json();
    expect(mocks.enviar).not.toHaveBeenCalled();
    expect(data.motivos.canal_fora_da_janela_24h).toBe(1);
  });

  it("canal com janela fechada cede a vez ao próximo canal que pode, e só ele envia", async () => {
    mocks.canais = [
      { id: "canal-social", provider: CHANNEL_PROVIDER_SOCIAL },
      { id: "canal-livre", provider: DEFAULT_CHANNEL_PROVIDER },
    ];
    const { data } = await (await GET(pedido())).json();
    expect(mocks.canalDaConversa).toEqual(["canal-livre"]);
    expect(mocks.carimbos).toHaveLength(1);
    expect(data.enviados).toBe(1);
  });
});
