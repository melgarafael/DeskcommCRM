/**
 * Exportar/importar fluxo — as regras PURAS de `lib/followup/portabilidade.ts`.
 *
 * O que está sendo provado: o arquivo exportado volta pela importação sem perda
 * (ida e volta), e cada id de outra conta é mantido, remapeado pelo nome ou
 * esvaziado — nunca "chutado" quando o nome é ambíguo.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowGraph, FlowNode } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import {
  FORMATO_DO_ARQUIVO,
  arquivoDeFluxoSchema,
  idsCitados,
  montarArquivoDeFluxo,
  nomeDoArquivo,
  nomeDoImportado,
  problemasDoArquivo,
  reconciliarComAConta,
  zodNoIdioma,
  resolverPorNome,
  type ContextoDaConta,
  type NomesDaOrigem,
} from "@/lib/followup/portabilidade";

const ETAPA_ORIGEM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA_DESTINO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODELO_ORIGEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MODELO_DESTINO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PESSOA_ORIGEM = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FLUXO_ORIGEM = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const pos = { x: 0, y: 0 };

function grafo(extra: FlowNode[]): FlowGraph {
  const nodes: FlowNode[] = [
    { id: "t1", type: "trigger", label: "Início", position: pos, config: {} },
    ...extra,
    { id: "e1", type: "end", label: "Fim", position: pos, config: { outcome: "exhausted" } },
  ];
  const edges = nodes.slice(0, -1).map((n, i) => ({
    id: `x${i}`,
    source: n.id,
    target: nodes[i + 1]!.id,
    priority: 0,
    condition: { type: "always" as const },
  }));
  return { nodes, edges };
}

const nomesVazios = (): NomesDaOrigem => ({
  stages: new Map(),
  templates: new Map(),
  flows: new Map(),
  event_types: new Map(),
});

const contaVazia = (): ContextoDaConta => ({
  stages: new Map(),
  templates: new Map(),
  users: new Set(),
  flows: new Map(),
  event_types: new Map(),
});

function exportar(g: FlowGraph, nomes = nomesVazios(), trigger: unknown = { kind: "manual" }) {
  return montarArquivoDeFluxo(
    {
      name: "Recuperação",
      surface: "followup",
      handoff_policy: "pause",
      trigger_config: trigger,
      graph: g,
    },
    nomes,
    new Date("2026-10-17T12:00:00Z"),
  );
}

/** O arquivo passa pelo JSON (como o download/upload faz) e pelo schema da importação. */
function idaEVolta(arquivo: unknown) {
  const parsed = arquivoDeFluxoSchema.safeParse(JSON.parse(JSON.stringify(arquivo)));
  if (!parsed.success) throw new Error(problemasDoArquivo(parsed.error).join("\n"));
  return parsed.data;
}

describe("exportação", () => {
  it("o arquivo exportado volta pela importação idêntico", () => {
    const g = grafo([
      {
        id: "w1",
        type: "wait",
        label: "Esperar 1 dia",
        position: pos,
        config: { mode: "fixed", duration_ms: 86_400_000 },
      },
      {
        id: "a1",
        type: "action",
        label: "Mensagem",
        position: pos,
        config: { mode: "text", body: "Oi, {{contact.name}}!" },
      },
      {
        id: "tg",
        type: "edit_lead_tag",
        label: "Tag",
        position: pos,
        config: { tags: ["retorno"] },
      },
    ]);
    const arquivo = idaEVolta(exportar(g));
    expect(arquivo.format).toBe(FORMATO_DO_ARQUIVO);
    expect(arquivo.flow.graph).toEqual(g);
    expect(arquivo.flow.trigger_config).toEqual({ kind: "manual" });
    expect(arquivo.references).toBeUndefined();
  });

  it("leva o NOME de cada etapa/modelo/fluxo citado, para a importação achar em outra conta", () => {
    const g = grafo([
      {
        id: "m1",
        type: "move_lead",
        label: "Mover",
        position: pos,
        config: { stage_id: ETAPA_ORIGEM },
      },
      {
        id: "a1",
        type: "action",
        label: "Modelo",
        position: pos,
        config: { mode: "template", template_id: MODELO_ORIGEM },
      },
    ]);
    const nomes = nomesVazios();
    nomes.stages.set(ETAPA_ORIGEM, "Proposta · Funil de Vendas");
    nomes.templates.set(MODELO_ORIGEM, "Boas-vindas");
    const arquivo = exportar(g, nomes);
    expect(arquivo.references).toEqual({
      stages: { [ETAPA_ORIGEM]: "Proposta · Funil de Vendas" },
      templates: { [MODELO_ORIGEM]: "Boas-vindas" },
    });
  });

  it("gatilho que não parseia sai como manual — o arquivo sempre volta", () => {
    const arquivo = exportar(grafo([]), nomesVazios(), { kind: "inexistente" });
    expect(idaEVolta(arquivo).flow.trigger_config).toEqual({ kind: "manual" });
  });

  it("nome do arquivo sem acento nem caractere que o sistema de arquivos recusa", () => {
    expect(nomeDoArquivo("Recuperação / Carrinho: 2ª vez")).toBe(
      "recuperacao-carrinho-2-vez.fluxo.json",
    );
    expect(nomeDoArquivo("***")).toBe("fluxo.fluxo.json");
  });

  it("idsCitados lê etapa de condição, modelo de reserva, pessoa, próximo fluxo e gatilho de etapa", () => {
    const g = grafo([
      {
        id: "c1",
        type: "condition",
        label: "Etapa?",
        position: pos,
        config: {
          combinator: "and",
          checks: [{ field: "lead_stage", op: "eq", value: ETAPA_ORIGEM }],
        },
      },
      {
        id: "a1",
        type: "action",
        label: "IA",
        position: pos,
        config: { mode: "ai_message", prompt_hint: "retome", fallback_template_id: MODELO_ORIGEM },
      },
      {
        id: "it",
        type: "internal_task",
        label: "Ligar",
        position: pos,
        config: {
          titulo: "Ligar",
          vence_em_dias: 1,
          atribuir_a: { usuario_id: PESSOA_ORIGEM },
          prioridade: "medium",
        },
      },
    ]);
    g.nodes[g.nodes.length - 1] = {
      id: "e1",
      type: "end",
      label: "Fim",
      position: pos,
      config: {
        outcome: "converted",
        ao_finalizar: { tipo: "proximo_fluxo", fluxo: FLUXO_ORIGEM },
      },
    };
    const ids = idsCitados(g, { kind: "stage_change", params: { stage_id: ETAPA_DESTINO } });
    expect([...ids.stages].sort()).toEqual([ETAPA_ORIGEM, ETAPA_DESTINO].sort());
    expect([...ids.templates]).toEqual([MODELO_ORIGEM]);
    expect([...ids.users]).toEqual([PESSOA_ORIGEM]);
    expect([...ids.flows]).toEqual([FLUXO_ORIGEM]);
  });
});

describe("importação: arquivo inválido", () => {
  it("recusa o que não é deste formato, dizendo onde", () => {
    const r = arquivoDeFluxoSchema.safeParse({ format: "outro", version: 1, flow: {} });
    expect(r.success).toBe(false);
    if (!r.success) {
      const problemas = problemasDoArquivo(r.error);
      expect(problemas.some((p) => p.startsWith("format"))).toBe(true);
    }
  });

  it("recusa grafo com aresta para nó inexistente — a mesma catraca do editor", () => {
    const g = grafo([]);
    g.edges.push({
      id: "solta",
      source: "t1",
      target: "nao-existe",
      priority: 0,
      condition: { type: "always" },
    });
    const r = arquivoDeFluxoSchema.safeParse(JSON.parse(JSON.stringify(exportar(g))));
    expect(r.success).toBe(false);
    if (!r.success) expect(problemasDoArquivo(r.error).join("\n")).toContain("nao-existe");
  });

  it("recusa espera abaixo do piso de 5 minutos, com o caminho até o campo", () => {
    const arquivo = JSON.parse(JSON.stringify(exportar(grafo([]))));
    arquivo.flow.graph.nodes.splice(1, 0, {
      id: "w1",
      type: "wait",
      label: "Espera",
      position: pos,
      config: { mode: "fixed", duration_ms: 1000 },
    });
    const r = arquivoDeFluxoSchema.safeParse(arquivo);
    expect(r.success).toBe(false);
    if (!r.success)
      expect(problemasDoArquivo(r.error)[0]).toMatch(/^flow\.graph\.nodes\.1\.config/);
  });
});

describe("importação: os problemas saem no idioma de quem lê", () => {
  // O caso da prova do #3056: modelo com id que não é uuid e caixa sem `config`.
  // Antes saía «Invalid UUID» e «Invalid input: expected object, received undefined».
  function arquivoQuebrado() {
    const arquivo = JSON.parse(
      JSON.stringify(
        exportar(
          grafo([
            { id: "m1", type: "action", label: "Modelo", position: pos, config: { mode: "template", template_id: MODELO_ORIGEM } },
            { id: "a2", type: "action", label: "Texto", position: pos, config: { mode: "text", body: "Oi" } },
          ]),
        ),
      ),
    );
    arquivo.flow.graph.nodes[1].config.template_id = "nao-e-uuid";
    delete arquivo.flow.graph.nodes[2].config;
    return arquivo;
  }

  it.each([
    [
      "pt-BR",
      [
        "flow.graph.nodes.1.config.template_id: Formato do UUID inválido",
        'flow.graph.nodes.2.config: Entrada inválida: esperava um objeto, recebeu um valor "undefined"',
      ],
    ],
    [
      "es",
      [
        "flow.graph.nodes.1.config.template_id: Inválido UUID",
        "flow.graph.nodes.2.config: Entrada inválida: se esperaba objeto, recibido indefinido",
      ],
    ],
  ] as const)("%s, com o caminho até o campo", (idioma, esperado) => {
    const r = arquivoDeFluxoSchema.safeParse(arquivoQuebrado(), zodNoIdioma(idioma));
    expect(r.success).toBe(false);
    if (!r.success) expect(problemasDoArquivo(r.error)).toEqual(esperado);
  });

  it("arquivo de outro formato: nenhuma linha fica em inglês", () => {
    const r = arquivoDeFluxoSchema.safeParse({ format: "outro", version: 1, flow: {} }, zodNoIdioma("pt-BR"));
    expect(r.success).toBe(false);
    if (!r.success)
      expect(problemasDoArquivo(r.error)).toEqual([
        'format: Entrada inválida: esperava "followup_flow"',
        'flow.name: Entrada inválida: esperava um texto, recebeu um valor "undefined"',
        'flow.graph: Entrada inválida: esperava um objeto, recebeu um valor "undefined"',
      ]);
  });

  it("mensagem escrita no schema continua vencendo o locale", () => {
    const g = grafo([]);
    g.edges.push({ id: "solta", source: "t1", target: "nao-existe", priority: 0, condition: { type: "always" } });
    const arquivo = JSON.parse(JSON.stringify(exportar(g)));
    const semLocale = arquivoDeFluxoSchema.safeParse(arquivo);
    const emEspanhol = arquivoDeFluxoSchema.safeParse(arquivo, zodNoIdioma("es"));
    expect(semLocale.success || emEspanhol.success).toBe(false);
    if (!semLocale.success && !emEspanhol.success)
      expect(problemasDoArquivo(emEspanhol.error)).toEqual(problemasDoArquivo(semLocale.error));
  });
});

describe("importação: referências", () => {
  it("na mesma conta, todo id existe e nada muda", () => {
    const g = grafo([
      {
        id: "m1",
        type: "move_lead",
        label: "Mover",
        position: pos,
        config: { stage_id: ETAPA_ORIGEM },
      },
    ]);
    const conta = contaVazia();
    conta.stages.set(ETAPA_ORIGEM, "Proposta · Funil de Vendas");
    const r = reconciliarComAConta(idaEVolta(exportar(g)), conta);
    expect(r.graph).toEqual(g);
    expect(r.pendencias).toEqual([]);
  });

  it("em outra conta, a etapa é remapeada pelo nome (sem acento e sem caixa)", () => {
    const g = grafo([
      {
        id: "m1",
        type: "move_lead",
        label: "Mover",
        position: pos,
        config: { stage_id: ETAPA_ORIGEM },
      },
    ]);
    const nomes = nomesVazios();
    nomes.stages.set(ETAPA_ORIGEM, "Negociação · Funil de Vendas");
    const conta = contaVazia();
    conta.stages.set(ETAPA_DESTINO, "negociacao · funil de vendas");
    const r = reconciliarComAConta(idaEVolta(exportar(g, nomes)), conta);
    const mover = r.graph.nodes.find((n) => n.id === "m1");
    expect(mover?.type === "move_lead" && mover.config.stage_id).toBe(ETAPA_DESTINO);
    expect(r.pendencias).toEqual([
      {
        codigo: "etapa_remapeada",
        bloqueia: false,
        no: { id: "m1", label: "Mover" },
        referencia: "Negociação · Funil de Vendas",
      },
    ]);
  });

  it("etapa sem par vira campo vazio — e a publicação recusa até a pessoa escolher", () => {
    const g = grafo([
      {
        id: "m1",
        type: "move_lead",
        label: "Mover",
        position: pos,
        config: { stage_id: ETAPA_ORIGEM },
      },
    ]);
    const r = reconciliarComAConta(idaEVolta(exportar(g)), contaVazia());
    const mover = r.graph.nodes.find((n) => n.id === "m1");
    expect(mover?.type === "move_lead" && mover.config.stage_id).toBe("");
    expect(r.pendencias[0]).toMatchObject({ codigo: "etapa_nao_encontrada", bloqueia: true });
    const publicacao = validateFlowForPublish(r.graph, { etapas: new Map() });
    expect(publicacao.ok).toBe(false);
  });

  it("nome que casa com DUAS etapas não é chutado", () => {
    const daqui = new Map([
      [ETAPA_DESTINO, "Proposta · Funil A"],
      [ETAPA_ORIGEM, "Proposta · Funil B"],
    ]);
    expect(resolverPorNome("Proposta · Funil C", daqui)).toBeNull();
    expect(resolverPorNome("Proposta · Funil A", daqui)).toBe(ETAPA_DESTINO);
  });

  it("etapa sozinha (sem o funil igual) só casa quando é única na conta", () => {
    const daqui = new Map([[ETAPA_DESTINO, "Proposta · Vendas"]]);
    expect(resolverPorNome("Proposta · Comercial", daqui)).toBe(ETAPA_DESTINO);
  });

  it("modelo de reserva ausente sai do nó; modelo principal ausente fica e bloqueia", () => {
    const g = grafo([
      {
        id: "a1",
        type: "action",
        label: "IA",
        position: pos,
        config: { mode: "ai_message", prompt_hint: "x", fallback_template_id: MODELO_ORIGEM },
      },
      {
        id: "a2",
        type: "action",
        label: "Modelo",
        position: pos,
        config: { mode: "template", template_id: MODELO_ORIGEM },
      },
    ]);
    const r = reconciliarComAConta(idaEVolta(exportar(g)), contaVazia());
    const ia = r.graph.nodes.find((n) => n.id === "a1");
    const modelo = r.graph.nodes.find((n) => n.id === "a2");
    expect(ia?.type === "action" && ia.config).toEqual({ mode: "ai_message", prompt_hint: "x" });
    expect(modelo?.type === "action" && modelo.config).toEqual({
      mode: "template",
      template_id: MODELO_ORIGEM,
    });
    expect(r.pendencias.map((p) => [p.codigo, p.bloqueia])).toEqual([
      ["modelo_reserva_removido", false],
      ["modelo_nao_encontrado", true],
    ]);
  });

  it("modelo é remapeado pelo título", () => {
    const g = grafo([
      {
        id: "a2",
        type: "action",
        label: "Modelo",
        position: pos,
        config: { mode: "template", template_id: MODELO_ORIGEM },
      },
    ]);
    const nomes = nomesVazios();
    nomes.templates.set(MODELO_ORIGEM, "Boas-vindas");
    const conta = contaVazia();
    conta.templates.set(MODELO_DESTINO, "Boas-vindas");
    const r = reconciliarComAConta(idaEVolta(exportar(g, nomes)), conta);
    const modelo = r.graph.nodes.find((n) => n.id === "a2");
    expect(
      modelo?.type === "action" && modelo.config.mode === "template" && modelo.config.template_id,
    ).toBe(MODELO_DESTINO);
  });

  it("pessoa de outra conta vira «dono do lead»", () => {
    const g = grafo([
      {
        id: "it",
        type: "internal_task",
        label: "Ligar",
        position: pos,
        config: {
          titulo: "Ligar",
          vence_em_dias: 1,
          atribuir_a: { usuario_id: PESSOA_ORIGEM },
          prioridade: "medium",
        },
      },
    ]);
    const r = reconciliarComAConta(idaEVolta(exportar(g)), contaVazia());
    const tarefa = r.graph.nodes.find((n) => n.id === "it");
    expect(tarefa?.type === "internal_task" && tarefa.config.atribuir_a).toBe("dono_do_lead");
    expect(r.pendencias[0]).toMatchObject({ codigo: "responsavel_trocado", bloqueia: false });
  });

  it("próximo fluxo ausente vira «nada»", () => {
    const g = grafo([]);
    g.nodes[g.nodes.length - 1] = {
      id: "e1",
      type: "end",
      label: "Fim",
      position: pos,
      config: {
        outcome: "converted",
        ao_finalizar: { tipo: "proximo_fluxo", fluxo: FLUXO_ORIGEM },
      },
    };
    const r = reconciliarComAConta(idaEVolta(exportar(g)), contaVazia());
    const fim = r.graph.nodes.find((n) => n.id === "e1");
    expect(fim?.type === "end" && fim.config.ao_finalizar).toEqual({ tipo: "nada" });
  });

  it("gatilho de etapa sem par volta a manual (preservando cancel_on_reply) e bloqueia", () => {
    const arquivo = idaEVolta(
      exportar(grafo([]), nomesVazios(), {
        kind: "stage_change",
        params: { stage_id: ETAPA_ORIGEM },
        cancel_on_reply: true,
      }),
    );
    const r = reconciliarComAConta(arquivo, contaVazia());
    expect(r.trigger_config).toEqual({ kind: "manual", cancel_on_reply: true });
    expect(r.pendencias).toEqual([{ codigo: "gatilho_trocado_para_manual", bloqueia: true }]);
  });

  it("gatilho de etapa é remapeado pelo nome", () => {
    const nomes = nomesVazios();
    nomes.stages.set(ETAPA_ORIGEM, "Ganho · Vendas");
    const conta = contaVazia();
    conta.stages.set(ETAPA_DESTINO, "Ganho · Vendas");
    const arquivo = idaEVolta(
      exportar(grafo([]), nomes, { kind: "stage_change", params: { stage_id: ETAPA_ORIGEM } }),
    );
    const r = reconciliarComAConta(arquivo, conta);
    expect(r.trigger_config).toEqual({ kind: "stage_change", params: { stage_id: ETAPA_DESTINO } });
  });

  it("gatilho de falta com tipo ausente NÃO alarga para todos os tipos: volta a manual", () => {
    const arquivo = idaEVolta(
      exportar(grafo([]), nomesVazios(), {
        kind: "appointment_no_show",
        params: { event_type_ids: [ETAPA_ORIGEM] },
      }),
    );
    const r = reconciliarComAConta(arquivo, contaVazia());
    expect(r.trigger_config.kind).toBe("manual");
  });
});

describe("nome do importado", () => {
  it("mantém o nome livre e sufixa o ocupado", () => {
    expect(nomeDoImportado("Recuperação", [])).toBe("Recuperação");
    expect(nomeDoImportado("Recuperação", ["Recuperação"])).toBe("Recuperação (importado)");
    expect(nomeDoImportado("Recuperação", ["Recuperação", "Recuperação (importado)"])).toBe(
      "Recuperação (importado 2)",
    );
    expect(nomeDoImportado("x".repeat(80), ["x".repeat(80)]).length).toBeLessThanOrEqual(80);
  });
});

describe("o exemplo da documentação", () => {
  it("docs/features/exemplos/fluxo-de-exemplo.fluxo.json é um arquivo válido e publicável", () => {
    const bruto = JSON.parse(
      readFileSync(
        join(process.cwd(), "docs/features/exemplos/fluxo-de-exemplo.fluxo.json"),
        "utf8",
      ),
    );
    const arquivo = idaEVolta(bruto);
    const r = reconciliarComAConta(arquivo, contaVazia());
    expect(r.pendencias).toEqual([]);
    expect(validateFlowForPublish(r.graph, {}).ok).toBe(true);
  });
});
