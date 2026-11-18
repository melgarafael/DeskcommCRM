/**
 * O CRITÉRIO DA ETAPA, DE PONTA A PONTA (#4836).
 *
 * O agente já LIA `crm_stages.description` — `crm_list_stages` devolve o campo e
 * `lib/leads/stage-operations.ts` o repassa. O que faltava era ONDE ESCREVER: a
 * tela não tinha campo, o PATCH não aceitava `description` e o `crm_update_stage`
 * também não. Na prática a coluna ficava `null` em todo funil criado pela tela e
 * o modelo recebia "sem critério" em todas as etapas.
 *
 * ⚠️ ESTE ARQUIVO MEDE O CAMINHO, NÃO AS PONTAS. Um teste do Zod provaria que a
 * rota aceita a chave; um teste do `corpo()` provaria que a leitura sabe
 * devolvê-la. Nenhum dos dois prova o que a issue pede: **o texto escrito passa
 * pelo PATCH, chega ao banco e volta ao agente**. Por isso a asserção final é
 * sempre a RESPOSTA de `crm_list_stages` sobre o banco que a escrita deixou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { crmListStages, crmUpdateStage } from "@/lib/mcp/tools/operacao";
import {
  ORG_ID,
  PIPE,
  authOk,
  funil,
  makeDb,
  type Registro,
} from "@/tests/helpers/stages-db-double";

const STAGE = "e2";
const url = `http://localhost/api/v1/pipelines/${PIPE}/stages/${STAGE}`;

function ctx() {
  return { params: Promise.resolve({ id: PIPE, stageId: STAGE }) };
}

function reqPatch(body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** O agente lendo o funil do MESMO banco que a escrita acabou de tocar. */
async function oQueOAgenteVe(db: Registro) {
  const saida = (await crmListStages.handler(
    { pipeline_id: PIPE },
    {
      supabase: db.client,
      organizationId: ORG_ID,
      requestId: "req-criterio",
    } as never,
  )) as { etapas: Array<{ id: string; description: string | null }> };
  return saida.etapas.find((e) => e.id === STAGE)?.description ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#4836 — o critério escrito no PATCH chega ao agente", () => {
  it("texto escrito na tela → banco → `crm_list_stages` devolve o MESMO texto", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { PATCH } = await import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route");
    const res = await PATCH(
      reqPatch({ description: "Entra aqui quando o cliente aprova o orçamento e pede o link." }),
      ctx(),
    );

    expect(res.status).toBe(200);
    // O banco, e não só o eco da resposta.
    expect(db.tabelas.crm_stages.find((l) => l.id === STAGE)?.description).toBe(
      "Entra aqui quando o cliente aprova o orçamento e pede o link.",
    );
    expect(await oQueOAgenteVe(db)).toBe(
      "Entra aqui quando o cliente aprova o orçamento e pede o link.",
    );
  });

  it("apagar o texto (vazio) → o agente volta a ver `null`, não string vazia", async () => {
    authOk();
    const db = makeDb({
      stages: funil().map((e) =>
        e.id === STAGE ? { ...e, description: "Critério que o tenant já tinha" } : e,
      ),
    });

    const { PATCH } = await import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route");
    const res = await PATCH(reqPatch({ description: "   " }), ctx());

    expect(res.status).toBe(200);
    expect(db.tabelas.crm_stages.find((l) => l.id === STAGE)?.description).toBeNull();
    expect(await oQueOAgenteVe(db)).toBeNull();
  });

  it("o teto recusado na API é o de 500 caracteres, e o banco não muda", async () => {
    authOk();
    const db = makeDb({ stages: funil() });

    const { PATCH } = await import("@/app/api/v1/pipelines/[id]/stages/[stageId]/route");
    const res = await PATCH(reqPatch({ description: "a".repeat(501) }), ctx());

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
    expect(await oQueOAgenteVe(db)).toBeNull();
  });
});

describe("#4836 — `crm_update_stage` aceita o critério na MESMA forma da API", () => {
  /** O contexto do MCP: cliente do serviço, org do token, ator do agente. */
  function ctxMcp(db: Registro) {
    return {
      supabase: db.client,
      organizationId: ORG_ID,
      actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
      requestId: "req-mcp-criterio",
    } as never;
  }

  it("escreve o texto e o `crm_list_stages` o devolve — com autoria `ai`", async () => {
    const db = makeDb({ stages: funil() });

    await crmUpdateStage.handler(
      {
        pipeline_id: PIPE,
        stage_id: STAGE,
        description: "  Entra aqui quando o cliente pede desconto.  ",
      } as never,
      ctxMcp(db),
    );

    expect(db.tabelas.crm_stages.find((l) => l.id === STAGE)?.description).toBe(
      "Entra aqui quando o cliente pede desconto.",
    );
    // A autoria é a MESMA dos outros campos, inclusive quando quem escreve é o
    // agente — é ela que a tela mostra como "alterado pelo assistente".
    expect(db.tabelas.crm_stages.find((l) => l.id === STAGE)?.last_change_actor_kind).toBe("ai");
    expect(await oQueOAgenteVe(db)).toBe("Entra aqui quando o cliente pede desconto.");
  });

  it("vazio limpa (null) — a regra é a mesma da rota, não uma cópia do MCP", async () => {
    const db = makeDb({
      stages: funil().map((e) => (e.id === STAGE ? { ...e, description: "Antigo" } : e)),
    });

    await crmUpdateStage.handler(
      { pipeline_id: PIPE, stage_id: STAGE, description: "   " } as never,
      ctxMcp(db),
    );

    expect(db.tabelas.crm_stages.find((l) => l.id === STAGE)?.description).toBeNull();
  });

  it("acima do teto → recusa 422 do MESMO validador, e nada é escrito", async () => {
    const db = makeDb({ stages: funil() });

    await expect(
      crmUpdateStage.handler(
        { pipeline_id: PIPE, stage_id: STAGE, description: "b".repeat(501) } as never,
        ctxMcp(db),
      ),
    ).rejects.toBeInstanceOf(ApiError);

    expect(db.escritas).toEqual([]);
  });

  it("a descrição da ferramenta anuncia o campo (o modelo só usa o que ela diz que tem)", () => {
    expect(crmUpdateStage.description).toContain("description");
    expect(crmUpdateStage.description).toContain("500");
  });
});

describe("#4836 — a regra do teto é UMA só", () => {
  it("`validarDescricaoDeEtapa` conta depois do trim e usa a constante da tela", async () => {
    const { TETO_DA_DESCRICAO_DA_ETAPA, validarDescricaoDeEtapa } = await import(
      "@/lib/leads/stage-editing"
    );
    expect(TETO_DA_DESCRICAO_DA_ETAPA).toBe(500);
    expect(validarDescricaoDeEtapa("z".repeat(500)).ok).toBe(true);
    expect(validarDescricaoDeEtapa(`  ${"z".repeat(500)}  `).ok).toBe(true);
    expect(validarDescricaoDeEtapa("z".repeat(501)).ok).toBe(false);
  });

  it("`normalizarDescricaoDeEtapa` devolve `null` para vazio e o texto aparado para o resto", async () => {
    const { normalizarDescricaoDeEtapa } = await import("@/lib/leads/stage-editing");
    expect(normalizarDescricaoDeEtapa("")).toBeNull();
    expect(normalizarDescricaoDeEtapa("   ")).toBeNull();
    expect(normalizarDescricaoDeEtapa("  texto  ")).toBe("texto");
    expect(normalizarDescricaoDeEtapa(null)).toBeNull();
  });
});
