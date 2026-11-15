// lib/propostas/documento/documento-da-proposta.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolverModelo = vi.hoisted(() => vi.fn());
vi.mock("../modelos/resolver", () => ({ resolverModelo }));

import { MODELOS_BASE } from "../modelos/catalogo-base";
import { lerSecoesEditadas, montarDocumentoDaProposta, type PropostaParaDocumento } from "./documento-da-proposta";

const ORG = "22222222-2222-4222-8222-222222222222";
const db = {} as never;

/**
 * Um `db` de mentira só para a leitura do NEGÓCIO (#4533): as quatro consultas
 * da renderização usam a MESMA cadeia (`select → eq → eq → maybeSingle`), então
 * a tabela decide a resposta. `rpc` é o nome do responsável (`fn_nomes_dos_membros`).
 */
function dbComNegocio(opcoes: {
  lead?: unknown;
  settings?: unknown;
  etapa?: string | null;
  membro?: { full_name: string | null; whatsapp_e164?: string | null } | null;
  falharNoLead?: boolean;
}) {
  return {
    from: (tabela: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (tabela === "crm_leads") {
                if (opcoes.falharNoLead) return { data: null, error: { message: "indisponível" } };
                return { data: opcoes.lead ?? null, error: null };
              }
              if (tabela === "crm_pipelines") return { data: { settings: opcoes.settings ?? null }, error: null };
              if (tabela === "crm_stages") return { data: opcoes.etapa ? { name: opcoes.etapa } : null, error: null };
              if (tabela === "user_organizations") {
                return { data: opcoes.membro ? { whatsapp_e164: opcoes.membro.whatsapp_e164 ?? null } : null, error: null };
              }
              return { data: null, error: null };
            },
          }),
        }),
      }),
    }),
    rpc: async () => ({
      data: opcoes.membro ? [{ user_id: LEAD_BASE.owner_user_id, full_name: opcoes.membro.full_name }] : [],
      error: null,
    }),
  } as never;
}

const LEAD_BASE = {
  title: "Aluguel — apartamento no Centro",
  stage_id: "etapa-1",
  owner_user_id: "usuario-1",
  pipeline_id: "funil-1",
  currency: "BRL",
  custom_fields: {
    endereco_do_imovel: "Rua X, 10",
    bairro: null,
  },
};

const FUNIL_BASE = {
  fields: [
    { key: "endereco_do_imovel", label: "Endereço do imóvel", type: "text" },
    { key: "bairro", label: "Bairro", type: "text" },
  ],
};

/** Modelo mínimo que usa as duas variáveis do negócio (uma preenchida, outra não). */
const MODELO_COM_NEGOCIO = {
  slug: "com_negocio",
  version: 1,
  origem: "organizacao" as const,
  sections: [
    {
      id: "resumo",
      title: "Resumo",
      titleEs: null,
      body: "Imóvel: {{lead.endereco_do_imovel}} — bairro: {{lead.bairro}} — corretor: {{lead.responsavel_nome}}",
      bodyEs: null,
      required: true,
      conditional: false,
    },
  ],
  sectionOrder: ["resumo"],
};

function proposta(over: Partial<PropostaParaDocumento> = {}): PropostaParaDocumento {
  return {
    template_slug: "site_institucional",
    secoes_editadas: null,
    briefing_json: null,
    total_cents: 350000,
    moeda: "BRL",
    prazo_dias_uteis: null,
    valid_until: "2026-10-16",
    created_at: "2026-09-26T00:00:00.000Z",
    ...over,
  };
}

const BRIEFING_COMPLETO = {
  client: { company: "Imobiliária Exemplo" },
  project: { name: "Site da imobiliária", objective: "gerar contatos de compradores" },
  scope: { pages_list: "Home, Sobre, Contato" },
  included: { list: "Layout, desenvolvimento e publicação" },
  excluded: { list: "Hospedagem e domínio" },
};

beforeEach(() => {
  resolverModelo.mockReset();
  resolverModelo.mockImplementation(async (_db: unknown, _org: string, slug: string) =>
    Object.hasOwn(MODELOS_BASE, slug) ? { ...MODELOS_BASE[slug]!, origem: "base" } : null,
  );
});

describe("montarDocumentoDaProposta", () => {
  it("sem modelo confirmado devolve null e nem consulta o modelo", async () => {
    expect(await montarDocumentoDaProposta(db, ORG, proposta({ template_slug: null }), null)).toBeNull();
    expect(resolverModelo).not.toHaveBeenCalled();
  });

  it("modelo que não resolve devolve null", async () => {
    expect(await montarDocumentoDaProposta(db, ORG, proposta({ template_slug: "nao_existe" }), null)).toBeNull();
  });

  it("MODELO REAL com briefing e prazo preenchidos: zero pendência (o bloqueio de §1.5 da spec)", async () => {
    const doc = await montarDocumentoDaProposta(
      db,
      ORG,
      proposta({ briefing_json: BRIEFING_COMPLETO, prazo_dias_uteis: 30 }),
      { name: "Maria", display_name: null },
    );
    expect(doc?.pendencias).toEqual([]);
    expect(doc?.camposFaltando).toEqual([]);
  });

  it("sem prazo, a pendência aponta para o campo de prazo, com nome legível", async () => {
    const doc = await montarDocumentoDaProposta(db, ORG, proposta({ briefing_json: BRIEFING_COMPLETO }), {
      name: "Maria",
      display_name: null,
    });
    expect(doc?.camposFaltando).toEqual([
      { caminho: "schedule.estimated_days", rotulo: "Prazo (dias úteis)", onde: "campo_prazo", secoes: ["schedule"] },
    ]);
  });

  it("variável usada em várias seções aparece UMA vez em camposFaltando, com todas as seções", async () => {
    // `excluded.list` está em DUAS seções do projeto_personalizado: "limitations" e "excluded".
    const doc = await montarDocumentoDaProposta(
      db,
      ORG,
      proposta({ template_slug: "projeto_personalizado", prazo_dias_uteis: 30 }),
      { name: "Maria", display_name: null },
    );
    const excluidos = doc?.camposFaltando.filter((c) => c.caminho === "excluded.list") ?? [];
    expect(excluidos).toHaveLength(1);
    expect(excluidos[0]!.secoes).toEqual(["limitations", "excluded"]);
    expect(doc?.pendencias.filter((p) => p === "excluded.list")).toHaveLength(2);
  });

  it("seção reescrita não gera pendência, fica marcada como editada e mantém o texto", async () => {
    const doc = await montarDocumentoDaProposta(
      db,
      ORG,
      proposta({ briefing_json: BRIEFING_COMPLETO, prazo_dias_uteis: 30, secoes_editadas: { summary: "Texto final." } }),
      { name: "Maria", display_name: null },
    );
    const resumo = doc?.secoes.find((s) => s.id === "summary");
    expect(resumo).toMatchObject({ body: "Texto final.", faltantes: [], editada: true });
    expect(doc?.secoes.find((s) => s.id === "objectives")?.editada).toBe(false);
  });

  it("lê o NEGÓCIO e renderiza {{lead.<chave>}}; o campo vazio vira pendência com o rótulo do funil", async () => {
    resolverModelo.mockImplementationOnce(async () => MODELO_COM_NEGOCIO);
    const doc = await montarDocumentoDaProposta(
      dbComNegocio({
        lead: LEAD_BASE,
        settings: FUNIL_BASE,
        etapa: "Proposta enviada",
        membro: { full_name: "Ana Souza", whatsapp_e164: "+5511999998888" },
      }),
      ORG,
      proposta({ lead_id: "lead-1" }),
      null,
    );

    const corpo = doc?.secoes[0]?.body ?? "";
    expect(corpo).toContain("Imóvel: Rua X, 10");
    expect(corpo).toContain("corretor: Ana Souza");
    // Campo vazio NUNCA vira string vazia: a regra de sempre, agora no card.
    expect(corpo).toContain("bairro: [a definir]");
    expect(doc?.camposFaltando).toEqual([
      { caminho: "lead.bairro", rotulo: "Bairro", onde: "negocio", secoes: ["resumo"] },
    ]);
  });

  it("REGRESSÃO: lead_id nulo devolve o documento de hoje — nenhuma leitura de card, nenhuma pendência nova", async () => {
    const semLeadId = await montarDocumentoDaProposta(
      db,
      ORG,
      proposta({ briefing_json: BRIEFING_COMPLETO, prazo_dias_uteis: 30 }),
      { name: "Maria", display_name: null },
    );
    expect(semLeadId?.pendencias).toEqual([]);
    expect(semLeadId?.camposFaltando).toEqual([]);
  });

  it("leitura do card que FALHA não derruba a renderização: documento idêntico ao de antes", async () => {
    resolverModelo.mockImplementationOnce(async () => MODELO_COM_NEGOCIO);
    resolverModelo.mockImplementationOnce(async () => MODELO_COM_NEGOCIO);
    const referencia = await montarDocumentoDaProposta(db, ORG, proposta({ lead_id: null }), null);
    const comFalha = await montarDocumentoDaProposta(
      dbComNegocio({ falharNoLead: true }),
      ORG,
      proposta({ lead_id: "lead-1" }),
      null,
    );
    expect(comFalha).toEqual(referencia);
    // Sem `lead` no contexto, as duas variáveis do negócio são [a definir].
    expect(comFalha?.secoes[0]?.body).toContain("Imóvel: [a definir]");
  });
});

describe("lerSecoesEditadas", () => {
  it("ignora lixo de clone antigo, nunca lança", () => {
    expect(lerSecoesEditadas(null)).toEqual({});
    expect(lerSecoesEditadas(["a"])).toEqual({});
    expect(lerSecoesEditadas("texto")).toEqual({});
    expect(lerSecoesEditadas({ a: "ok", b: 3, c: null })).toEqual({ a: "ok" });
  });
});
