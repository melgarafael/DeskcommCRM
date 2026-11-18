import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Duas ferramentas para a mesma coisa no mesmo turno são peso em todo passo (o
 * esquema inteiro vai junto) e uma escolha a mais para o modelo errar. Quando a
 * NATIVA do turno cobre a do catálogo (`COBERTA_PELA_NATIVA`), a do catálogo não
 * é montada — mas só quando a nativa está lá: sem ela, a capacidade some.
 *
 * Este arquivo amarra a ponta MCP (`buildMcpTurnTools`) com comportamento. A
 * LIGAÇÃO em `runAgentTurn` (inbound-turn.ts) não tem harness sem banco — a mesma
 * lacuna declarada em callback-desligado-some-do-turno-mcp.test.ts —, então o
 * último bloco é uma guarda de FONTE, no molde de send-template-wiring.test.ts:
 * prova que as três decisões estão escritas no código que roda, não que o turno
 * inteiro as executa. A prova pós-deploy é o log 'capacidades do catálogo
 * cobertas pela nativa — fora do turno'.
 */

const pickToolsFromMcp = vi.fn((input: { toolIds: string[] }) =>
  Object.fromEntries(input.toolIds.map((id) => [id, {}])),
);

vi.mock("@/lib/ai/runtime/tools", () => ({ pickToolsFromMcp }));
vi.mock("@/lib/ai/runtime/mcp_token", () => ({
  mintEphemeralToken: vi.fn(async () => ({ id: "tok-1" })),
  revokeEphemeralToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: vi.fn(async () => []) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionJob: () => undefined,
  currentExecutionBoundary: () => undefined,
}));

const { buildMcpTurnTools } = await import("@/lib/agent-engine/edge/crm/mcp-tools");
const { COBERTA_PELA_NATIVA } = await import("@/lib/mcp/tools/ferramentas-do-harness");
const { EQUIVALENTE_NO_OPERADOR } = await import("@/lib/agent-engine/agent/entrega-de-capacidade");
const { turnoProjeta } = await import("@/lib/agent-engine/agent/projecao");
const { idsDoCatalogoQueContamParaAProjecao } = await import("@/lib/agent-engine/edge/crm/mcp-tools");

const TOOLS = ["crm_search_knowledge", "crm_schedule_followup", "crm_list_tags"];

/** Mesmo falso de callback-desligado-some-do-turno-mcp: sem servidor MCP externo. */
const supabaseSemServidorExterno = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
    }),
  }),
};

async function montar(toolIds: string[], nativasDoTurno?: string[]) {
  const agentConfig = {
    agentId: "agente-1",
    toolIds,
    pipelineIds: [],
    // retorno automático ligado: a do catálogo não sai pelo callback
    followup: { enabled: true, callback_enabled: true },
  };
  const out = await buildMcpTurnTools(
    { supabase: supabaseSemServidorExterno as never },
    { organizationId: "org-1", jobId: "job-1", contactId: null },
    agentConfig as never,
    { warn: vi.fn(), info: vi.fn() } as never,
    nativasDoTurno === undefined ? undefined : { readOnly: false, nativasDoTurno },
  );
  expect(pickToolsFromMcp).toHaveBeenCalledTimes(1);
  return { out, entregues: pickToolsFromMcp.mock.calls[0]![0].toolIds };
}

beforeEach(() => {
  pickToolsFromMcp.mockClear();
});

describe("a do catálogo coberta pela nativa do turno não é montada", () => {
  it("⭐ com as duas nativas no turno, só o que não é duplicata chega ao modelo", async () => {
    const { out, entregues } = await montar(TOOLS, ["search_knowledge", "schedule_followup"]);
    expect(entregues).toEqual(["crm_list_tags"]);
    expect(out?.toolIds).toEqual(["crm_list_tags"]);
    expect(out?.cobertasPelaNativa).toEqual(["crm_search_knowledge", "crm_schedule_followup"]);
  });

  it("só a busca nativa no turno: sai só a busca do catálogo", async () => {
    const { out, entregues } = await montar(TOOLS, ["search_knowledge"]);
    expect(entregues).toEqual(["crm_schedule_followup", "crm_list_tags"]);
    expect(out?.cobertasPelaNativa).toEqual(["crm_search_knowledge"]);
  });

  it("controle: sem a opção (Operador, chamador antigo) as três passam", async () => {
    const { out, entregues } = await montar(TOOLS);
    expect(entregues).toEqual(TOOLS);
    expect(out?.cobertasPelaNativa).toEqual([]);
  });

  it("controle: nativa que não cobre nada não tira ninguém", async () => {
    const { entregues } = await montar(TOOLS, ["send_message", "get_lead_context"]);
    expect(entregues).toEqual(TOOLS);
  });

  it("a única do catálogo coberta: a ponte ainda é chamada (vazia) e a projeção não muda", async () => {
    // A ponte injeta as ferramentas de proposta mesmo com a lista vazia — o corte
    // não pode trocar isso por `null`. E o turno soma as cobertas ao que conta como
    // "do catálogo": sem isso, a projeção do contexto armaria só por causa do corte.
    const { out, entregues } = await montar(["crm_search_knowledge"], ["search_knowledge"]);
    expect(out).not.toBeNull();
    expect(entregues).toEqual([]);
    expect(out?.toolIds).toEqual([]);
    expect(out?.cobertasPelaNativa).toEqual(["crm_search_knowledge"]);
    expect(turnoProjeta(idsDoCatalogoQueContamParaAProjecao(out!))).toBe(false);
    // controle: sem as cobertas, a projeção ARMARIA — é o que a soma impede.
    expect(turnoProjeta(out!.toolIds)).toBe(true);
  });
});

describe("a ligação em runAgentTurn (guarda de fonte)", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const chamadaDaPonte = (() => {
    const i = FONTE.indexOf("await buildMcpTurnTools(");
    expect(i, "âncora `await buildMcpTurnTools(` sumiu do turno").toBeGreaterThan(-1);
    return FONTE.slice(i, FONTE.indexOf(");", FONTE.indexOf("efeitosDoTurno", i)) + 2);
  })();

  it("⭐ as nativas passadas à ponte excluem as entregues ao Operador, e são calculadas ANTES dela", () => {
    // Sem a exclusão, a nativa que o Operador assumiu (e que sai do Conversador)
    // tiraria a do catálogo também: o Conversador perderia as duas.
    const def = FONTE.match(/const nativasDoTurno = Object\.keys\(rawTools\)\.filter\(\(n\) => !entregues\.includes\(n\)\);/);
    expect(def, "definição de nativasDoTurno mudou").not.toBeNull();
    expect(FONTE.indexOf(def![0])).toBeLessThan(FONTE.indexOf("await buildMcpTurnTools("));
  });

  it("⭐ os DOIS ramos (Testar e atendimento) passam nativasDoTurno à ponte", () => {
    expect(chamadaDaPonte).toMatch(/readOnly: true,[^}]*nativasDoTurno/);
    expect(chamadaDaPonte).toMatch(/readOnly: false,[^}]*nativasDoTurno/);
  });

  it("⭐ o que conta para a projeção soma as cobertas (pelo mesmo helper testado acima)", () => {
    expect(FONTE).toMatch(/mcpToolIdsDoTurno\.push\(\.\.\.idsDoCatalogoQueContamParaAProjecao\(mcp\)\);/);
    expect(FONTE).not.toMatch(/mcpToolIdsDoTurno\.push\(\.\.\.mcp\.toolIds\)/);
  });
});

describe("COBERTA_PELA_NATIVA e EQUIVALENTE_NO_OPERADOR não se contradizem", () => {
  it("a nativa que tem equivalente no Operador lista a do catálogo que a cobre", () => {
    for (const [catalogo, { nativa }] of Object.entries(COBERTA_PELA_NATIVA)) {
      const equivalentes = EQUIVALENTE_NO_OPERADOR[nativa];
      if (equivalentes !== undefined) expect(equivalentes, nativa).toContain(catalogo);
    }
  });

  it("o equivalente no Operador que está em COBERTA aponta de volta para a mesma nativa", () => {
    for (const [nativa, equivalentes] of Object.entries(EQUIVALENTE_NO_OPERADOR)) {
      for (const e of equivalentes) {
        const c = COBERTA_PELA_NATIVA[e];
        if (c !== undefined) expect(c.nativa, e).toBe(nativa);
      }
    }
  });
});
