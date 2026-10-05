// @vitest-environment node
//
// TRANSFERÊNCIA DE FUNIL: A RÉGUA DA ETAPA DE PERDA DA ORIGEM PERGUNTA ANTES DO
// CLONE (issue #2303) ─────────────────────────────────────────────────────────
//
// ─── O defeito ──────────────────────────────────────────────────────────────
//
// `transfereParaOFunil` cria o clone no funil de destino e DEPOIS chama
// `encerraDemanda`. Quem fecha a origem faz a pergunta de campos obrigatórios
// dentro de `encerraDemanda` — e aí o clone JÁ ESTÁ GRAVADO. Com a etapa de
// PERDA da origem exigindo (`obrigatorio_em.ao_perder` ou `.etapas`) um campo
// que o negócio não tem, o `required_fields_missing` nascia tarde: o cliente
// ficava com DOIS negócios abertos, um em cada funil, e a recusa dizendo que
// nada mudou.
//
// ─── O que estes casos provam ───────────────────────────────────────────────
//
// 1. a exigência por `ao_perder` da origem recusa com o MESMO 422 da régua —
//    mesmo `code`, mesmo `details.faltando`, MESMA frase — e NADA é gravado;
// 2. o mesmo pela lista `obrigatorio_em.etapas` da ETAPA DE PERDA da origem
//    (prova que quem entra na pergunta é a etapa da ORIGEM, não a do destino);
// 3. controle positivo: a mesma origem exigente, mas o negócio TEM o campo →
//    transfere (clone gravado e origem encerrada) — a recusa é do campo
//    ausente, não da existência de `obrigatorio_em`;
// 4. controle de compatibilidade: funil da origem SEM `obrigatorio_em` →
//    transfere como antes, a regra continua opt-in.
//
// Sabotagem esperada: sem o bloco da régua em `transfereParaOFunil`, os casos 1
// e 2 ficam vermelhos (2 de 4) — cada um falhando em `escritas` com o clone
// já gravado — e os controles 3 e 4 continuam verdes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { recusaDeCamposObrigatorios } from "@/lib/leads/campos-exigidos";
import { transfereParaOFunil } from "@/lib/leads/transfere-para-o-funil";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIL_B = "11111111-1111-4111-8111-111111111111";
const ETAPA_DESTINO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ETAPA_PERDA_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD_ORIGEM = "99999999-9999-4999-8999-999999999999";
const LEAD_NOVO = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const RAZAO = "Levado para outro funil pela automação";

/** O funil de ORIGEM que exige `concorrente` PARA PERDER. */
const ORIGEM_EXIGENTE_AO_PERDER = {
  fields: [
    { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { ao_perder: true } },
  ],
};

/** O mesmo, amarrado à ETAPA de perda da origem (e não ao desfecho em geral). */
const ORIGEM_EXIGENTE_NA_ETAPA = {
  fields: [
    {
      key: "concorrente",
      label: "Concorrente",
      type: "text",
      obrigatorio_em: { etapas: [ETAPA_PERDA_A] },
    },
  ],
};

/** O mesmo funil sem nenhuma exigência — o caminho da compatibilidade. */
const ORIGEM_SEM_EXIGENCIA = {
  fields: [{ key: "concorrente", label: "Concorrente", type: "text" }],
};

/** O MESMO faltando que a régua devolve para esta exigência. */
const FALTANDO = [{ chave: "concorrente", rotulo: "Concorrente", tipo: "text" as const }];

const ctx = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "user-1" },
  requestId: "req-1",
};

/** A linha da origem como o banco a devolve (`COLUNAS_DA_ORIGEM` + stage/status). */
function origem(custom_fields: Record<string, unknown> = {}) {
  return {
    id: LEAD_ORIGEM,
    pipeline_id: FUNIL_A,
    status: "open",
    title: "Negócio no funil A",
    description: null,
    contact_id: null,
    value_cents: null,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    expected_close_date: null,
    tags: [],
    source: "manual",
    custom_fields,
    source_metadata: {},
    stage_id: ETAPA_PERDA_A,
    organization_id: ORG,
  };
}

type Resposta = { data: unknown; error: { message: string } | null };
type Consulta = {
  tabela: string;
  metodo: string;
  ordem: number;
  selecao: string;
  eqs: [string, unknown][];
};

/**
 * Supabase de mentira, encadeável, que responde por TABELA + MÉTODO + COLUNAS.
 *
 * O que a resposta precisa distinguir (e por quê):
 * - `crm_stages.select("id")` = etapa de PERDA da ORIGEM (a que a régua pergunta);
 * - `crm_stages.select("id, name")` = etapa terminal que o `encerraDemanda` escolhe;
 * - `crm_stages.select("id, pipeline_id, organization_id")` = etapa que o
 *   `createLeadHandler` valida antes de gravar o clone;
 * - `crm_pipelines` = o `settings` do funil lido no `.eq("id", …)` — a ORIGEM
 *   (a régua nova e o encerramento) ou o DESTINO (a criação do clone).
 *
 * Toda escrita (`insert`/`update`) é registrada em `escritas`, que é a asserção
 * de "nenhum negócio novo é gravado".
 */
function supabaseFake(
  settingsDaOrigem: unknown,
  customFieldsDaOrigem: Record<string, unknown> = {},
): { cliente: never; escritas: { tabela: string; metodo: string; linha: Record<string, unknown> }[] } {
  const ordens: Record<string, number> = {};
  const escritas: { tabela: string; metodo: string; linha: Record<string, unknown> }[] = [];

  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const cadeia = () => q;
    let selecao = "";
    const eqs: [string, unknown][] = [];
    for (const nome of ["neq", "is", "order", "limit"]) q[nome] = cadeia;
    q.eq = (coluna: string, valor: unknown) => {
      eqs.push([coluna, valor]);
      return q;
    };
    q.select = (cols: string) => {
      selecao = String(cols ?? "");
      return q;
    };
    q.insert = (linha: Record<string, unknown>) => {
      escritas.push({ tabela, metodo: "insert", linha });
      return q;
    };
    q.update = (linha: Record<string, unknown>) => {
      escritas.push({ tabela, metodo: "update", linha });
      return q;
    };
    const proxima = (metodo: string): Resposta => {
      const chave = `${tabela}:${metodo}`;
      ordens[chave] = (ordens[chave] ?? 0) + 1;
      return responde(
        { tabela, metodo, ordem: ordens[chave], selecao, eqs },
        settingsDaOrigem,
        customFieldsDaOrigem,
      );
    };
    q.maybeSingle = async () => proxima("maybeSingle");
    q.single = async () => {
      const r = proxima("single");
      return r.data === null && r.error === null
        ? { data: { ...(escritas.at(-1)?.linha ?? {}), id: LEAD_NOVO }, error: null }
        : r;
    };
    // `then` na própria cadeia cobre o `await` direto de uma query de LISTA e do
    // INSERT da timeline — é assim que o PostgREST devolve.
    q.then = (ok: (v: Resposta) => void) => {
      ok(proxima("lista"));
    };
    return q;
  };

  return { cliente: { from } as never, escritas };
}

function responde(
  c: Consulta,
  settingsDaOrigem: unknown,
  customFieldsDaOrigem: Record<string, unknown>,
): Resposta {
  // As etapas do funil de DESTINO — a primeira leitura da transferência.
  if (c.tabela === "crm_stages" && c.metodo === "lista") {
    return {
      data: [
        {
          id: ETAPA_DESTINO,
          pipeline_id: FUNIL_B,
          position: 1000,
          is_won: false,
          is_lost: false,
          is_archived: false,
        },
      ],
      error: null,
    };
  }
  if (c.tabela === "crm_stages" && c.metodo === "maybeSingle") {
    if (c.selecao === "id") return { data: { id: ETAPA_PERDA_A }, error: null };
    if (c.selecao === "id, name") {
      return { data: { id: ETAPA_PERDA_A, name: "Perdido" }, error: null };
    }
    if (c.selecao === "id, pipeline_id, organization_id") {
      return {
        data: { id: ETAPA_DESTINO, pipeline_id: FUNIL_B, organization_id: ORG },
        error: null,
      };
    }
    return { data: null, error: null };
  }
  if (c.tabela === "crm_pipelines" && c.metodo === "maybeSingle") {
    const daOrigem = c.eqs.some(([coluna, valor]) => coluna === "id" && valor === FUNIL_A);
    return { data: { settings: daOrigem ? settingsDaOrigem : ORIGEM_SEM_EXIGENCIA }, error: null };
  }
  if (c.tabela === "crm_leads" && c.metodo === "maybeSingle") {
    // MAX + 1000 da etapa (criação e encerramento) × a linha do negócio.
    if (c.selecao === "position_in_stage") return { data: { position_in_stage: 500 }, error: null };
    return { data: origem(customFieldsDaOrigem), error: null };
  }
  if (c.tabela === "organizations" && c.metodo === "maybeSingle") {
    return { data: { currency: "BRL" }, error: null };
  }
  return { data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transfereParaOFunil — a régua da PERDA da origem pergunta antes do clone (#2303)", () => {
  it("origem que exige `ao_perder` sem o campo: 422 da régua e NADA é gravado", async () => {
    const { cliente, escritas } = supabaseFake(ORIGEM_EXIGENTE_AO_PERDER);

    const erro = await transfereParaOFunil(
      cliente,
      ORG,
      ctx,
      origem(),
      FUNIL_B,
      ETAPA_DESTINO,
      RAZAO,
    ).catch((e: unknown) => e);

    // O MESMO erro que arrasto, lote, encerramento, criação e clone devolvem.
    expect(erro).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "required_fields_missing",
      details: { faltando: FALTANDO },
    });
    expect((erro as Error).message).toBe(recusaDeCamposObrigatorios(FALTANDO, undefined).mensagem);
    // E a recusa vem ANTES da primeira escrita: nem o clone nasceu.
    expect(escritas).toHaveLength(0);
  });

  it("origem que exige a ETAPA de perda sem o campo: 422 e NADA é gravado", async () => {
    const { cliente, escritas } = supabaseFake(ORIGEM_EXIGENTE_NA_ETAPA);

    const erro = await transfereParaOFunil(
      cliente,
      ORG,
      ctx,
      origem(),
      FUNIL_B,
      ETAPA_DESTINO,
      RAZAO,
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 422, code: "required_fields_missing" });
    expect(escritas).toHaveLength(0);
  });

  it("a MESMA origem exigente, com o campo PREENCHIDO na origem: transfere", async () => {
    const { cliente, escritas } = supabaseFake(ORIGEM_EXIGENTE_AO_PERDER, { concorrente: "ACME" });

    const r = await transfereParaOFunil(
      cliente,
      ORG,
      ctx,
      origem({ concorrente: "ACME" }),
      FUNIL_B,
      ETAPA_DESTINO,
      RAZAO,
    );

    expect(r.ok).toBe(true);
    const criados = escritas.filter((e) => e.tabela === "crm_leads" && e.metodo === "insert");
    expect(criados).toHaveLength(1);
    expect(criados[0]!.linha).toMatchObject({
      pipeline_id: FUNIL_B,
      stage_id: ETAPA_DESTINO,
      status: "open",
    });
    const fechados = escritas.filter((e) => e.tabela === "crm_leads" && e.metodo === "update");
    expect(fechados).toHaveLength(1);
    expect(fechados[0]!.linha).toMatchObject({
      stage_id: ETAPA_PERDA_A,
      lost_reason: "moved_to_another_pipeline",
    });
  });

  it("funil da origem SEM `obrigatorio_em`: transfere como antes — opt-in", async () => {
    const { cliente, escritas } = supabaseFake(ORIGEM_SEM_EXIGENCIA);

    const r = await transfereParaOFunil(
      cliente,
      ORG,
      ctx,
      origem(),
      FUNIL_B,
      ETAPA_DESTINO,
      RAZAO,
    );

    expect(r.ok).toBe(true);
    expect(escritas.filter((e) => e.tabela === "crm_leads")).toHaveLength(2);
  });
});
