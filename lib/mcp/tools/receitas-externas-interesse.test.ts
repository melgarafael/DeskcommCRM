import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Registro from "@/lib/external-db/receitas/registro";

const mocks = vi.hoisted(() => ({ abrirAcesso: vi.fn(), receitaDe: vi.fn() }));

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: mocks.abrirAcesso }));
vi.mock("@/lib/external-db/receitas/registro", async (importOriginal) => ({
  ...(await importOriginal<typeof Registro>()),
  receitaDe: mocks.receitaDe,
}));

import { crmConsultarReceita } from "./receitas-externas";
import type { McpContext } from "@/lib/mcp/types";

// R5b — o que o agente recebe junto com as linhas: para onde vai o interesse.
//
// O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
//  - sem destino: instrução de handoff, sem ids → tirar `interesse:` do retorno do handler
//  - com destino: ids, nomes e referência, lidos com a ORGANIZAÇÃO do contexto
//    → tirar o `.eq("organization_id", ...)` em `nomesDoDestinoValido`
//  - destino cujo funil sumiu: cai em "indisponível", não entrega id morto
//    → tirar o `if (!funil) return null` em `nomesDoDestinoValido`

const ORG = "org-do-turno";
const CONEXAO = "11111111-1111-4111-8111-111111111111";
const INSTANCIA_ID = "55555555-5555-4555-8555-555555555555";
const PIPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const RECEITA = {
  id: "wordpress-conteudo",
  motores: ["mysql"],
  tetoDeItens: 5,
  parametrosDaBusca: { parse: (v: unknown) => v },
  tabelas: () => ["wp_posts"],
  colunas: () => ({ wp_posts: ["ID", "post_title"] }),
  montar: vi.fn(() => ({ sql: "select ...", valores: [] as unknown[] })),
};

function instancia(destino?: { pipeline_id: string; stage_id: string } | null) {
  return {
    id: INSTANCIA_ID,
    receita: "wordpress-conteudo",
    rotulo: "Imóveis",
    descricao: "",
    fixos: { prefixo: "wp_" },
    ativa: true,
    ...(destino === undefined ? {} : { destino_do_interesse: destino }),
  };
}

/** Dublê por tabela. `funil`/`etapa` = o que a leitura devolve (null = não existe/inativo). */
function supabaseDuble(conexao: unknown, funil: unknown, etapa: unknown, orgsLidas: string[]) {
  return {
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          if (coluna === "organization_id") orgsLidas.push(`${tabela}:${String(valor)}`);
          return q;
        },
        maybeSingle: async () => ({
          data: tabela === "external_db_connections" ? conexao : tabela === "crm_pipelines" ? funil : etapa,
          error: null,
        }),
      };
      return q;
    },
  };
}

async function executar(instanciaGravada: unknown, funil: unknown, etapa: unknown) {
  const orgsLidas: string[] = [];
  const conexao = { id: CONEXAO, db_type: "mysql", receitas: [instanciaGravada], max_rows: 10 };
  const ctx = {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: supabaseDuble(conexao, funil, etapa, orgsLidas),
  } as unknown as McpContext;
  mocks.abrirAcesso.mockResolvedValue({
    ok: true,
    dialeto: { executarReceita: vi.fn(async () => ({ colunas: ["id"], linhas: [[1]], truncado: false })) },
  });
  const res = (await crmConsultarReceita.handler(
    { acao: "executar", connection_id: CONEXAO, instancia_id: INSTANCIA_ID, busca: { termos: ["apto"] } },
    ctx,
  )) as { interesse: Record<string, unknown> };
  return { res, orgsLidas };
}

describe("crm_consultar_receita — para onde vai o interesse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.receitaDe.mockReturnValue(RECEITA);
  });

  it("instância sem destino: o agente é mandado para o handoff, sem ids de funil", async () => {
    const { res, orgsLidas } = await executar(instancia(), null, null);

    expect(res.interesse).toMatchObject({ destino: null, motivo: "sem_destino" });
    expect(String(res.interesse.instrucao)).toContain("crm_request_human_handoff");
    // Sem destino, nada é lido de funil nem de etapa.
    expect(orgsLidas.filter((l) => l.startsWith("crm_"))).toEqual([]);
  });

  it("instância com destino válido: entrega ids, nomes e a referência, lidos na organização do turno", async () => {
    const { res, orgsLidas } = await executar(
      instancia({ pipeline_id: PIPE, stage_id: ETAPA }),
      { id: PIPE, name: "Imóveis" },
      { id: ETAPA, name: "Interesse" },
    );

    expect(res.interesse).toMatchObject({
      destino: { pipeline_id: PIPE, stage_id: ETAPA, funil: "Imóveis", etapa: "Interesse" },
      referencia_do_item: "wordpress-conteudo:<id do item>",
    });
    expect(orgsLidas).toEqual(expect.arrayContaining([`crm_pipelines:${ORG}`, `crm_stages:${ORG}`]));
  });

  it("destino cujo funil foi arquivado ou apagado: 'indisponível' e passa para a equipe", async () => {
    const { res } = await executar(instancia({ pipeline_id: PIPE, stage_id: ETAPA }), null, null);

    expect(res.interesse).toMatchObject({ destino: null, motivo: "destino_indisponivel" });
    expect(String(res.interesse.instrucao)).toContain("crm_request_human_handoff");
  });
});
