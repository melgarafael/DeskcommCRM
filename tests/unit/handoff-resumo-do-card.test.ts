import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O RESUMO DA PASSAGEM LÊ O CARD DA CONVERSA (issue #4303) — os dois motores.
 *
 * A régua pura mora em `campos-do-card-no-resumo-da-passagem.test.ts`. Aqui se
 * prova o CAMINHO: o card é lido e o que sai dele chega ao `briefing.body` que
 * a pessoa lê na passagem.
 *
 *   (b) ligado → o campo aparece no resumo com rótulo e valor;
 *   (d) contato com DOIS cards abertos → usa o card da conversa (o mais
 *       recente), e NUNCA soma os valores dos dois: somar inventaria um total
 *       que ninguém digitou;
 *   (f) card de OUTRA organização não entra, nem o funil de lá;
 *   (a) com a opção desligada em todos os campos (ou sem card declarado), o
 *       resumo é o de hoje — comparado com o caminho que não lê card nenhum.
 *
 * Os dois mundos estão no mesmo arquivo de propósito: o defeito da issue é o
 * resumo da passagem, e ele tem dois encanamentos (`performHumanHandoff` fala
 * `pg.Pool`; o orquestrador do CRM fala supabase-js). Medir um só deixaria o
 * outro divergir em silêncio — foi o que já aconteceu neste repositório.
 */

// ── O mundo do CRM (supabase-js). ──────────────────────────────────────────
interface Card {
  id: string;
  organization_id: string;
  contact_id: string;
  pipeline_id: string;
  status: string;
  custom_fields: Record<string, unknown>;
}

const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "99999999-9999-4999-8999-999999999999";
const FUNIL_A = "44444444-4444-4444-8444-444444444444";
const FUNIL_B = "88888888-8888-4888-8888-888888888888";

const inseridos: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];

const MUNDO = {
  cards: [] as Card[],
  funis: {} as Record<string, Record<string, unknown>>,
  moeda: "BRL",
  /** `true` = o dublê só devolve a linha se o filtro de organização veio. */
  respeitarOrganizacao: true,
};

function mundoDoCrm() {
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: () => chain,
      insert: (linha: Record<string, unknown>) => {
        inseridos.push({ tabela, linha });
        return Promise.resolve({ data: null, error: null });
      },
      eq: (campo: string, valor: unknown) => {
        filtros[campo] = valor;
        return chain;
      },
      gt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        consultas.push({ tabela, filtros: { ...filtros } });
        const orgCasa = (linha: { organization_id: string }) =>
          !MUNDO.respeitarOrganizacao || filtros.organization_id === undefined || linha.organization_id === filtros.organization_id;

        if (tabela === "conversations") {
          return Promise.resolve({
            data: {
              id: CONVERSA,
              organization_id: ORG_A,
              contact_id: CONTATO,
              last_handoff_at: null,
              last_handoff_reason: null,
              last_outbound_at: null,
            },
            error: null,
          });
        }
        if (tabela === "crm_leads") {
          const card = MUNDO.cards.find(
            (c) =>
              orgCasa(c) &&
              (filtros.id === undefined || c.id === filtros.id) &&
              (filtros.contact_id === undefined || c.contact_id === filtros.contact_id) &&
              (filtros.status === undefined || c.status === filtros.status),
          );
          return Promise.resolve({ data: card ?? null, error: null });
        }
        if (tabela === "crm_pipelines") {
          const settings = MUNDO.funis[String(filtros.id)];
          const doOrg = filtros.organization_id === ORG_A || filtros.organization_id === ORG_B;
          return Promise.resolve({ data: settings && doOrg ? { settings } : null, error: null });
        }
        if (tabela === "organizations") {
          return Promise.resolve({ data: { currency: MUNDO.moeda }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return chain;
  };
  return {
    from,
    rpc: () => Promise.resolve({ error: null }),
    channel: () => ({ send: async () => undefined }),
    removeChannel: async () => undefined,
  };
}

vi.mock("@/lib/ai/handoff/aviso-ao-lead", () => ({
  avisarLeadDoCrm: vi.fn(async () => ({ avisado: true })),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({
    permite: true,
    motivo: "autorizado",
    bloqueioPorAllowlist: false,
  })),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mundoDoCrm() }));

// ── O mundo do motor de conversa (pg.Pool). ────────────────────────────────
vi.mock("@/lib/atendimento/fronteira-server", () => ({ guardServiceEffect: vi.fn(async () => {}) }));
vi.mock("@/lib/escalacao/disponibilidade", () => ({
  expectativaDeAtendimento: vi.fn(async () => ({ frase: "A equipe dará continuidade." })),
}));
vi.mock("@/lib/leads/agent-activity", () => ({ emitAgentActivityForContact: vi.fn(async () => true) }));
vi.mock("@/lib/agent-engine/cron/scheduler", () => ({ cancelPendingCronsForLead: vi.fn(async () => {}) }));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { applyRequestHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";

// ══════════════════════════════════════════════════════════════════════════
// O MOTOR DO CRM — `triggerHandoff` (supabase-js)
// ══════════════════════════════════════════════════════════════════════════

function funilDoCard(exibir: boolean, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fields: [
      {
        key: "consumo_kwh",
        label: "Consumo (kWh)",
        type: "number",
        ...(exibir ? { mostrar_no_resumo_da_passagem: true } : {}),
      },
      { key: "valor_da_conta", label: "Valor da conta", type: "currency" },
      ...((extras.fields as unknown[]) ?? []),
    ],
  };
}

function card(over: Partial<Card> = {}): Card {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organization_id: ORG_A,
    contact_id: CONTATO,
    pipeline_id: FUNIL_A,
    status: "open",
    custom_fields: { consumo_kwh: 320, valor_da_conta: 189.9 },
    ...over,
  };
}

async function orquestrar(entrada: Partial<Parameters<typeof triggerHandoff>[0]> = {}) {
  return triggerHandoff({
    conversationId: CONVERSA,
    organizationId: ORG_A,
    reason: "requested_human",
    origem: "legado_pedido",
    ...entrada,
  });
}

function corpoDaPassagemDoCrm(): string {
  const insert = inseridos.find((i) => i.tabela === "passagens_de_atendimento");
  expect(insert, "a passagem não foi gravada").toBeTruthy();
  return String(insert!.linha.body);
}

describe("orquestrador do CRM: o card da conversa no resumo", () => {
  beforeEach(() => {
    inseridos.length = 0;
    consultas.length = 0;
    MUNDO.cards = [];
    MUNDO.funis = {};
    MUNDO.moeda = "BRL";
    MUNDO.respeitarOrganizacao = true;
    vi.clearAllMocks();
  });

  it("(b) campo marcado chega ao resumo com o RÓTULO e o valor do card", async () => {
    MUNDO.cards = [card()];
    MUNDO.funis[FUNIL_A] = funilDoCard(true);

    await orquestrar({ leadId: MUNDO.cards[0]!.id });

    const corpo = corpoDaPassagemDoCrm();
    expect(corpo).toContain("• Consumo (kWh): 320");
    expect(corpo).not.toContain("consumo_kwh");
    // O outro campo do card NÃO foi marcado: não aparece.
    expect(corpo).not.toContain("Valor da conta");
  });

  it("(a) opção desligada em todos os campos = o resumo de hoje, string inteira", async () => {
    MUNDO.cards = [card()];
    MUNDO.funis[FUNIL_A] = funilDoCard(false);

    await orquestrar({ leadId: MUNDO.cards[0]!.id });
    const comCardDesligado = corpoDaPassagemDoCrm();

    inseridos.length = 0;
    // Sem `leadId` o orquestrador não tem card declarado e não inventa um:
    // este é o resumo de hoje, o caminho que não lê card nenhum.
    await orquestrar();
    const semCard = corpoDaPassagemDoCrm();

    expect(comCardDesligado).toBe(semCard);
  });

  it("(f) card de OUTRA organização não entra — nem o funil de lá", async () => {
    const alheio = card({ organization_id: ORG_B, pipeline_id: FUNIL_B, custom_fields: { consumo_kwh: 777 } });
    MUNDO.cards = [alheio];
    MUNDO.funis[FUNIL_B] = funilDoCard(true);

    await orquestrar({ leadId: alheio.id });

    expect(corpoDaPassagemDoCrm()).not.toContain("777");
    expect(corpoDaPassagemDoCrm()).not.toContain("Consumo (kWh)");
    // A proteção é o filtro programático (service-role bypassa RLS): a
    // consulta do card tem de carregar a organização da passagem.
    const buscaDoCard = consultas.find((c) => c.tabela === "crm_leads" && c.filtros.id === alheio.id);
    expect(buscaDoCard?.filtros.organization_id).toBe(ORG_A);
  });

  it("leadId ausente não inventa card, mesmo com card aberto do contato", async () => {
    MUNDO.cards = [card()];
    MUNDO.funis[FUNIL_A] = funilDoCard(true);

    await orquestrar();

    expect(corpoDaPassagemDoCrm()).not.toContain("Consumo (kWh)");
    expect(consultas.some((c) => c.tabela === "crm_leads")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// O MOTOR DE CONVERSA — `applyRequestHumanHandoff` (pg.Pool)
// ══════════════════════════════════════════════════════════════════════════

interface LinhaDoCard {
  settings: Record<string, unknown> | null;
  custom_fields: Record<string, unknown>;
  moeda: string | null;
}

const consultasDoMotor: Array<{ sql: string; params: readonly unknown[] }> = [];

function poolComCards(linhas: LinhaDoCard[]) {
  return {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      consultasDoMotor.push({ sql, params });
      if (sql.includes("from crm_leads l")) return { rows: linhas, rowCount: linhas.length };
      return { rows: [], rowCount: 0 };
    }),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };

async function passarPelaFerramenta(linhas: LinhaDoCard[]): Promise<string> {
  await applyRequestHumanHandoff(
    poolComCards(linhas) as never,
    { tenantId: ORG_A, leadId: CONTATO, conversationId: CONVERSA },
    {
      conversationSummary: "resumo",
      contextoDoTurno: { checkpoint: null, pendentesDoCliente: ["quero falar com alguém"] },
      avisoAoLead: { avisado: true },
      log: log as never,
    },
    { motivo_codigo: "requested_human" },
  );
  const insert = consultasDoMotor.find((c) => c.sql.includes("insert into passagens_de_atendimento"));
  expect(insert, "a passagem não foi gravada").toBeTruthy();
  // Índice 8 = `body`, na ordem de `COLUNAS_DA_PASSAGEM`.
  return String(insert!.params[8]);
}

describe("motor de conversa: o card da conversa no resumo", () => {
  beforeEach(() => {
    consultasDoMotor.length = 0;
    vi.clearAllMocks();
  });

  it("(b) campo marcado chega ao briefing com rótulo e valor", async () => {
    const corpo = await passarPelaFerramenta([
      { settings: funilDoCard(true), custom_fields: { consumo_kwh: 320 }, moeda: "BRL" },
    ]);
    expect(corpo).toContain("• Consumo (kWh): 320");
    expect(corpo).not.toContain("consumo_kwh");
  });

  it("(d) dois cards abertos: usa o card da conversa e NUNCA soma os dois", async () => {
    // O dublê devolve DOIS cards (um banco sem o `limit 1` faria isso): só o
    // primeiro — o mais recente, o da conversa — pode entrar no resumo.
    const corpo = await passarPelaFerramenta([
      { settings: funilDoCard(true), custom_fields: { consumo_kwh: 320 }, moeda: "BRL" },
      { settings: funilDoCard(true), custom_fields: { consumo_kwh: 480 }, moeda: "BRL" },
    ]);
    expect(corpo).toContain("• Consumo (kWh): 320");
    expect(corpo).not.toContain("480");
    expect(corpo).not.toContain("800");

    // E a consulta é UMA linha, do card mais recente: a regra mora no SQL.
    const busca = consultasDoMotor.find((c) => c.sql.includes("from crm_leads l"));
    expect(busca?.sql).toMatch(/order by l\.updated_at desc/);
    expect(busca?.sql).toMatch(/limit 1/);
    expect(busca?.params).toEqual([ORG_A, CONTATO]);
  });

  it("(a) todos desligados = resumo de hoje, string inteira", async () => {
    const comCardDesligado = await passarPelaFerramenta([
      { settings: funilDoCard(false), custom_fields: { consumo_kwh: 320 }, moeda: "BRL" },
    ]);
    consultasDoMotor.length = 0;
    const semCard = await passarPelaFerramenta([]);
    expect(comCardDesligado).toBe(semCard);
  });

  it("(c) campo marcado e vazio não aparece", async () => {
    const corpo = await passarPelaFerramenta([
      { settings: funilDoCard(true), custom_fields: { consumo_kwh: "" }, moeda: "BRL" },
    ]);
    expect(corpo).not.toContain("Consumo (kWh)");
  });

  it("(f) a leitura do card é escopada pela organização da passagem", async () => {
    await passarPelaFerramenta([{ settings: funilDoCard(true), custom_fields: { consumo_kwh: 320 }, moeda: "BRL" }]);
    const busca = consultasDoMotor.find((c) => c.sql.includes("from crm_leads l"));
    expect(busca?.params[0]).toBe(ORG_A);
    expect(busca?.sql).toContain("l.organization_id = $1");
  });
});
