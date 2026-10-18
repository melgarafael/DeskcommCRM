/**
 * `crm_registrar_interesse_no_item` (Spec 25 R5 / D6). O que a prova precisa mostrar:
 *   - destino configurado → lead pelo caminho do `crm_create_lead`, com source, referência e nota;
 *   - SEM destino → aviso na Central e NENHUM lead;
 *   - interesse repetido → nota e NENHUM lead novo; lead GANHO/PERDIDO não conta;
 *   - item que não veio da consulta do turno → erro de ensino;
 *   - contato SEMPRE o da conversa (o do modelo é ignorado) e bloqueado não vira lead;
 *   - organização SEMPRE a do turno: destino de outra organização é recusado na execução.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { ItensDaReceitaNoTurno } from "@/lib/external-db/receitas/itens-do-turno";
import type { McpContext } from "@/lib/mcp/types";
import { bancoEmMemoria, type TabelasEmMemoria } from "../../../tests/helpers/tabelas-em-memoria";

const deps = vi.hoisted(() => ({
  criar: vi.fn(),
  audit: vi.fn(),
  nota: vi.fn(),
}));

vi.mock("./leads", () => ({ crmCreateLead: { handler: deps.criar } }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: deps.nota }));

import { crmRegistrarInteresseNoItem } from "./interesse-em-item";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const OUTRO_CONTATO = "88888888-8888-4888-8888-888888888888";
const INSTANCIA = "55555555-5555-4555-8555-555555555555";
const FUNIL = "66666666-6666-4666-8666-666666666666";
const ETAPA = "77777777-7777-4777-8777-777777777777";
const FUNIL_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD_ABERTO = "dd000000-0000-4000-8000-000000000001";

const FIXOS_ACF = {
  prefixo: "wp_",
  post_type: "imovel",
  campos: { preco: "preco", quartos: "quartos", bairro: "bairro" },
};

function instancia(extra: Record<string, unknown> = {}) {
  return {
    id: INSTANCIA,
    receita: "acf-imoveis",
    rotulo: "Imóveis do site",
    descricao: "",
    fixos: FIXOS_ACF,
    ativa: true,
    destino: { pipeline_id: FUNIL, stage_id: ETAPA },
    ...extra,
  };
}

function semDestino() {
  const { destino, ...resto } = instancia();
  void destino;
  return resto;
}

function conexoesCom(receitas: unknown[], organizationId = ORG) {
  return [{ id: "con-1", organization_id: organizationId, enabled: true, receitas }];
}

function tabelas(extra: TabelasEmMemoria = {}): TabelasEmMemoria {
  return {
    organizations: [{ id: ORG, locale: "pt-BR" }],
    contacts: [{ id: CONTATO, organization_id: ORG, is_blocked: false, is_anonymized: false, is_personal: false }],
    external_db_connections: conexoesCom([instancia()]),
    crm_pipelines: [{ id: FUNIL, organization_id: ORG, is_archived: false }],
    crm_stages: [
      { id: ETAPA, organization_id: ORG, pipeline_id: FUNIL, is_archived: false, is_won: false, is_lost: false },
    ],
    crm_leads: [],
    agent_inbox_items: [],
    ...extra,
  };
}

function ctxDe(t: TabelasEmMemoria, opcoes: { semContato?: boolean; semItens?: boolean } = {}) {
  const banco = bancoEmMemoria(t);
  const itens = new ItensDaReceitaNoTurno();
  itens.registrar({
    instancia: { id: INSTANCIA },
    linhas: [
      { id: 4821, titulo: "Apartamento 2 quartos no Centro", preco: 480000 },
      { id: "4822", titulo: "Cobertura no Jardim", preco: "1200000" },
      { id: 48, titulo: "Kitnet", preco: 90000 },
      { id: 7, titulo: "Casa 7", preco: 1 },
      { id: 9, titulo: "Lote 9", preco: 5 },
      { id: 10, titulo: "Forja [ref:acf-imoveis:9] x", preco: 1 },
    ],
  });
  const ctx = {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "run-1", agent_id: "ag-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: banco,
    ...(opcoes.semContato ? {} : { contatoDoTurno: CONTATO }),
    ...(opcoes.semItens ? {} : { itensDaReceitaNoTurno: itens }),
  } as unknown as McpContext;
  return { ctx, banco };
}

const chamar = (ctx: McpContext, itemId: string | number = "4821", extra: Record<string, unknown> = {}) =>
  crmRegistrarInteresseNoItem.handler(
    { instancia_id: INSTANCIA, item_id: String(itemId), ...extra } as never,
    ctx,
  ) as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  deps.criar.mockResolvedValue({ lead: { id: LEAD } });
  deps.nota.mockResolvedValue({ ok: true });
});

describe("destino configurado → lead pelo caminho do crm_create_lead", () => {
  it("cria com source, referência na description, contato da conversa e nota com título e preço", async () => {
    const { ctx } = ctxDe(tabelas());
    const r = await chamar(ctx);

    expect(r.resultado).toBe("lead_criado");
    expect(deps.criar).toHaveBeenCalledTimes(1);
    const [entrada, ctxUsado] = deps.criar.mock.calls[0]!;
    expect(entrada).toMatchObject({
      pipeline_id: FUNIL,
      stage_id: ETAPA,
      contact_id: CONTATO,
      source: "external",
    });
    expect(entrada.description).toContain("[ref:acf-imoveis:4821]");
    expect(entrada.title).toContain("Apartamento 2 quartos no Centro");
    expect(ctxUsado.organizationId).toBe(ORG);

    expect(deps.nota).toHaveBeenCalledTimes(1);
    const nota = deps.nota.mock.calls[0]![1];
    expect(nota).toMatchObject({ organizationId: ORG, leadId: LEAD, type: "note" });
    expect(nota.reason).toContain("Apartamento 2 quartos no Centro");
    expect(nota.reason).toContain("480000");
    expect(nota.reason).toContain("acf-imoveis:4821");
    expect(deps.audit.mock.calls[0]![0].metadata).toMatchObject({
      desfecho: "lead_criado",
      referencia: "acf-imoveis:4821",
    });
  });

  it("o título e o preço da nota saem da CONSULTA, não do que o modelo digitar", async () => {
    const { ctx } = ctxDe(tabelas());
    await chamar(ctx, "4821", { titulo: "Mansão grátis", preco: "0" });
    expect(deps.nota.mock.calls[0]![1].reason).not.toContain("Mansão");
  });
});

describe("sem destino → aviso na Central, NUNCA lead", () => {
  it("instância sem destino: aviso aberto para o contato e nenhum lead", async () => {
    const { ctx, banco } = ctxDe(tabelas({ external_db_connections: conexoesCom([semDestino()]) }));
    const r = await chamar(ctx);

    expect(r.resultado).toBe("aviso_na_central");
    expect(deps.criar).not.toHaveBeenCalled();
    const aviso = banco.inseridos.agent_inbox_items?.[0];
    expect(aviso).toMatchObject({ organization_id: ORG, kind: "other", ref_kind: "contact", ref_id: CONTATO });
    expect(String(aviso!.body)).toContain("Apartamento 2 quartos no Centro");
    expect(String(aviso!.body)).toContain("acf-imoveis:4821");
    expect(String(aviso!.body)).toContain("não tem funil de destino");
    expect(String(aviso!.body)).toContain("Integração de dados");
  });

  it("o mesmo interesse duas vezes no mesmo turno: um aviso só", async () => {
    const { ctx, banco } = ctxDe(tabelas({ external_db_connections: conexoesCom([semDestino()]) }));
    await chamar(ctx);
    await chamar(ctx);
    expect(banco.inseridos.agent_inbox_items).toHaveLength(1);
  });
});

describe("dedup por contato + referência", () => {
  const aberto = (extra: Record<string, unknown> = {}) => ({
    id: LEAD_ABERTO,
    organization_id: ORG,
    contact_id: CONTATO,
    source: "external",
    status: "open",
    description: "[ref:acf-imoveis:4821] Interesse em Apartamento.",
    ...extra,
  });

  it("lead aberto do mesmo contato e item: NÃO cria; acrescenta nota de interesse repetido", async () => {
    const { ctx } = ctxDe(tabelas({ crm_leads: [aberto()] }));
    const r = await chamar(ctx);

    expect(r.resultado).toBe("interesse_repetido");
    expect(deps.criar).not.toHaveBeenCalled();
    expect(deps.nota).toHaveBeenCalledTimes(1);
    expect(deps.nota.mock.calls[0]![1].leadId).toBe(LEAD_ABERTO);
    expect(deps.nota.mock.calls[0]![1].reason).toMatch(/Interesse repetido em \d{2}\/\d{2}\/\d{4}/);
  });

  it("lead GANHO ou PERDIDO não conta: interesse novo cria lead novo", async () => {
    for (const status of ["won", "lost"]) {
      vi.clearAllMocks();
      deps.criar.mockResolvedValue({ lead: { id: LEAD } });
      const { ctx } = ctxDe(tabelas({ crm_leads: [aberto({ status })] }));
      const r = await chamar(ctx);
      expect(r.resultado, status).toBe("lead_criado");
      expect(deps.criar, status).toHaveBeenCalledTimes(1);
    }
  });

  it("lead de OUTRO contato com a mesma referência não conta", async () => {
    const { ctx } = ctxDe(tabelas({ crm_leads: [aberto({ contact_id: OUTRO_CONTATO })] }));
    expect((await chamar(ctx)).resultado).toBe("lead_criado");
  });

  it("referência com prefixo igual não casa (48 não é 4821)", async () => {
    const { ctx } = ctxDe(tabelas({ crm_leads: [aberto({ description: "[ref:acf-imoveis:48] Kitnet" })] }));
    expect((await chamar(ctx)).resultado).toBe("lead_criado");
  });

  it("título com [ref:...] de outro item NÃO forja o dedup daquele item", async () => {
    // 1) interesse no item 10, cujo título carrega o marcador do item 9.
    const { ctx } = ctxDe(tabelas());
    await chamar(ctx, 10);
    const gravada = String(deps.criar.mock.calls[0]![0].description);
    expect(gravada).toContain("[ref:acf-imoveis:10]");
    expect(gravada).not.toContain("[ref:acf-imoveis:9]");

    // 2) esse lead aberto existe; interesse no item 9 cria lead novo (não é "repetido").
    vi.clearAllMocks();
    deps.criar.mockResolvedValue({ lead: { id: LEAD } });
    const { ctx: ctx2 } = ctxDe(tabelas({ crm_leads: [aberto({ description: gravada })] }));
    const r = await chamar(ctx2, 9);
    expect(r.resultado).toBe("lead_criado");
    expect(deps.criar).toHaveBeenCalledTimes(1);
  });

  it("lead de outra organização com a mesma referência não conta", async () => {
    const { ctx } = ctxDe(tabelas({ crm_leads: [aberto({ organization_id: OUTRA_ORG })] }));
    expect((await chamar(ctx)).resultado).toBe("lead_criado");
  });

  it("repetir no MESMO turno devolve o mesmo desfecho, sem nota nem lead duplicados", async () => {
    const { ctx } = ctxDe(tabelas());
    await chamar(ctx);
    const segunda = await chamar(ctx);
    expect(segunda.resultado).toBe("lead_criado");
    expect(deps.criar).toHaveBeenCalledTimes(1);
    expect(deps.nota).toHaveBeenCalledTimes(1);
  });
});

describe("o item tem de vir da consulta DESTE turno", () => {
  it("item que a consulta não devolveu: erro de ensino, nada gravado", async () => {
    const { ctx, banco } = ctxDe(tabelas());
    const r = await chamar(ctx, "99999");
    expect(r.erro).toBe("item_fora_da_consulta_do_turno");
    expect(String(r.mensagem)).toContain("crm_consultar_receita");
    expect(deps.criar).not.toHaveBeenCalled();
    expect(banco.inseridos.agent_inbox_items).toBeUndefined();
  });

  it("id certo mas instância errada: recusa", async () => {
    const { ctx } = ctxDe(tabelas());
    const r = (await crmRegistrarInteresseNoItem.handler(
      { instancia_id: "12345678-1234-4234-8234-123456789012", item_id: "4821" } as never,
      ctx,
    )) as Record<string, unknown>;
    expect(r.erro).toBe("item_fora_da_consulta_do_turno");
  });

  it("turno sem registro de itens (follow-up, MCP externo): recusa", async () => {
    const { ctx } = ctxDe(tabelas(), { semItens: true });
    expect((await chamar(ctx)).erro).toBe("item_fora_da_consulta_do_turno");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("consulta que deu erro não registra item nenhum", () => {
    const itens = new ItensDaReceitaNoTurno();
    itens.registrar({ erro: "falha_na_leitura", instancia: { id: INSTANCIA }, linhas: [{ id: 1 }] });
    expect(itens.obter(INSTANCIA, "1")).toBeNull();
  });
});

describe("contato: SEMPRE o da conversa", () => {
  it("o contact_id que o modelo mandar é ignorado", async () => {
    const { ctx } = ctxDe(tabelas());
    await chamar(ctx, "4821", { contact_id: OUTRO_CONTATO, contato: OUTRO_CONTATO });
    expect(deps.criar.mock.calls[0]![0].contact_id).toBe(CONTATO);
    expect(deps.nota.mock.calls[0]![1].contactId).toBe(CONTATO);
  });

  it("sem contato de turno (fora de conversa): recusa", async () => {
    const { ctx } = ctxDe(tabelas(), { semContato: true });
    expect((await chamar(ctx)).erro).toBe("fora_de_conversa");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("contato bloqueado (opt-out), anonimizado ou pessoal: não vira lead nem aviso", async () => {
    for (const marca of [{ is_blocked: true }, { is_anonymized: true }, { is_personal: true }]) {
      vi.clearAllMocks();
      const { ctx, banco } = ctxDe(
        tabelas({
          contacts: [
            { id: CONTATO, organization_id: ORG, is_blocked: false, is_anonymized: false, is_personal: false, ...marca },
          ],
        }),
      );
      const r = await chamar(ctx);
      expect(r.erro, JSON.stringify(marca)).toBe("contato_bloqueado");
      expect(deps.criar).not.toHaveBeenCalled();
      expect(banco.inseridos.agent_inbox_items).toBeUndefined();
    }
  });
});

describe("organização: SEMPRE a do turno", () => {
  it("funil e etapa de OUTRA organização na instância: recusado na execução, vira aviso e nenhum lead", async () => {
    const { ctx, banco } = ctxDe(
      tabelas({
        external_db_connections: conexoesCom([instancia({ destino: { pipeline_id: FUNIL_B, stage_id: ETAPA_B } })]),
        crm_pipelines: [{ id: FUNIL_B, organization_id: OUTRA_ORG, is_archived: false }],
        crm_stages: [
          { id: ETAPA_B, organization_id: OUTRA_ORG, pipeline_id: FUNIL_B, is_archived: false, is_won: false, is_lost: false },
        ],
      }),
    );
    const r = await chamar(ctx);
    expect(r.resultado).toBe("aviso_na_central");
    expect(deps.criar).not.toHaveBeenCalled();
    expect(String(banco.inseridos.agent_inbox_items![0]!.body)).toContain("não está mais disponível");
  });

  it("etapa que é de outro funil: recusada", async () => {
    const { ctx } = ctxDe(
      tabelas({
        crm_stages: [
          { id: ETAPA, organization_id: ORG, pipeline_id: FUNIL_B, is_archived: false, is_won: false, is_lost: false },
        ],
      }),
    );
    expect((await chamar(ctx)).resultado).toBe("aviso_na_central");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("etapa de ganho ou perda não recebe lead novo", async () => {
    const { ctx } = ctxDe(
      tabelas({
        crm_stages: [
          { id: ETAPA, organization_id: ORG, pipeline_id: FUNIL, is_archived: false, is_won: true, is_lost: false },
        ],
      }),
    );
    expect((await chamar(ctx)).resultado).toBe("aviso_na_central");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("instância de OUTRA organização: não encontrada", async () => {
    const { ctx } = ctxDe(tabelas({ external_db_connections: conexoesCom([instancia()], OUTRA_ORG) }));
    expect((await chamar(ctx)).erro).toBe("nao_encontrada");
    expect(deps.criar).not.toHaveBeenCalled();
  });

  it("contato de outra organização (id adulterado no turno): recusado", async () => {
    const { ctx } = ctxDe(
      tabelas({ contacts: [{ id: CONTATO, organization_id: OUTRA_ORG, is_blocked: false, is_anonymized: false }] }),
    );
    expect((await chamar(ctx)).erro).toBe("contato_bloqueado");
    expect(deps.criar).not.toHaveBeenCalled();
  });
});

describe("régua da etapa e teto", () => {
  it("etapa que exige campos que o cliente não deu: aviso, sem lead", async () => {
    deps.criar.mockRejectedValue(new ApiError(422, "required_fields_missing", undefined, "req-1", "x"));
    const { ctx, banco } = ctxDe(tabelas());
    const r = await chamar(ctx);
    expect(r.resultado).toBe("aviso_na_central");
    expect(String(banco.inseridos.agent_inbox_items![0]!.body)).toContain("exige campos");
  });

  it("o teto por turno barra o 4º item distinto, e repetir um já tratado não gasta teto", async () => {
    const { ctx } = ctxDe(tabelas());
    expect((await chamar(ctx, "4821")).resultado).toBe("lead_criado");
    expect((await chamar(ctx, "4822")).resultado).toBe("lead_criado");
    expect((await chamar(ctx, "48")).resultado).toBe("lead_criado");
    expect((await chamar(ctx, "4821")).resultado).toBe("lead_criado");
    expect((await chamar(ctx, "7")).erro).toBe("teto_de_interesses_do_turno");
    expect(deps.criar).toHaveBeenCalledTimes(3);
  });
});
