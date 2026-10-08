/**
 * O CONSUMIDOR DE `lead.won` — #1477, itens 1 e 2 da CR do PR #2220.
 *
 * Um `it` por critério da CR, e os DOIS caminhos que existem no produto:
 *
 *   (a) QUALQUER transição para `won` dispara a abertura da comanda, com a
 *       opção LIGADA — arrastar o card (`POST /leads/[id]/move`) e o botão
 *       Ganhar (`/win` → `encerraDemanda`). Os dois mudam
 *       `crm_leads.status` para `won` e ninguém dos dois escreve no
 *       financeiro: quem grava `lead.won` é o gatilho
 *       `fn_emit_event_on_lead_change` (`supabase/baseline.sql`). É por isso
 *       que o banco falso daqui EMITE a mesma linha que o gatilho emite — sem
 *       essa ponte o teste provaria o handler, não o caminho.
 *   (b) opção DESLIGADA (padrão: a chave ausente) → nada é escrito;
 *   (c) o MESMO evento entregue duas vezes (o dreno reexecuta todos os
 *       handlers da linha quando um deles falha) → UMA comanda só.
 *
 * ─── Por que a porta mora no funil e não na rota ────────────────────────────
 *
 * `settings.comanda_no_ganho`, lido POR FUNIL. A régua é
 * `docs/doctrine/extensoes.md`: o consumidor é a extensão, o barramento é o
 * ponto genérico do núcleo, e a pergunta-raiz ("se nenhuma organização
 * ativar isto, a operação comum continua inteira?") é o porquê de o PADRÃO
 * ser desligado — em loja com checkout, infoproduto ou imobiliária o valor do
 * negócio não é conta a receber, e a comanda viraria uma comanda aberta sem
 * nada a cobrar.
 *
 * ─── O que este arquivo NÃO mede ────────────────────────────────────────────
 *
 * O que `comandaDoGanho` faz com a entrada (comanda, item com o valor,
 * vínculo e a trava) — isso continua em `comanda-do-ganho.test.ts`. Aqui se
 * mede o GATILHO (o caminho), a PORTA (o opt-in) e a REPETIÇÃO (o retry).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { dispatchEvent, registerHandler, type EventRow } from "@/lib/event-log/dispatcher";

/**
 * O banco que os mocks devolvem é trocado a cada teste. `vi.hoisted` porque o
 * corpo do `vi.mock` é içado para o topo do arquivo: sem isto a fábrica lê uma
 * variável ainda não inicializada e o teste morre no import, não na promessa.
 */
const estado = vi.hoisted(() => ({ banco: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => estado.banco) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => estado.banco) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";

import { COMANDA_DO_GANHO_KEY, comandaDoGanhoHandler } from "./comanda-do-ganho.handler";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const LEAD = "33333333-3333-4333-8333-333333333333";
const PIPELINE = "44444444-4444-4444-8444-444444444444";
const ETAPA_ABERTA = "55555555-5555-4555-8555-555555555555";
const ETAPA_GANHO = "66666666-6666-4666-8666-666666666666";
const CONTATO = "77777777-7777-4777-8777-777777777777";
const CARREGADO = "2026-09-15T12:00:00.000Z";

const TITULO = "Pedido de customização";

type Row = Record<string, unknown>;
type Resposta = { data: unknown; error: { message: string } | null };

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "99999999-9999-4999-9999-999999999999",
  idioma: "pt-BR",
};

function comparar(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * O banco falso, com UMA particularidade que nenhum outro falso tem: gravar em
 * `crm_leads` uma etapa `is_won` emite `lead.won` NA MESMA FORMA do gatilho
 * `fn_emit_event_on_lead_change` — `{lead_id, value_cents}` e SEM ator, porque
 * o `event_log` não guarda quem fez. É a ponte que permite testar caminho,
 * port e retry com a função real dos dois botões.
 */
function montarBanco(cenario: { funil: Row; lead?: Row; moedaOrg?: string }) {
  const tabelas: Record<string, Row[]> = {
    crm_leads: [
      {
        id: LEAD,
        organization_id: ORG,
        pipeline_id: PIPELINE,
        stage_id: ETAPA_ABERTA,
        contact_id: CONTATO,
        title: TITULO,
        value_cents: 150_000,
        owner_user_id: USER,
        status: "open",
        position_in_stage: 1000,
        updated_at: CARREGADO,
        custom_fields: {},
        won_reason: null,
        lost_reason: null,
        ...cenario.lead,
      },
    ],
    crm_stages: [
      {
        id: ETAPA_ABERTA,
        organization_id: ORG,
        pipeline_id: PIPELINE,
        name: "Proposta",
        is_won: false,
        is_lost: false,
        is_archived: false,
        position: 1,
      },
      {
        id: ETAPA_GANHO,
        organization_id: ORG,
        pipeline_id: PIPELINE,
        name: "Ganho",
        is_won: true,
        is_lost: false,
        is_archived: false,
        position: 2,
      },
    ],
    crm_pipelines: [
      {
        id: PIPELINE,
        organization_id: ORG,
        name: "Vendas",
        vocabulary: { deal: "Pedido", won: "Pago" },
        settings: cenario.funil,
      },
    ],
    crm_lead_links: [],
    sales: [],
    sale_items: [],
    organizations: [{ id: ORG, currency: cenario.moedaOrg ?? "BRL" }],
  };

  const eventos: EventRow[] = [];
  const escritas: Array<{ tabela: string; dados: Row }> = [];
  let proximoNumero = 7;
  let proximoId = 1;

  /** O que o gatilho `fn_emit_event_on_lead_change` faz no banco de verdade. */
  function emitirSeGanhou(lead: Row): void {
    if (lead.status !== "won") return;
    eventos.push({
      id: `ev-${eventos.length + 1}`,
      organization_id: ORG,
      event_type: "lead.won",
      entity_kind: "crm_lead",
      entity_id: String(lead.id),
      payload: { lead_id: lead.id, value_cents: lead.value_cents },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: new Date().toISOString(),
    });
  }

  function consulta(tabela: string) {
    if (!tabelas[tabela]) throw new Error(`tabela inesperada no teste: ${tabela}`);
    const linhas = tabelas[tabela];
    const st = {
      modo: "select" as "select" | "update" | "insert",
      filtros: [] as Array<[string, unknown]>,
      ordem: null as [string, boolean] | null,
      limite: null as number | null,
      patch: null as Row | null,
      novo: null as Row | null,
      comRetorno: false,
      single: false,
    };

    const resolver = (): Resposta => {
      const alvos = linhas.filter((l) => st.filtros.every(([c, v]) => l[c] === v));
      if (st.modo === "select") {
        let achados = alvos;
        if (st.ordem) {
          const [col, asc] = st.ordem;
          achados = [...achados].sort((a, b) => comparar(a[col], b[col]) * (asc ? 1 : -1));
        }
        if (st.limite !== null) achados = achados.slice(0, st.limite);
        return { data: st.single ? (achados[0] ?? null) : achados, error: null };
      }
      if (st.modo === "update") {
        for (const linha of alvos) {
          const patch = st.patch ?? {};
          const stageId = typeof patch.stage_id === "string" ? patch.stage_id : null;
          Object.assign(linha, patch);
          if (tabela === "crm_leads" && stageId) {
            const stage = (tabelas.crm_stages ?? []).find((s) => s.id === stageId);
            const novoStatus = stage?.is_won ? "won" : stage?.is_lost ? "lost" : "open";
            if (linha.status !== novoStatus) {
              linha.status = novoStatus;
              emitirSeGanhou(linha);
            }
          }
        }
        escritas.push({ tabela, dados: { ...(st.patch ?? {}) } });
        if (!st.comRetorno) return { data: null, error: null };
        return { data: st.single ? (alvos[0] ?? null) : alvos, error: null };
      }
      const nova: Row = { ...(st.novo ?? {}) };
      if (nova.id === undefined) {
        nova.id = `00000000-0000-4000-8000-${String(proximoId++).padStart(12, "0")}`;
      }
      if (tabela === "sales" && nova.number === undefined) nova.number = proximoNumero++;
      linhas.push(nova);
      escritas.push({ tabela, dados: nova });
      if (!st.comRetorno) return { data: null, error: null };
      return { data: st.single ? nova : [nova], error: null };
    };

    const q: Record<string, unknown> = {
      select: () => {
        st.comRetorno = true;
        return q;
      },
      update: (patch: Row) => {
        st.modo = "update";
        st.patch = patch;
        return q;
      },
      insert: (linha: Row) => {
        st.modo = "insert";
        st.novo = linha;
        return q;
      },
      eq: (col: string, valor: unknown) => {
        st.filtros.push([col, valor]);
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        st.ordem = [col, opts?.ascending !== false];
        return q;
      },
      limit: (n: number) => {
        st.limite = n;
        return q;
      },
      maybeSingle: async () => {
        st.single = true;
        return resolver();
      },
      single: async () => {
        st.single = true;
        const r = resolver();
        if (r.data === null) return { data: null, error: { message: "nenhuma linha devolvida" } };
        return r;
      },
      then: (ok: (v: Resposta) => unknown, erro?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(ok, erro),
    };
    return q;
  }

  const banco = {
    from: (tabela: string) => consulta(tabela),
    rpc: async (fn: string) => {
      if (fn === "fn_proximo_numero_de_comanda") return { data: proximoNumero++, error: null };
      return { data: null, error: null };
    },
  };

  return {
    banco,
    eventos,
    escritas,
    linhas: (tabela: string) => tabelas[tabela] ?? [],
    escritasDe: (tabela: string) => escritas.filter((e) => e.tabela === tabela),
    /** Só o que o FINANCEIRO recebe: a rota escreve no lead de qualquer jeito. */
    escritasFinanceiras: () =>
      escritas.filter((e) => ["sales", "sale_items", "crm_lead_links"].includes(e.tabela)),
  };
}

type BancoFalso = ReturnType<typeof montarBanco>;

function eventoDoGanho(banco: BancoFalso): EventRow {
  const ev = banco.eventos[0];
  if (!ev) throw new Error("o gatilho não emitiu lead.won — o caminho não chegou ao banco");
  return ev;
}

/** O caminho UM: arrastar o card para a coluna de ganho. */
async function fecharPeloArrasto(banco: BancoFalso): Promise<void> {
  estado.banco = banco.banco;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  const { POST } = await import("../../app/api/v1/leads/[id]/move/route");
  const req = new NextRequest(`http://localhost/api/v1/leads/${LEAD}/move`, {
    method: "POST",
    body: JSON.stringify({
      stage_id: ETAPA_GANHO,
      position_in_stage: 2500,
      expected_updated_at: CARREGADO,
    }),
    headers: { "content-type": "application/json" },
  });
  const resp = await POST(req, { params: Promise.resolve({ id: LEAD }) });
  expect(resp.status, "o arrasto para a etapa de ganho passa").toBe(200);
}

/** O caminho DOIS: o botão Ganhar (`/win` → `encerraDemanda`). */
async function fecharPeloBotaoGanhar(banco: BancoFalso): Promise<void> {
  estado.banco = banco.banco;
  const { encerraDemanda } = await import("../../lib/leads/encerramento");
  await encerraDemanda(banco.banco as unknown as SupabaseClient, ctx, {
    leadId: LEAD,
    desfecho: "won",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  registerHandler(comandaDoGanhoHandler);
});

describe("(a) qualquer caminho para `won` abre a comanda, com a opção ligada", () => {
  it("arrasto no Kanban: rota → gatilho `lead.won` → consumidor → comanda + vínculo", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true } });

    await fecharPeloArrasto(banco);
    expect(banco.eventos, "o gatilho do banco emitiu lead.won").toHaveLength(1);

    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });
    expect(r).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "ok" }),
    );
    expect(banco.escritasDe("sales")).toHaveLength(1);
    expect(banco.escritasDe("sale_items")[0]?.dados).toMatchObject({
      description: "Pedido · Vendas",
      unit_price_cents: 150_000,
    });
    expect(banco.escritasDe("crm_lead_links")[0]?.dados).toMatchObject({
      lead_id: LEAD,
      target_kind: "order",
      link_kind: "comanda_no_ganho",
    });
  });

  it("botão Ganhar: `encerraDemanda` → gatilho `lead.won` → consumidor → comanda", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true } });

    await fecharPeloBotaoGanhar(banco);
    expect(banco.eventos, "o gatilho do banco emitiu lead.won").toHaveLength(1);

    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });
    expect(r).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "ok" }),
    );
    expect(banco.escritasDe("sales")).toHaveLength(1);
  });

  it("responsável nulo: a comanda nasce sem atendente em vez de não nascer", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true }, lead: { owner_user_id: null } });

    await fecharPeloBotaoGanhar(banco);
    await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(banco.escritasDe("sales")[0]?.dados).toMatchObject({ attendant_user_id: null });
  });

  it("negócio sem valor: skipped sem inventar dinheiro", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true }, lead: { value_cents: null } });

    await fecharPeloBotaoGanhar(banco);
    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({
        consumer_key: COMANDA_DO_GANHO_KEY,
        status: "skipped",
        detail: "sem_valor_valido",
      }),
    );
    expect(banco.escritasDe("sales")).toHaveLength(0);
  });
});

describe("(b) opção desligada — o padrão de toda organização", () => {
  it("funil sem a chave: o arrasto fecha o negócio e NADA é escrito no financeiro", async () => {
    const banco = montarBanco({ funil: {} });

    await fecharPeloArrasto(banco);
    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({
        consumer_key: COMANDA_DO_GANHO_KEY,
        status: "skipped",
        detail: "comanda_no_ganho_desligada",
      }),
    );
    expect(banco.escritasFinanceiras(), "nenhuma escrita em comanda, item ou vínculo").toHaveLength(
      0,
    );
  });

  it("chave explicitamente desligada: o botão Ganhar também não toca no financeiro", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: false } });

    await fecharPeloBotaoGanhar(banco);
    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "skipped" }),
    );
    expect(banco.escritasFinanceiras()).toHaveLength(0);
  });
});

describe("(c) idempotência sob retry do dreno", () => {
  it("o mesmo lead.won entregue duas vezes abre UMA comanda só", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true } });

    await fecharPeloBotaoGanhar(banco);
    const ev = eventoDoGanho(banco);

    const primeira = await dispatchEvent(ev, { orgParada: false });
    expect(primeira).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "ok" }),
    );
    // O dreno não limpa `consumed_by` entre handlers: a segunda entrega roda a
    // fila inteira de novo, e é a trava do vínculo que segura a duplicata.
    const segunda = await dispatchEvent({ ...ev, consumed_by: [] }, { orgParada: false });
    expect(segunda).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "ok" }),
    );

    expect(banco.escritasDe("sales"), "uma comanda só").toHaveLength(1);
    expect(banco.escritasDe("crm_lead_links")).toHaveLength(1);
    expect(banco.escritasDe("sale_items")).toHaveLength(1);
  });

  it("fechar, reabrir e fechar de novo: dois eventos `lead.won`, UMA comanda", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true } });

    await fecharPeloArrasto(banco);
    await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    // Reabertura de verdade: o lead volta para a etapa aberta e o gatilho
    // emite `lead.reopened` (que ninguém aqui consome). O segundo fecho, pelo
    // botão, é um evento NOVO — e é ele que a trava do vínculo tem de pegar.
    const lead = banco.linhas("crm_leads")[0] as Row;
    lead.stage_id = ETAPA_ABERTA;
    lead.status = "open";
    await fecharPeloBotaoGanhar(banco);

    expect(banco.eventos, "dois `lead.won` no barramento").toHaveLength(2);
    await dispatchEvent(banco.eventos[1] as EventRow, { orgParada: false });

    expect(banco.escritasDe("sales")).toHaveLength(1);
    expect(banco.escritasDe("crm_lead_links")).toHaveLength(1);
  });
});

/**
 * (d) O evento é PISTA, não fato. `emit_event` aceita chamador `authenticated`
 * com papel `viewer` (última definição em `supabase/baseline.sql`), e `lead.won`
 * não está na lista de tipos que ele reserva — então a linha pode chegar ao
 * barramento sem que negócio nenhum tenha sido ganho, com o valor que quem a
 * forjou quis. Estes casos montam a linha À MÃO, sem passar pelo gatilho.
 */
describe("(d) o evento forjado não abre comanda nem dita o valor", () => {
  const OUTRA_ORG = "88888888-8888-4888-8888-888888888888";

  function eventoForjado(sobre: Partial<EventRow> & { payload?: Row } = {}): EventRow {
    return {
      id: "ev-forjado",
      organization_id: ORG,
      event_type: "lead.won",
      entity_kind: "crm_lead",
      entity_id: LEAD,
      payload: { lead_id: LEAD, value_cents: 999_999_999 },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: new Date().toISOString(),
      ...sobre,
    };
  }

  it("negócio ganho com valor inventado no payload: a comanda leva o valor DO BANCO", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true }, lead: { status: "won" } });
    estado.banco = banco.banco;

    const r = await dispatchEvent(eventoForjado(), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "ok" }),
    );
    expect(banco.escritasDe("sale_items")[0]?.dados).toMatchObject({
      unit_price_cents: 150_000,
      total_cents: 150_000,
    });
  });

  it("negócio ABERTO: `lead.won` forjado é ignorado e nada vai ao financeiro", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true } });
    estado.banco = banco.banco;

    const r = await dispatchEvent(eventoForjado(), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({
        consumer_key: COMANDA_DO_GANHO_KEY,
        status: "skipped",
        detail: "negocio_nao_ganho",
      }),
    );
    expect(banco.escritasFinanceiras()).toHaveLength(0);
  });

  it("evento de OUTRA organização apontando para este negócio: não acha o negócio e não escreve", async () => {
    // O falso filtra por toda coluna de `.eq` — o negócio existe, ganho, mas
    // na organização ORG. Sem o filtro de tenant na leitura ele seria achado.
    const banco = montarBanco({ funil: { comanda_no_ganho: true }, lead: { status: "won" } });
    estado.banco = banco.banco;

    const r = await dispatchEvent(eventoForjado({ organization_id: OUTRA_ORG }), {
      orgParada: false,
    });

    expect(r).toContainEqual(
      expect.objectContaining({
        consumer_key: COMANDA_DO_GANHO_KEY,
        status: "skipped",
        detail: "negocio_nao_encontrado",
      }),
    );
    expect(banco.escritasFinanceiras()).toHaveLength(0);
  });
});

/**
 * (e) LGPD: o título do negócio NÃO sai do alcance do redact. Ele costuma ser o
 * nome ou o telefone do contato (a automação cria o negócio com
 * `nomeDoContato(contact) ?? phone_number`), e `fn_lgpd_cascade_redact_contact`
 * anonimiza `crm_leads.title` mas não toca `sale_items` nem `crm_lead_links`.
 */
describe("(e) o título do negócio não é copiado para o financeiro", () => {
  it("nenhuma escrita em comanda, item ou vínculo carrega o título — o item leva o vocabulário do funil", async () => {
    const PESSOAL = "Maria Aparecida 11 98888-7777";
    const banco = montarBanco({ funil: { comanda_no_ganho: true }, lead: { title: PESSOAL } });

    await fecharPeloBotaoGanhar(banco);
    await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(banco.escritasDe("sales")).toHaveLength(1);
    expect(JSON.stringify(banco.escritasFinanceiras())).not.toContain("Maria");
    expect(JSON.stringify(banco.escritasFinanceiras())).not.toContain("98888");
    expect(banco.escritasDe("sale_items")[0]?.dados).toMatchObject({
      description: "Pedido · Vendas",
    });
  });
});

/**
 * (f) Item 1 da #2475: a moeda do negócio contra a da organização, e o audit
 * da comanda que antes nascia invisível no painel.
 */
describe("(f) moeda do negócio x moeda da organização + audit da comanda", () => {
  it("moeda diferente da da organização: a comanda é PULADA e nada vai ao financeiro", async () => {
    // Negócio em USD numa organização em BRL: abrir a comanda misturaria
    // centavos de duas moedas no mesmo relatório, sem ninguém perceber.
    const banco = montarBanco({
      funil: { comanda_no_ganho: true },
      lead: { currency: "USD" },
      moedaOrg: "BRL",
    });

    await fecharPeloArrasto(banco);
    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({
        consumer_key: COMANDA_DO_GANHO_KEY,
        status: "skipped",
        // O detail carrega as duas moedas (moeda_divergente:USD!=BRL): é o
        // registro do porquê aquela comanda não nasceu.
        detail: expect.stringContaining("moeda_divergente"),
      }),
    );
    expect(banco.escritasFinanceiras()).toHaveLength(0);
  });

  it("a armadilha do DEFAULT 'BRL': organização em EUR com lead recém-nascido não é pulada", async () => {
    // `crm_leads.currency` tem DEFAULT 'BRL'. Uma organização em EUR cujo lead
    // nasceu sem moeda escolhida carrega 'BRL' por conta do banco — e uma
    // guarda ingênua (`lead.currency !== org.currency`) pularia COMPLETO o
    // financeiro dessa organização. O 'BRL' aqui é o default, não uma escolha.
    const banco = montarBanco({
      funil: { comanda_no_ganho: true },
      lead: { currency: "BRL" },
      moedaOrg: "EUR",
    });

    await fecharPeloArrasto(banco);
    const r = await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    expect(r).toContainEqual(
      expect.objectContaining({ consumer_key: COMANDA_DO_GANHO_KEY, status: "ok" }),
    );
    expect(banco.escritasDe("sales"), "a comanda abre mesmo assim").toHaveLength(1);
  });

  it("a comanda aberta deixa rastro no audit com a origem `ganho_no_kanban`", async () => {
    const banco = montarBanco({ funil: { comanda_no_ganho: true } });

    await fecharPeloArrasto(banco);
    await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    const chamadas = vi.mocked(audit).mock.calls.map((c) => c[0]);
    const abertura = chamadas.find((e) => e.action === "comanda.aberta");
    expect(abertura, "o audit `comanda.aberta` é emitido").toBeDefined();
    expect(abertura).toMatchObject({
      organizationId: ORG,
      resourceType: "sale",
      metadata: { origem: "ganho_no_kanban", lead_id: LEAD },
    });
    expect(String(abertura?.resourceId)).toBe(banco.escritasDe("sales")[0]?.dados.id);
  });

  it("quando a comanda é pulada, o audit NÃO registra `comanda.aberta` (não abriu)", async () => {
    const banco = montarBanco({
      funil: { comanda_no_ganho: true },
      lead: { currency: "USD" },
      moedaOrg: "BRL",
    });

    await fecharPeloArrasto(banco);
    await dispatchEvent(eventoDoGanho(banco), { orgParada: false });

    const chamadas = vi.mocked(audit).mock.calls.map((c) => c[0]);
    expect(chamadas.find((e) => e.action === "comanda.aberta")).toBeUndefined();
  });
});
