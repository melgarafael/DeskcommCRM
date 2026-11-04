/**
 * O LEMBRETE POR MODELO APROVADO quando a janela de 24 h do cliente fechou (migration 9092).
 *
 * Num número oficial, texto livre só chega a quem escreveu nas últimas 24 h. A
 * reserva feita dias antes cai fora da janela, e o cron PULAVA o lembrete (#2595):
 * o cliente não era avisado. Com `reminder_meta_template_id` no tipo, ele sai pelo
 * modelo aprovado DAQUELE número — e qualquer modelo que não sirva (de outro
 * número, de outra organização, não aprovado, sem como preencher) mantém o
 * comportamento de antes: não envia, não carimba, avisa a equipe.
 *
 * Mesmo dublê de `lembrete-remetente-no-cron.test.ts`: caminho real do cron,
 * filtros aplicados, transporte capturado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";

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
function linhas(tabela: string) {
  const rows = m.rows[tabela];
  if (!rows) throw new Error(`Fixture ausente: ${tabela}`);
  return rows;
}
function linha(tabela: string, indice = 0) {
  const row = linhas(tabela)[indice];
  if (!row) throw new Error(`Linha de fixture ausente: ${tabela}[${indice}]`);
  return row;
}
const rodar = () => GET(new Request("http://localhost/api/v1/cron/agenda-reminder") as never);
const reserva = () => linha("calendar_appointments");
const tipo = () => reserva().calendar_event_types as Record<string, unknown>;
const modelo = () => linha("meta_templates");
const enviado = () => m.enviar.mock.calls.at(0)?.[2] as Record<string, unknown> | undefined;
const motivos = async (res: Response) =>
  ((await res.json()) as { data: { motivos: Record<string, number> } }).data.motivos;
const HORA = 60 * 60_000;

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
        conversation_id: "conversa-oficial",
        title: "Consulta de retorno",
        status: "confirmed",
        starts_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        reminder_sent_offsets_minutes: [],
        calendar_event_types: {
          name: "Consulta de retorno",
          reminder_enabled: true,
          reminder_minutes_before: 60,
          reminder_meta_template_id: "modelo-lembrete",
        },
        organizations: { status: "active" },
      },
    ],
    contacts: [
      { id: "cliente", organization_id: "org", name: "Ana Teste", phone_number: "+5511900000000", is_blocked: false },
    ],
    // O número oficial: fora da janela de 24 h só sai modelo aprovado.
    channel_sessions: [
      { id: "oficial", organization_id: "org", provider: CHANNEL_PROVIDER_META, status: "WORKING", archived_at: null },
    ],
    // A última mensagem do cliente foi há 3 dias: a janela fechou.
    conversations: [
      {
        id: "conversa-oficial",
        organization_id: "org",
        contact_id: "cliente",
        channel_session_id: "oficial",
        last_inbound_at: new Date(Date.now() - 72 * HORA).toISOString(),
      },
    ],
    meta_templates: [
      {
        id: "modelo-lembrete",
        organization_id: "org",
        channel_session_id: "oficial",
        name: "lembrete_da_consulta",
        language: "pt_BR",
        status: "APPROVED",
        parameter_format: "POSITIONAL",
        components: [{ type: "BODY", text: "Oi {{1}}, lembrando da sua consulta: {{2}}." }],
      },
    ],
    agent_inbox_items: [],
  };
});

describe("fora da janela de 24 h, o lembrete sai pelo modelo aprovado do número", () => {
  it("manda o modelo com o nome e o dia e a hora, e carimba antes", async () => {
    expect((await rodar()).status).toBe(200);
    expect(m.enviar).toHaveBeenCalledTimes(1);
    expect(enviado()).toMatchObject({
      type: "template",
      template_name: "lembrete_da_consulta",
      template_language: "pt_BR",
      template_values: { "1": "Ana" },
    });
    const valores = enviado()?.template_values as Record<string, string>;
    expect(valores["2"]).toMatch(/\d{2}:\d{2}/);
    // O texto que fica na conversa é o modelo preenchido — o que o cliente lê.
    expect(enviado()?.body).toBe(`Oi Ana, lembrando da sua consulta: ${valores["2"]}.`);
    expect(m.conversa).toHaveBeenCalledWith(expect.anything(), "org", "cliente", "oficial");
    expect(m.ordem.indexOf("update:calendar_appointments")).toBeLessThan(m.ordem.indexOf("enviar"));
    expect(reserva().reminder_sent_offsets_minutes).toEqual([60]);
    // Saiu: nenhum aviso de remetente aberto para a equipe.
    expect(linhas("agent_inbox_items")).toHaveLength(0);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ enviados: 1, por_modelo: 1 }) }),
    );
  });

  it("com a janela aberta segue o texto livre de sempre", async () => {
    linha("conversations").last_inbound_at = new Date(Date.now() - HORA).toISOString();
    await rodar();
    expect(enviado()).toMatchObject({ type: "text" });
  });

  it("sem modelo configurado, fora da janela não envia nem carimba, e avisa a equipe (como antes)", async () => {
    tipo().reminder_meta_template_id = null;
    const res = await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(reserva().reminder_sent_offsets_minutes).toEqual([]);
    expect(linhas("agent_inbox_items")).toHaveLength(1);
    expect(await motivos(res)).toMatchObject({ canal_fora_da_janela_24h: 1 });
  });

  it.each([
    ["não aprovado", () => (modelo().status = "PENDING")],
    ["de outro número", () => (modelo().channel_session_id = "outro")],
    ["de outra organização", () => (modelo().organization_id = "outra")],
    ["sem corpo", () => (modelo().components = [])],
    ["com variável nomeada", () => {
      modelo().parameter_format = "NAMED";
      modelo().components = [{ type: "BODY", text: "Oi {{nome_do_cliente}}" }];
    }],
  ])("modelo %s não é usado: não envia, não carimba, avisa a equipe e diz o motivo", async (_caso, estragar) => {
    estragar();
    const res = await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(reserva().reminder_sent_offsets_minutes).toEqual([]);
    expect(linhas("agent_inbox_items")).toHaveLength(1);
    expect(await motivos(res)).toMatchObject({ modelo_do_lembrete_indisponivel: 1 });
  });

  it("modelo com valor que não fecha não consome o degrau, e a equipe é avisada", async () => {
    modelo().components = [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}}" }]; // a reserva não tem endereço
    const res = await rodar();
    expect(m.enviar).not.toHaveBeenCalled();
    expect(reserva().reminder_sent_offsets_minutes).toEqual([]);
    expect(await motivos(res)).toMatchObject({ modelo_do_lembrete_sem_valores: 1 });
    // Sem isto o cliente ficaria sem lembrete e ninguém saberia.
    expect(linhas("agent_inbox_items")).toHaveLength(1);
    expect(linha("agent_inbox_items").status).toBe("open");
  });

  it("contato sem nome: o {{1}} sai com o substituto, nunca vazio", async () => {
    linha("contacts").name = null;
    await rodar();
    expect((enviado()?.template_values as Record<string, string>)["1"]).toBe("cliente");
  });
});
