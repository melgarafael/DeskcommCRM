/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { crmDraftProposal, crmPrepararProposta } from "./propostas";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { avisarQuePropostaPrecisaDeRevisao } from "@/lib/propostas/aviso-de-revisao";
import { audit } from "@/lib/audit";
import type { McpContext } from "../types";

vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/propostas/aviso-de-revisao", () => ({ avisarQuePropostaPrecisaDeRevisao: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

interface MensagemMock {
  organization_id?: string;
  conversation_id?: string;
  direction: string;
  sent_via?: string;
  body: string | null;
  media_derived_text?: string | null;
  created_at: string;
}

interface MundoOpts {
  leadDeOutraOrg?: boolean;
  /** Preço que o mock de catalog_products devolve; null = produto não resolve. Default: 5000. */
  precoDoCatalogo?: number | null;
  /** Quando true, a pré-checagem de rascunho encontra um rascunho aberto. */
  rascunhoJaExiste?: boolean;
  defaultValidDays?: number;
  defaultConditions?: string | null;
  /** Quando true, a conversa informada não pertence ao contato do lead (ou é de outra org). */
  conversaNaoPertenceAoContato?: boolean;
  /** Força o INSERT de crm_proposal_items a falhar (revisão C3, I2). */
  itensFalham?: boolean;
  /** O INSERT de crm_proposals colide com o índice único de rascunho (corrida, revisão C3, I4). */
  insercaoColide23505?: boolean;
  /** Fuso lido de organizations.timezone (D8). Default: null (= cai no padrão). */
  fusoDaOrganizacao?: string | null;
  /** Moeda lida de organizations.currency (D11). Default: "BRL". */
  moedaDaOrganizacao?: string;
  /** Moeda que o mock de catalog_products devolve (D11). Default: "BRL". */
  moedaDoCatalogo?: string;
  /** Mapa codigo → id que o mock de catalog_products devolve no `.in("codigo")`. */
  produtosPorCodigo?: Record<string, string>;
  /** Slugs desligados em settings.proposals.modelos_ocultos (C3). */
  modelosOcultos?: string[];
  /** Linhas da tabela messages; default: turno com confirmação válida. */
  mensagens?: MensagemMock[];
}

const RASCUNHO_ID = "99999999-9999-4999-8999-999999999999";

/** A frase com que o cliente confirma o resumo no turno padrão do mock. */
const FRASE_PADRAO = "Certo, pode mandar o resumo";

/** Briefing que passa na trava: núcleo completo + confirmação do turno. */
function briefingCompleto() {
  return {
    project: { name: "Site da Imobiliária Rio" },
    client: { company: "Imobiliária Rio" },
    nucleo: {
      objetivo: "Vender mais pelo site",
      entregas: "Site com catálogo e contato",
      o_que_o_cliente_tem: "Domínio e logo",
      responsabilidades: "Cliente manda fotos, empresa monta",
      prazo: "Até o fim do mês",
      decisao_e_orcamento: "O dono decide, faixa de 5 mil",
      referencia: "Gosta do site da Perfil",
    },
    confirmacao: { frase_do_cliente: FRASE_PADRAO },
  };
}

function montarMundoDeFerramenta(opts?: MundoOpts) {
  const leadId = "11111111-1111-4111-8111-111111111111";
  const organizationId = "22222222-2222-4222-8222-222222222222";
  const agentId = "agent-1";
  const conversationId = "55555555-5555-4555-8555-555555555555";
  const productId = "66666666-6666-4666-8666-666666666666";

  let propostaCriada: Record<string, unknown> | null = null;
  const propostasExcluidas: string[] = [];

  const settings = {
    proposals: {
      enabled: true,
      default_valid_days: opts?.defaultValidDays ?? 15,
      default_conditions: opts?.defaultConditions ?? null,
      modelos_ocultos: opts?.modelosOcultos ?? [],
    },
  };

  const supabase: any = {
    from: vi.fn(function (this: any, table: string) {
      // Doc 79: a capacidade da empresa só vale com o módulo da INSTALAÇÃO ligado.
      if (table === "platform_config") {
        return { select: () => ({ in: async () => ({ data: [{ chave: "MODULO_PROPOSTAS", valor: "ligado" }], error: null }) }) };
      }
      if (table === "organizations") {
        const resposta = { data: { settings, timezone: opts?.fusoDaOrganizacao ?? null, currency: opts?.moedaDaOrganizacao ?? "BRL" }, error: null };
        return {
          select: vi.fn(function (this: any) {
            return this;
          }),
          eq: vi.fn(function (this: any) {
            return this;
          }),
          maybeSingle: vi.fn(async () => resposta),
          single: vi.fn(async () => resposta),
        };
      }
      if (table === "crm_leads") {
        return {
          select: vi.fn(function (this: any) {
            return this;
          }),
          eq: vi.fn(function (this: any) {
            return this;
          }),
          maybeSingle: vi.fn(async () => {
            if (opts?.leadDeOutraOrg) {
              return { data: null, error: null };
            }
            return {
              data: { id: leadId, contact_id: "contact-123" },
              error: null,
            };
          }),
        };
      }
      if (table === "crm_proposals") {
        const chain: any = {
          insert: vi.fn((data: unknown) => {
            propostaCriada = data as Record<string, unknown>;
            return {
              select: () => ({
                single: async () =>
                  opts?.insercaoColide23505
                    ? { data: null, error: { code: "23505", message: "colisao" } }
                    : { data: { id: "proposal-1" }, error: null },
              }),
            };
          }),
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          maybeSingle: vi.fn(async () =>
            opts?.rascunhoJaExiste
              ? { data: { id: RASCUNHO_ID }, error: null }
              : { data: null, error: null },
          ),
          single: vi.fn(async () => ({ data: { id: "proposal-1" }, error: null })),
          delete: vi.fn(() => ({
            eq: () => ({
              eq: async (_campo: string, id: string) => {
                propostasExcluidas.push(id);
                return { error: null };
              },
            }),
          })),
        };
        return chain;
      }
      if (table === "catalog_products") {
        const porCodigo: Record<string, string> = opts?.produtosPorCodigo ?? { "SITE-BASICO": productId };
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => {
                    const preco = opts?.precoDoCatalogo === undefined ? 5000 : opts.precoDoCatalogo;
                    return preco === null
                      ? { data: null, error: null }
                      : { data: { preco_cents: preco, moeda: opts?.moedaDoCatalogo ?? "BRL" }, error: null };
                  },
                }),
              }),
              in: async (_coluna: string, codigos: string[]) => ({
                data: codigos.filter((c) => porCodigo[c]).map((c) => ({ id: porCodigo[c], codigo: c })),
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "conversations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () =>
                    opts?.conversaNaoPertenceAoContato
                      ? { data: null, error: null }
                      : { data: { id: conversationId }, error: null },
                }),
              }),
            }),
          }),
        };
      }
      if (table === "crm_proposal_items") {
        return {
          insert: vi.fn(async function (this: any) {
            return opts?.itensFalham ? { error: { message: "boom" } } : { error: null };
          }),
        };
      }
      if (table === "crm_lead_activities") {
        return {
          insert: vi.fn(async function (this: any) {
            return { error: null };
          }),
        };
      }
      if (table === "messages") {
        // A trava do briefing lê o turno atual: qualifica pelos `.eq` que o
        // handler manda — linha de outra organização ou conversa nunca conta.
        const filtros: Record<string, unknown> = {};
        const cadeia: any = {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            filtros[coluna] = valor;
            return cadeia;
          },
          order: () => cadeia,
          then: (resolve: any) => {
            const base: MensagemMock[] = opts?.mensagens ?? [
              {
                organization_id: organizationId,
                conversation_id: conversationId,
                direction: "outbound",
                sent_via: "ai",
                body: "Qual o prazo ideal?",
                media_derived_text: null,
                created_at: "2026-09-27T10:00:00.000Z",
              },
              {
                organization_id: organizationId,
                conversation_id: conversationId,
                direction: "inbound",
                sent_via: "external_device",
                body: FRASE_PADRAO,
                media_derived_text: null,
                created_at: "2026-09-27T10:01:00.000Z",
              },
            ];
            const linhas = base.filter((m) =>
              Object.entries(filtros).every(([col, val]) => m[col as keyof MensagemMock] === val),
            );
            return Promise.resolve({ data: linhas, error: null }).then(resolve);
          },
        };
        return cadeia;
      }
      if (table === "proposal_templates") {
        const cadeia: any = {
          select: () => cadeia,
          eq: () => cadeia,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return cadeia;
      }
      throw new Error(`tabela não mockada neste teste: ${table}`);
    }),
  };

  const ctx: McpContext = {
    organizationId,
    role: "agent",
    actor: {
      type: "ai_agent",
      id: "run-1",
      role: "agent",
      agent_id: agentId,
    },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    supabase,
  };

  return {
    leadId, organizationId, agentId, conversationId, productId, ctx,
    get propostaCriada() {
      return propostaCriada;
    },
    get propostasExcluidas() {
      return propostasExcluidas;
    },
    get atividadesEmitidas() {
      return vi.mocked(emitLeadActivity).mock.calls.map((c) => c[1]);
    },
    get auditoriasEmitidas() {
      return vi.mocked(audit).mock.calls.map((c) => c[0]);
    },
  };
}

describe("crm_draft_proposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cria rascunho com drafted_by_agent_id preenchido, a partir do lead_id recebido", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        titulo: "Orçamento site",
        conversation_id: mundo.conversationId,
        itens: [{ descricao: "Site", quantidade: 1, preco_unitario_cents: 500000 }],
        briefing: briefingCompleto(),
      },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect((r as { proposal_id?: string }).proposal_id).toBeDefined();
  });

  it.each([
    ["2026-06-16T23:30:00Z", "2026-07-02"],
    ["2026-03-14T23:30:00Z", "2026-03-29"],
    ["2026-10-11T00:30:00+01:00", "2026-10-26"],
  ])("valid_until omitido: soma 15 dias no calendário da organização a partir de %s (D8)", async (iso, esperado) => {
    // A ferramenta usa a mesma data da rota, inclusive quando os 15 dias
    // atravessam a entrada ou a saída do horário de verão.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(iso));
      const mundo = montarMundoDeFerramenta({ fusoDaOrganizacao: "Europe/Lisbon" });
      const r = await crmDraftProposal.handler(
        {
          lead_id: mundo.leadId,
          titulo: "x",
          conversation_id: mundo.conversationId,
          itens: [{ descricao: "Site", quantidade: 1, preco_unitario_cents: 500000 }],
          briefing: briefingCompleto(),
        },
        mundo.ctx,
      );
      expect((r as { error?: string }).error).toBeUndefined();
      expect(mundo.propostaCriada?.valid_until).toBe(esperado);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lead_id de outra organização (ou inexistente): erro devolvido ao modelo, NUNCA exceção", async () => {
    const mundo = montarMundoDeFerramenta({ leadDeOutraOrg: true });
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        titulo: "x",
        conversation_id: mundo.conversationId,
        itens: [{ descricao: "item", quantidade: 1, preco_unitario_cents: 100 }],
      },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeDefined();
  });

  it("item com product_id: preço vem do catálogo, ignora o preço mandado pela IA (D5)", async () => {
    const mundo = montarMundoDeFerramenta({ precoDoCatalogo: 5000 });
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId, titulo: "Com catálogo", conversation_id: mundo.conversationId,
        itens: [{ product_id: mundo.productId, descricao: "Ignorado", quantidade: 1, preco_unitario_cents: 999999 }],
        briefing: briefingCompleto(),
      },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(mundo.propostaCriada?.total_cents).toBe(5000);
    expect(mundo.propostaCriada?.pricing_status).toBe("catalog");
  });

  it("item sem product_id e sem preco_unitario_cents: cria como 'a definir' (missing)", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "A definir", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(mundo.propostaCriada?.pricing_status).toBe("missing");
  });

  it("negócio já tem rascunho aberto: devolve o id do rascunho existente, não cria outro (§5.3)", async () => {
    const mundo = montarMundoDeFerramenta({ rascunhoJaExiste: true });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "Duplicado", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }] },
      mundo.ctx,
    );
    const res = r as { error?: string; motivo?: string; rascunho_id?: string };
    expect(res.error).toBeDefined();
    expect(res.motivo).toBe("rascunho_aberto_existe");
    expect(res.rascunho_id).toBeDefined();
    expect(mundo.propostaCriada).toBeNull();
  });

  it("grava conversation_id, valid_until (default da org) e condicoes (default da org) — D7 + D5", async () => {
    const mundo = montarMundoDeFerramenta({ defaultValidDays: 10, defaultConditions: "Pagamento à vista." });
    await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect(mundo.propostaCriada?.conversation_id).toBe(mundo.conversationId);
    expect(mundo.propostaCriada?.condicoes).toBe("Pagamento à vista.");
    expect(mundo.propostaCriada?.valid_until).toBeDefined();
  });

  it("emite atividade na timeline E auditoria ao criar o rascunho (D5 — hoje não emite nada)", async () => {
    const mundo = montarMundoDeFerramenta();
    await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect(mundo.atividadesEmitidas.length).toBe(1);
    expect(mundo.atividadesEmitidas[0]?.type).toBe("proposal_drafted");
    expect(mundo.auditoriasEmitidas.length).toBe(1);
    expect(mundo.auditoriasEmitidas[0]?.action).toBe("proposal.drafted");
  });

  it("conversation_id que NÃO pertence ao contato do lead (ou é de outra organização): recusado, nada é gravado (revisão C3)", async () => {
    const mundo = montarMundoDeFerramenta({ conversaNaoPertenceAoContato: true });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }] },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeDefined();
    expect(mundo.propostaCriada).toBeNull();
  });

  it("corrida: pré-checagem não pega, mas o índice único (23505) do INSERT devolve erro ensinável, não exceção (revisão C3, I4)", async () => {
    const mundo = montarMundoDeFerramenta({ insercaoColide23505: true });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    const res = r as { error?: string; motivo?: string };
    expect(res.error).toBeDefined();
    expect(res.motivo).toBe("rascunho_aberto_existe");
  });

  it("falha ao gravar os itens: a proposta recém-criada é APAGADA, não fica rascunho vazio travando o negócio (revisão C3, I2)", async () => {
    const mundo = montarMundoDeFerramenta({ itensFalham: true });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeDefined();
    expect(mundo.propostasExcluidas).toEqual(["proposal-1"]);
  });

  it("grava a MOEDA DA ORGANIZAÇÃO na proposta, não sempre BRL (D11)", async () => {
    const mundo = montarMundoDeFerramenta({ moedaDaOrganizacao: "USD" });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ descricao: "x", quantidade: 1, preco_unitario_cents: 100 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(mundo.propostaCriada?.moeda).toBe("USD");
  });

  it("item de catálogo em moeda diferente da organização: erro devolvido ao modelo, nada é gravado (D11)", async () => {
    const mundo = montarMundoDeFerramenta({ moedaDaOrganizacao: "BRL", moedaDoCatalogo: "USD", precoDoCatalogo: 5000 });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ product_id: mundo.productId, descricao: "x", quantidade: 1 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toContain("moeda");
    expect(mundo.propostaCriada).toBeNull();
  });

  it("product_id que não existe na organização: erro devolvido ao modelo, nada é gravado", async () => {
    const mundo = montarMundoDeFerramenta({ precoDoCatalogo: null });
    const r = await crmDraftProposal.handler(
      { lead_id: mundo.leadId, titulo: "x", conversation_id: mundo.conversationId, itens: [{ product_id: mundo.productId, descricao: "x", quantidade: 1 }], briefing: briefingCompleto() },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeDefined();
    expect(mundo.propostaCriada).toBeNull();
  });

  it("grava template_slug_sugerido quando a IA sugere um modelo válido", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Orçamento site",
        itens: [{ descricao: "Site institucional", quantidade: 1 }],
        template_slug_sugerido: "site_institucional",
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(mundo.propostaCriada?.template_slug_sugerido).toBe("site_institucional");
  });

  it("recusa template_slug_sugerido que não existe no catálogo", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Orçamento site",
        itens: [{ descricao: "Site institucional", quantidade: 1 }],
        template_slug_sugerido: "modelo_que_nao_existe",
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toEqual(expect.stringContaining("modelo"));
    expect(mundo.propostaCriada).toBeNull();
  });

  it("slug de modelo que não existe: a recusa lista os modelos válidos DESTA organização (P5, D11)", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = (await crmDraftProposal.handler(
      {
        template_slug_sugerido: "imobiliaria",
        lead_id: mundo.leadId,
        titulo: "x",
        conversation_id: mundo.conversationId,
        itens: [{ descricao: "x", quantidade: 1 }],
        briefing: briefingCompleto(),
      },
      mundo.ctx,
    )) as { error?: string; modelos_validos?: Array<{ slug: string; nome: string }> };
    expect(r.error).toMatch(/imobiliaria/);
    expect(r.modelos_validos?.map((m) => m.slug)).toContain("catalogo_imobiliario");
    expect(mundo.propostaCriada).toBeNull();
  });

  it("sugestão de modelo desligado é inválida: a recusa lista só os ativos", async () => {
    const mundo = montarMundoDeFerramenta({ modelosOcultos: ["site_institucional"] });
    const r = (await crmDraftProposal.handler(
      {
        template_slug_sugerido: "site_institucional",
        lead_id: mundo.leadId,
        titulo: "x",
        conversation_id: mundo.conversationId,
        itens: [{ descricao: "x", quantidade: 1 }],
        briefing: briefingCompleto(),
      },
      mundo.ctx,
    )) as { error?: string; modelos_validos?: Array<{ slug: string; nome: string }> };
    expect(r.error).toMatch(/site_institucional/);
    expect(r.modelos_validos?.map((m) => m.slug)).not.toContain("site_institucional");
    expect(r.modelos_validos?.map((m) => m.slug)).toContain("ecommerce");
    expect(mundo.propostaCriada).toBeNull();
  });

  it("abre o aviso de revisão na Central ao criar o rascunho", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Orçamento",
        itens: [{ descricao: "Item", quantidade: 1 }],
        briefing: briefingCompleto(),
      },
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(vi.mocked(avisarQuePropostaPrecisaDeRevisao)).toHaveBeenCalledWith(
      mundo.ctx.supabase,
      mundo.ctx.organizationId,
      expect.any(String),
    );
  });

  it("resolve product_id a partir de produto_codigo quando product_id não foi mandado", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site institucional", quantidade: 1, produto_codigo: "SITE-BASICO" }],
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(r).toMatchObject({ pricing_status: "catalog" }); // preço veio do catálogo, não "a definir"
  });

  it("recusa produto_codigo que não existe na organização, com o código na mensagem", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site institucional", quantidade: 1, produto_codigo: "NAO-EXISTE" }],
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    );
    expect(r).toMatchObject({ error: expect.stringContaining("NAO-EXISTE") });
    expect(mundo.propostaCriada).toBeNull();
  });

  it("product_id explícito vence quando os dois vêm juntos no mesmo item", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site institucional", quantidade: 1, product_id: mundo.productId, produto_codigo: "OUTRO-CODIGO" }],
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    );
    // "OUTRO-CODIGO" não existe no mock — se o handler consultasse por código, recusaria.
    // product_id já resolve, então nem consulta: preço do catálogo, sem erro.
    expect((r as { error?: string }).error).toBeUndefined();
    expect(r).toMatchObject({ pricing_status: "catalog" });
  });

  it("grava o briefing recebido em briefing_json ao criar o rascunho", async () => {
    const mundo = montarMundoDeFerramenta();
    const briefing = briefingCompleto();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site institucional", quantidade: 1 }],
        briefing,
      } as never,
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    expect(mundo.propostaCriada?.briefing_json).toEqual(briefing);
  });

  it("sucesso grava nucleo e confirmacao dentro de briefing_json, sem apagar o resto", async () => {
    const mundo = montarMundoDeFerramenta();
    const briefing = briefingCompleto();
    await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
        briefing,
      } as never,
      mundo.ctx,
    );
    const gravado = mundo.propostaCriada?.briefing_json as Record<string, unknown>;
    expect(gravado.nucleo).toEqual(briefing.nucleo);
    expect(gravado.confirmacao).toEqual({ frase_do_cliente: FRASE_PADRAO });
    expect(gravado.project).toEqual({ name: "Site da Imobiliária Rio" });
    expect(gravado.client).toEqual({ company: "Imobiliária Rio" });
  });

  it("sem briefing: recusa com briefing_incompleto, sem insert (a trava da C5)", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = (await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
      },
      mundo.ctx,
    )) as { error?: string; motivo?: string; faltando?: string[] };
    expect(r.motivo).toBe("briefing_incompleto");
    expect(r.error).toMatch(/Faltam categorias do briefing: .* Pergunte ao cliente antes de rascunhar\./);
    expect(r.faltando).toHaveLength(7);
    expect(mundo.propostaCriada).toBeNull();
  });

  it("núcleo incompleto: a recusa lista os rótulos do que falta", async () => {
    const mundo = montarMundoDeFerramenta();
    const briefing = briefingCompleto();
    const nucleo = { ...briefing.nucleo, prazo: "", referencia: "  " };
    const r = (await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
        briefing: { ...briefing, nucleo },
      } as never,
      mundo.ctx,
    )) as { error?: string; motivo?: string; faltando?: string[] };
    expect(r.motivo).toBe("briefing_incompleto");
    expect(r.faltando).toEqual(["prazo", "referencia"]);
    expect(r.error).toContain("Prazo");
    expect(r.error).toContain("Referência");
    expect(mundo.propostaCriada).toBeNull();
  });

  it("sem confirmacao: recusa com sem_confirmacao, sem insert", async () => {
    const mundo = montarMundoDeFerramenta();
    const semConfirmacao = { ...briefingCompleto(), confirmacao: undefined };
    const r = (await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
        briefing: semConfirmacao,
      } as never,
      mundo.ctx,
    )) as { error?: string; motivo?: string };
    expect(r.motivo).toBe("sem_confirmacao");
    expect(r.error).toBeDefined();
    expect(mundo.propostaCriada).toBeNull();
  });

  it("frase que só aparece numa mensagem ANTIGA (antes da última resposta da IA): confirmacao_nao_encontrada", async () => {
    const mundo = montarMundoDeFerramenta({
      mensagens: [
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "inbound",
          sent_via: "external_device",
          body: FRASE_PADRAO,
          media_derived_text: null,
          created_at: "2026-09-27T09:00:00.000Z",
        },
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "outbound",
          sent_via: "ai",
          body: "Anotado! E o prazo?",
          media_derived_text: null,
          created_at: "2026-09-27T09:30:00.000Z",
        },
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "inbound",
          sent_via: "external_device",
          body: "Preciso para o mês que vem",
          media_derived_text: null,
          created_at: "2026-09-27T09:31:00.000Z",
        },
      ],
    });
    const r = (await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    )) as { error?: string; motivo?: string };
    expect(r.motivo).toBe("confirmacao_nao_encontrada");
    expect(r.error).toContain(FRASE_PADRAO);
    expect(r.error).toMatch(/não repita a ferramenta com a mesma frase/);
    expect(mundo.propostaCriada).toBeNull();
  });

  it("áudio sem transcrição no lote: transcricao_pendente", async () => {
    const mundo = montarMundoDeFerramenta({
      mensagens: [
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "outbound",
          sent_via: "ai",
          body: "Pode confirmar o resumo?",
          media_derived_text: null,
          created_at: "2026-09-27T10:00:00.000Z",
        },
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "inbound",
          sent_via: "external_device",
          body: null,
          media_derived_text: null,
          created_at: "2026-09-27T10:01:00.000Z",
        },
      ],
    });
    const r = (await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    )) as { error?: string; motivo?: string };
    expect(r.motivo).toBe("transcricao_pendente");
    expect(r.error).toMatch(/ainda está sendo transcrita/);
    expect(mundo.propostaCriada).toBeNull();
  });

  it("isolamento: mensagem de outra organização com a frase não conta como confirmação", async () => {
    const mundo = montarMundoDeFerramenta({
      mensagens: [
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "outbound",
          sent_via: "ai",
          body: "Pode confirmar o resumo?",
          media_derived_text: null,
          created_at: "2026-09-27T10:00:00.000Z",
        },
        {
          organization_id: "22222222-2222-4222-8222-222222222222",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "inbound",
          sent_via: "external_device",
          body: "Só olhando preços",
          media_derived_text: null,
          created_at: "2026-09-27T10:01:00.000Z",
        },
        {
          organization_id: "99999999-9999-4999-8999-999999999999",
          conversation_id: "55555555-5555-4555-8555-555555555555",
          direction: "inbound",
          sent_via: "external_device",
          body: FRASE_PADRAO,
          media_derived_text: null,
          created_at: "2026-09-27T10:02:00.000Z",
        },
      ],
    });
    const r = (await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1 }],
        briefing: briefingCompleto(),
      } as never,
      mundo.ctx,
    )) as { error?: string; motivo?: string };
    // Se a linha da outra organização contasse, a frase casaria e o rascunho nasceria.
    expect(r.motivo).toBe("confirmacao_nao_encontrada");
    expect(mundo.propostaCriada).toBeNull();
  });
});

/**
 * O PRAZO QUE O CLIENTE FALOU CHEGA AO CAMPO "Prazo (dias úteis)".
 *
 * O editor abria vazio mesmo com a IA tendo perguntado o prazo e ouvido a
 * resposta: `briefing.nucleo.prazo` é o que a conversa sabe, e nada o levava
 * até a coluna. A régua é estreita de propósito — número por extenso, na
 * faixa que o schema aceita, e NADA quando a frase não traz número. Campo de
 * prazo inventado aparece no documento assinado.
 */
describe("crm_draft_proposal — prazo do briefing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function rascunhoComPrazo(prazo: string) {
    const briefing = briefingCompleto();
    const mundo = montarMundoDeFerramenta();
    const r = await crmDraftProposal.handler(
      {
        lead_id: mundo.leadId,
        conversation_id: mundo.conversationId,
        titulo: "Proposta",
        itens: [{ descricao: "Site", quantidade: 1, preco_unitario_cents: 500000 }],
        briefing: { ...briefing, nucleo: { ...briefing.nucleo, prazo } },
      } as never,
      mundo.ctx,
    );
    expect((r as { error?: string }).error).toBeUndefined();
    return mundo.propostaCriada;
  }

  it("\"até 30 dias\" grava prazo_dias_uteis: 30", async () => {
    const criada = await rascunhoComPrazo("até 30 dias");
    expect(criada?.prazo_dias_uteis).toBe(30);
  });

  it("\"15 dias úteis\" também conta — o número é o que vale, não o resto da frase", async () => {
    const criada = await rascunhoComPrazo("Prazo de 15 dias úteis, com entrega em duas etapas");
    expect(criada?.prazo_dias_uteis).toBe(15);
  });

  it("\"quando der\" grava NULO: sem número no texto, não há prazo a inventar", async () => {
    const criada = await rascunhoComPrazo("quando der");
    expect(criada?.prazo_dias_uteis).toBeNull();
  });

  it("as respostas da trava do briefing também ficam nulas (\"cliente_nao_sabe\")", async () => {
    const criada = await rascunhoComPrazo("cliente_nao_sabe");
    expect(criada?.prazo_dias_uteis).toBeNull();
  });

  it("faixa (\"2-3 dias\") fica nula: escolher um dos dois seria chutar campo que vai para o documento", async () => {
    const criada = await rascunhoComPrazo("2-3 dias");
    expect(criada?.prazo_dias_uteis).toBeNull();
  });

  it("fora da faixa do schema (0 e 400 dias) fica nulo, e não grava o que a edição recusaria", async () => {
    expect((await rascunhoComPrazo("0 dias"))?.prazo_dias_uteis).toBeNull();
    expect((await rascunhoComPrazo("400 dias"))?.prazo_dias_uteis).toBeNull();
  });
});

describe("crm_preparar_proposta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("devolve modelos, categorias e instrucao", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = (await crmPrepararProposta.handler({}, mundo.ctx)) as {
      modelos?: Array<{ slug: string; nome: string; origem: string }>;
      categorias?: Array<{ chave: string; rotulo: string; orientacao: string }>;
      instrucao?: string;
    };
    expect(r.modelos).toHaveLength(8);
    expect(r.modelos?.[0]).toEqual({ slug: "site_institucional", nome: "Site institucional", origem: "plataforma" });
    expect(r.categorias?.map((c) => c.chave)).toEqual([
      "objetivo",
      "entregas",
      "o_que_o_cliente_tem",
      "responsabilidades",
      "prazo",
      "decisao_e_orcamento",
      "referencia",
    ]);
    for (const categoria of r.categorias ?? []) {
      expect(categoria.rotulo.trim()).not.toBe("");
      expect(categoria.orientacao.trim()).not.toBe("");
    }
    expect(r.instrucao).toMatch(/Pergunte ao cliente/);
    expect(r.instrucao).toMatch(/não se aplica/);
  });

  it("devolve só modelos ativos — o desligado some", async () => {
    const mundo = montarMundoDeFerramenta({ modelosOcultos: ["site_institucional"] });
    const r = (await crmPrepararProposta.handler({}, mundo.ctx)) as {
      modelos?: Array<{ slug: string }>;
    };
    expect(r.modelos?.map((m) => m.slug)).not.toContain("site_institucional");
    expect(r.modelos).toHaveLength(7);
  });

  it("com template_slug válido e ativo devolve campos_do_modelo legíveis, sem os calculados", async () => {
    const mundo = montarMundoDeFerramenta();
    const r = (await crmPrepararProposta.handler({ template_slug: "site_institucional" }, mundo.ctx)) as {
      campos_do_modelo?: string[];
    };
    expect(r.campos_do_modelo).toContain("Lista de páginas");
    expect(r.campos_do_modelo).toContain("Objetivo do projeto");
    for (const calculado of ["Investimento total", "Validade da proposta (dias)", "Data da aprovação", "Nome do cliente", "Empresa ou nome do cliente"]) {
      expect(r.campos_do_modelo).not.toContain(calculado);
    }
    expect(new Set(r.campos_do_modelo).size).toBe(r.campos_do_modelo?.length);
  });

  it("com template_slug desligado ou inexistente: recusa com os válidos", async () => {
    const mundo = montarMundoDeFerramenta({ modelosOcultos: ["automacao"] });
    for (const slug of ["automacao", "modelo_que_nao_existe"]) {
      const r = (await crmPrepararProposta.handler({ template_slug: slug }, mundo.ctx)) as {
        error?: string;
        modelos_validos?: Array<{ slug: string }>;
      };
      expect(r.error).toMatch(new RegExp(slug));
      expect(r.modelos_validos?.map((m) => m.slug)).not.toContain("automacao");
      expect(r.modelos_validos?.map((m) => m.slug)).toContain("site_institucional");
    }
  });

  it("capacidade desligada recusa sem ler modelo nenhum", async () => {
    const supabase: any = {
      from: (tabela: string) => {
        if (tabela === "organizations") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: { proposals: { enabled: false } } }, error: null }) }) }),
          };
        }
        throw new Error(`não devia ler ${tabela} com a capacidade desligada`);
      },
    };
    const mundo = montarMundoDeFerramenta();
    const r = await crmPrepararProposta.handler({}, { ...mundo.ctx, supabase });
    expect(r).toEqual({ error: "Propostas estão desligadas nesta organização." });
  });
});
