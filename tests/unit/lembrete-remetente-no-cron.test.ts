/** Caminho real do cron com transporte capturado. O dublê aplica os filtros;
 * assim consulta cruzada não passa apenas porque uma linha fixa foi devolvida. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

const m = vi.hoisted(() => ({
  enviar: vi.fn(),
  conversa: vi.fn(),
  audit: vi.fn(),
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  erro: null as string | null,
  ordem: [] as string[],
}));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: m.enviar }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: m.conversa }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: async () => null }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: async () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: 0, error: null }),
    from(table: string) {
      const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
      let escrito: Record<string, unknown> | null = null;
      let inserido: Record<string, unknown> | null = null;
      let limite = Infinity;
      function resultado(unico = false) {
        if (m.erro === table) return { data: null, error: { message: "falha simulada" } };
        const rows = (m.rows[table] ?? [])
          .filter((r) => filtros.every((f) => f(r)))
          .slice(0, limite);
        if (escrito) {
          for (const r of rows) Object.assign(r, escrito);
          m.ordem.push(`update:${table}`);
        }
        if (inserido) {
          const novo = { id: `novo-${m.rows[table]?.length ?? 0}`, ...inserido };
          (m.rows[table] ??= []).push(novo);
          m.ordem.push(`insert:${table}`);
          return { data: novo, error: null };
        }
        return { data: unico ? (rows[0] ?? null) : rows, error: null };
      }
      const q = {
        select: () => q,
        eq(k: string, v: unknown) {
          if (!k.includes(".")) filtros.push((r) => r[k] === v);
          return q;
        },
        is(k: string, v: unknown) {
          filtros.push((r) => r[k] === v);
          return q;
        },
        in(k: string, v: unknown[]) {
          filtros.push((r) => v.includes(r[k]));
          return q;
        },
        not: () => q,
        gt: () => q,
        lte: () => q,
        order: () => q,
        or: () => q,
        limit(n: number) {
          limite = n;
          return q;
        },
        update(v: Record<string, unknown>) {
          escrito = v;
          return q;
        },
        insert(v: Record<string, unknown>) {
          inserido = v;
          return q;
        },
        maybeSingle: async () => resultado(true),
        then(r: (x: unknown) => unknown) {
          return Promise.resolve(resultado()).then(r);
        },
      };
      return q;
    },
  }),
}));
import { GET } from "@/app/api/v1/cron/agenda-reminder/route";
const rodar = () => GET(new Request("http://localhost/api/v1/cron/agenda-reminder") as never);
const reserva = () => m.rows.calendar_appointments[0];
const tipo = () => reserva().calendar_event_types as Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  m.erro = null;
  m.ordem = [];
  m.enviar.mockImplementation(async () => {
    m.ordem.push("enviar");
    return { id: "msg", status: "queued" };
  });
  m.conversa.mockImplementation(async (_a, _org, _contato, canal) => `conversa-${canal}`);
  m.rows = {
    organizations: [{ id: "org", timezone: "America/Sao_Paulo", locale: "pt-BR" }],
    calendar_appointments: [
      {
        id: "reserva",
        organization_id: "org",
        contact_id: "cliente",
        conversation_id: "conversa-clinica",
        title: "Design",
        status: "confirmed",
        starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        reminder_sent_offsets_minutes: [],
        calendar_event_types: {
          name: "Design",
          reminder_enabled: true,
          reminder_minutes_before: 60,
        },
        organizations: { status: "active" },
      },
    ],
    contacts: [
      {
        id: "cliente",
        organization_id: "org",
        name: "Cliente",
        phone_number: "+5500000000000",
        is_blocked: false,
      },
    ],
    channel_sessions: ["cursos", "clinica"].map((id) => ({
      id,
      organization_id: "org",
      provider: DEFAULT_CHANNEL_PROVIDER,
      status: "WORKING",
      archived_at: null,
    })),
    conversations: [
      {
        id: "conversa-clinica",
        organization_id: "org",
        contact_id: "cliente",
        channel_session_id: "clinica",
      },
    ],
    agent_inbox_items: [],
  };
});
describe("cron escolhe remetente antes de qualquer envio ou carimbo", () => {
  it("reserva vinculada sai pela clínica mesmo com cursos primeiro", async () => {
    expect((await rodar()).status).toBe(200);
    expect(m.conversa).toHaveBeenCalledWith(expect.anything(), "org", "cliente", "clinica");
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.ordem.indexOf("update:calendar_appointments")).toBeLessThan(m.ordem.indexOf("enviar"));
  });
  it("configuração do tipo vence conversa diferente", async () => {
    tipo().reminder_channel_session_id = "cursos";
    await rodar();
    expect(m.conversa).toHaveBeenCalledWith(expect.anything(), "org", "cliente", "cursos");
  });
  it("reserva manual com serviço configurado envia pelo canal indicado", async () => {
    reserva().conversation_id = null;
    tipo().reminder_channel_session_id = "clinica";
    await rodar();
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(m.conversa.mock.calls[0][3]).toBe("clinica");
  });
  it("manual ambígua não envia/carimba; duas rodadas mantêm um aviso", async () => {
    reserva().conversation_id = null;
    await rodar();
    await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(reserva().reminder_sent_offsets_minutes).toEqual([]);
    expect(m.rows.agent_inbox_items).toHaveLength(1);
    expect(m.rows.agent_inbox_items[0]).toMatchObject({
      status: "open",
      ref_id: "reserva",
      kind: "other",
    });
  });
  it("corrigir configuração fecha aviso e envia na próxima rodada", async () => {
    reserva().conversation_id = null;
    await rodar();
    tipo().reminder_channel_session_id = "clinica";
    await rodar();
    expect(m.rows.agent_inbox_items[0].status).toBe("resolved");
    expect(m.enviar).toHaveBeenCalledTimes(1);
  });
  it.each(["organization_id", "contact_id"])(
    "conversa com %s diferente nunca libera fallback",
    async (campo) => {
      m.rows.conversations[0][campo] = "outro";
      await rodar();
      expect(m.enviar).not.toHaveBeenCalled();
      expect(reserva().reminder_sent_offsets_minutes).toEqual([]);
    },
  );
  it("canal configurado de outra organização não envia", async () => {
    tipo().reminder_channel_session_id = "fora";
    m.rows.channel_sessions.push({
      id: "fora",
      organization_id: "outra",
      provider: DEFAULT_CHANNEL_PROVIDER,
      status: "WORKING",
      archived_at: null,
    });
    await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
  });
  it.each(["conversations", "channel_sessions"])(
    "erro em %s não é ausência e não libera fallback",
    async (table) => {
      m.erro = table;
      await rodar();
      expect(m.enviar).not.toHaveBeenCalled();
      expect(reserva().reminder_sent_offsets_minutes).toEqual([]);
    },
  );
  it("canal ligado fora do ar não usa o outro setor", async () => {
    m.rows.channel_sessions[1].status = "STOPPED";
    await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
  });
  it("bloqueio e carimbo anteriores continuam sendo respeitados", async () => {
    m.rows.contacts[0].is_blocked = true;
    await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
    m.rows.contacts[0].is_blocked = false;
    reserva().reminder_sent_offsets_minutes = [60];
    await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
  });
});
