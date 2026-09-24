import { describe, expect, it } from "vitest";
import type pg from "pg";

import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import {
  finalizarFluxoDeAtendimento,
  mapearChecklist,
  melhorFluxoPorGatilho,
  montarResumoDoRoteiro,
  processarInboundDoFluxo,
  renderBlocoDeAtendimento,
  situacaoDoChecklist,
  valoresDoChecklist,
  type ChecklistDeAtendimento,
  type EstadoDeAtendimento,
} from "./atendimento";

function no(node: Partial<FlowNode> & Pick<FlowNode, "id" | "type" | "config">): FlowNode {
  return { label: node.id, position: { x: 0, y: 0 }, ...node } as FlowNode;
}

function aresta(source: string, target: string): FlowEdge {
  return { id: `${source}-${target}`, source, target, priority: 0, condition: { type: "always" } };
}

function grafo(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges } as FlowGraph;
}

const collect = (id: string, key: string, required = true) =>
  no({ id, type: "collect", config: { key, label: key, type: "text", required, permite_correcao: true } });
const skill = (id: string, nome: string) => no({ id, type: "skill", config: { skill_name: nome } });
const trigger = (id: string) => no({ id, type: "trigger", config: {} });
const end = (id: string) => no({ id, type: "end", config: { outcome: "converted" } });

describe("mapearChecklist", () => {
  it("lê a sequência trigger → pergunta → skill → fim", () => {
    const r = mapearChecklist(
      grafo(
        [trigger("t"), collect("c1", "cidade"), skill("s1", "catalogo-apresentacao"), end("e")],
        [aresta("t", "c1"), aresta("c1", "s1"), aresta("s1", "e")],
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checklist.passos.map((p) => p.kind)).toEqual(["collect", "skill"]);
      expect(r.checklist.fim.id).toBe("e");
    }
  });

  it("recusa ramificação (mais de uma saída)", () => {
    const r = mapearChecklist(
      grafo(
        [trigger("t"), collect("c1", "cidade"), collect("c2", "cnh"), end("e")],
        [aresta("t", "c1"), aresta("t", "c2"), aresta("c1", "e"), aresta("c2", "e")],
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("recusa nó que não é do atendimento", () => {
    const wait = no({ id: "w", type: "wait", config: { mode: "fixed", duration_ms: 300_000 } });
    const r = mapearChecklist(grafo([trigger("t"), wait, end("e")], [aresta("t", "w"), aresta("w", "e")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.erro).toContain("wait");
  });

  it("recusa ciclo", () => {
    const r = mapearChecklist(
      grafo([trigger("t"), collect("c1", "cidade"), end("e")], [aresta("t", "c1"), aresta("c1", "t")]),
    );
    expect(r.ok).toBe(false);
  });

  it("recusa sem gatilho único", () => {
    const r = mapearChecklist(grafo([collect("c1", "cidade"), end("e")], [aresta("c1", "e")]));
    expect(r.ok).toBe(false);
  });

  it("recusa quando não chega ao Fim", () => {
    const r = mapearChecklist(grafo([trigger("t"), collect("c1", "cidade")], [aresta("t", "c1")]));
    expect(r.ok).toBe(false);
  });
});

describe("melhorFluxoPorGatilho (entrada pelo motor)", () => {
  const fluxos = [
    { id: "q", nome: "Qualificação", gatilhos: ["quero uma moto", "interesse", "comprar"] },
    { id: "f", nome: "Financiamento", gatilhos: ["financiar", "parcela", "cpf"] },
    { id: "t", nome: "Troca", gatilhos: ["troca", "dar minha moto na troca"] },
  ];

  it("escolhe pelo maior número de gatilhos presentes", () => {
    expect(melhorFluxoPorGatilho(fluxos, "quero financiar, qual a parcela?")?.id).toBe("f");
  });

  it("ignora acento e caixa", () => {
    expect(melhorFluxoPorGatilho(fluxos, "QUERO DAR MINHA MOTO NA TROCA")?.id).toBe("t");
  });

  it("sem match devolve null", () => {
    expect(melhorFluxoPorGatilho(fluxos, "bom dia, tudo bem?")).toBeNull();
  });

  it("mais gatilhos na mesma mensagem vencem", () => {
    expect(melhorFluxoPorGatilho(fluxos, "tenho interesse, quero comprar")?.id).toBe("q");
  });
});

describe("situacaoDoChecklist", () => {
  const checklist: ChecklistDeAtendimento = {
    passos: [
      { kind: "collect", node: collect("c1", "cidade") as Extract<FlowNode, { type: "collect" }> },
      { kind: "skill", node: skill("s1", "catalogo-apresentacao") as Extract<FlowNode, { type: "skill" }> },
      { kind: "collect", node: collect("c2", "cnh") as Extract<FlowNode, { type: "collect" }> },
      { kind: "collect", node: collect("c3", "obs", false) as Extract<FlowNode, { type: "collect" }> },
    ],
    fim: end("e") as Extract<FlowNode, { type: "end" }>,
  };

  it("sem valores: tudo pendente e incompleto", () => {
    const s = situacaoDoChecklist(checklist, new Set());
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["cidade", "cnh", "obs"]);
    expect(s.obrigatoriosPendentes.map((n) => n.config.key)).toEqual(["cidade", "cnh"]);
    expect(s.skills).toEqual(["catalogo-apresentacao"]);
    expect(s.completo).toBe(false);
  });

  it("com os obrigatórios preenchidos: a OPCIONAL continua pendente (percorre o fluxo até o Fim)", () => {
    const s = situacaoDoChecklist(checklist, new Set(["cidade", "cnh"]));
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["obs"]);
    // "Opcional" = pode ser esgotada sem travar, NÃO pode ser pulada. Antes
    // este caso esperava `completo: true` e o efeito medido (2026-09-18) foi que
    // estado/documentação nunca eram perguntados no fluxo Troca.
    expect(s.completo).toBe(false);
  });

  it("com tudo preenchido: sem pendentes", () => {
    const s = situacaoDoChecklist(checklist, new Set(["cidade", "cnh", "obs"]));
    expect(s.pendentes).toHaveLength(0);
    expect(s.completo).toBe(true);
  });

  it("pergunta sem resposta que atingiu o teto vira esgotada e não bloqueia", () => {
    const s = situacaoDoChecklist(checklist, new Set(), {
      tentativas: { cidade: 3, cnh: 3 },
      maxTentativas: 3,
    });
    // As esgotadas saem de `pendentes`; a opcional `obs` segue pendente (será
    // perguntada) — por isso `completo` ainda é false.
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["obs"]);
    expect(s.esgotadas.map((n) => n.config.key)).toEqual(["cidade", "cnh"]);
    expect(s.completo).toBe(false);
  });

  it("com tudo preenchido OU esgotado: completo (esgotar a opcional não trava)", () => {
    const s = situacaoDoChecklist(checklist, new Set(["cidade", "cnh"]), {
      tentativas: { obs: 3 },
      maxTentativas: 3,
    });
    expect(s.pendentes).toHaveLength(0);
    expect(s.completo).toBe(true);
  });

  it("abaixo do teto continua pendente", () => {
    const s = situacaoDoChecklist(checklist, new Set(), {
      tentativas: { cidade: 2 },
      maxTentativas: 3,
    });
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["cidade", "cnh", "obs"]);
    expect(s.esgotadas).toHaveLength(0);
    expect(s.completo).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Armazenamento do port (plano 2026-09-23, D1–D4): resposta em
// contacts.custom_fields, trilha em followup_enrollment_events SEM o valor,
// tentativas contadas da trilha, execução em 'coletando'.
// ─────────────────────────────────────────────────────────────────────────────

const ORG = "org-A";

function lista(nodes: FlowNode[], edges: FlowEdge[]): ChecklistDeAtendimento {
  const r = mapearChecklist(grafo(nodes, edges));
  if (!r.ok) throw new Error(r.erro);
  return r.checklist;
}

function estadoCom(
  checklist: ChecklistDeAtendimento,
  valores: Record<string, string> = {},
  tentativas: Record<string, number> = {},
): EstadoDeAtendimento {
  return {
    enrollment: {
      id: "enr-A",
      pointer_id: "ptr-A",
      version_id: "ver-A",
      contact_id: "ct",
      current_node_id: "t",
      status: "coletando",
    },
    nomeDoFluxo: "Cadastro",
    checklist,
    valores,
    tentativas,
    maxTentativas: 3,
    situacao: situacaoDoChecklist(checklist, new Set(Object.keys(valores)), { tentativas, maxTentativas: 3 }),
  };
}

/**
 * Dublê de `pg.Pool`: registra SQL/parâmetros; eventos com `idempotency_key`
 * repetida não entram (como o índice `idx_followup_events_idem`).
 */
function poolFake(opts: { proximoGrafo?: FlowGraph; contatoAnonimizado?: boolean } = {}) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const chaves = new Set<string>();
  const query = async (sql: string, values: unknown[] = []) => {
    sqls.push(sql);
    params.push(values);
    if (/insert into followup_enrollment_events/.test(sql)) {
      const chave = values[5] as string | null;
      if (chave !== null) {
        if (chaves.has(chave)) return { rows: [], rowCount: 0 };
        chaves.add(chave);
      }
      return { rows: [], rowCount: 1 };
    }
    if (/update contacts/.test(sql)) return { rows: [], rowCount: opts.contatoAnonimizado ? 0 : 1 };
    if (/update followup_enrollments/.test(sql)) return { rows: [], rowCount: 1 };
    if (/select p\.active_version_id, v\.graph/.test(sql) && opts.proximoGrafo) {
      return { rows: [{ active_version_id: "ver-B", graph: opts.proximoGrafo }], rowCount: 1 };
    }
    if (/insert into followup_enrollments/.test(sql)) return { rows: [{ id: "enr-B" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const eventos = () =>
    sqls
      .map((s, i) => ({ s, p: params[i]! }))
      .filter(({ s }) => /insert into followup_enrollment_events/.test(s))
      .map(({ p }) => ({ tipo: p[3] as string, payload: JSON.parse(p[4] as string) as Record<string, unknown> }));
  return { pool: { query } as unknown as pg.Pool, sqls, params, eventos };
}

const cidadeECnh = () =>
  lista(
    [trigger("t"), collect("c1", "cidade"), collect("c2", "cnh"), end("e")],
    [aresta("t", "c1"), aresta("c1", "c2"), aresta("c2", "e")],
  );

describe("valoresDoChecklist (a resposta mora em custom_fields)", () => {
  it("lê só as chaves do roteiro, como texto", () => {
    expect(
      valoresDoChecklist(cidadeECnh(), { cidade: "Campinas", cnh: true, link_site: "x", vazio: "" }),
    ).toEqual({ cidade: "Campinas", cnh: "true" });
  });

  it("campo que o contato JÁ tem não fica pendente — o roteiro não repergunta", () => {
    const c = cidadeECnh();
    const valores = valoresDoChecklist(c, { cidade: "Campinas" });
    const s = situacaoDoChecklist(c, new Set(Object.keys(valores)));
    expect(s.pendentes.map((n) => n.config.key)).toEqual(["cnh"]);
  });

  it("lixo em custom_fields não quebra (null, array)", () => {
    expect(valoresDoChecklist(cidadeECnh(), null)).toEqual({});
    expect(valoresDoChecklist(cidadeECnh(), [1, 2])).toEqual({});
  });
});

describe("processarInboundDoFluxo — gravação e trilha", () => {
  it("resposta do validador vai para custom_fields do contato, filtrada pela organização", async () => {
    const { pool, sqls, params } = poolFake();
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh()),
      texto: "moro em Campinas",
      messageId: "m1",
      validacoes: [{ campo: "cidade", valor: "Campinas" }],
    });
    const i = sqls.findIndex((s) => /update contacts/.test(s));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(sqls[i]).toMatch(/custom_fields = coalesce\(custom_fields, '\{\}'::jsonb\) \|\|/);
    expect(sqls[i]).toMatch(/where organization_id = \$1 and id = \$2/);
    expect(params[i]).toEqual([ORG, "ct", "cidade", "Campinas"]);
  });

  it("a TRILHA nunca carrega o valor respondido", async () => {
    const { pool, eventos } = poolFake();
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh()),
      texto: "Campinas, e tenho CNH sim",
      messageId: "m1",
      validacoes: [
        { campo: "cidade", valor: "Campinas" },
        { campo: "cnh", valor: "true" },
      ],
    });
    const trilha = JSON.stringify(eventos());
    expect(eventos().map((e) => e.tipo)).toEqual([
      "roteiro_mensagem",
      "roteiro_resposta",
      "roteiro_resposta",
      "roteiro_concluido",
    ]);
    expect(trilha).not.toContain("Campinas");
    expect(trilha).not.toContain("valor");
  });

  it("mesma mensagem reprocessada (retry da fila) não grava nem conta de novo", async () => {
    const { pool, sqls } = poolFake();
    const args = {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh()),
      texto: "ok",
      messageId: "m-repetida",
    };
    await processarInboundDoFluxo(pool, args);
    const depoisDoPrimeiro = sqls.length;
    const r = await processarInboundDoFluxo(pool, args);
    expect(r.concluiu).toBe(false);
    // Só a tentativa de reivindicar a mensagem — nada de tentativa nem gravação.
    expect(sqls.length - depoisDoPrimeiro).toBe(1);
  });

  it("aceno conta tentativa na PRIMEIRA pendente; desvio não conta", async () => {
    const aceno = poolFake();
    await processarInboundDoFluxo(aceno.pool, {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh()),
      texto: "ok",
      messageId: "m1",
    });
    expect(aceno.eventos().map((e) => e.tipo)).toEqual(["roteiro_mensagem", "roteiro_tentativa"]);
    expect(aceno.eventos()[1]!.payload).toEqual({ campo: "cidade" });

    const desvio = poolFake();
    await processarInboundDoFluxo(desvio.pool, {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh()),
      texto: "vocês abrem no sábado?",
      messageId: "m2",
    });
    expect(desvio.eventos().map((e) => e.tipo)).toEqual(["roteiro_mensagem", "roteiro_fora_do_fluxo"]);
  });

  it("contato anonimizado: nada é gravado nem dado como respondido", async () => {
    const { pool, eventos } = poolFake({ contatoAnonimizado: true });
    const r = await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh()),
      texto: "Campinas",
      messageId: "m1",
      validacoes: [{ campo: "cidade", valor: "Campinas" }],
    });
    expect(r.concluiu).toBe(false);
    expect(eventos().map((e) => e.tipo)).toEqual(["roteiro_mensagem"]);
  });

  it("a última tentativa esgota a pergunta e fecha como exhausted", async () => {
    const c = lista([trigger("t"), collect("c1", "cidade"), end("e")], [aresta("t", "c1"), aresta("c1", "e")]);
    const { pool, sqls, params } = poolFake();
    const r = await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(c, {}, { cidade: 2 }),
      texto: "ok",
      messageId: "m1",
    });
    expect(r.concluiu).toBe(true);
    const i = sqls.findIndex((s) => /update followup_enrollments/.test(s));
    expect(sqls[i]).toMatch(/status = 'completed'/);
    expect(sqls[i]).toMatch(/and status = 'coletando'/);
    expect(params[i]![2]).toBe("exhausted");
  });

  it("tudo respondido fecha como converted, não 'Esgotado'", async () => {
    const c = lista([trigger("t"), collect("c1", "cidade"), end("e")], [aresta("t", "c1"), aresta("c1", "e")]);
    const { pool, sqls, params } = poolFake();
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(c),
      texto: "Campinas",
      messageId: "m1",
      validacoes: [{ campo: "cidade", valor: "Campinas" }],
    });
    const i = sqls.findIndex((s) => /update followup_enrollments/.test(s));
    expect(params[i]![2]).toBe("converted");
  });
});

describe("finalizarFluxoDeAtendimento — encadeamento", () => {
  const fimCom = (ao: unknown) =>
    no({
      id: "e",
      type: "end",
      config: { outcome: "converted", ao_finalizar: ao } as Extract<FlowNode, { type: "end" }>["config"],
    });
  const estadoFim = (ao: unknown) =>
    estadoCom(
      lista([trigger("t"), collect("c1", "cidade"), fimCom(ao)], [aresta("t", "c1"), aresta("c1", "e")]),
      { cidade: "Campinas" },
    );
  const grafoB = grafo([trigger("tB"), collect("cB", "outro"), end("eB")], [aresta("tB", "cB"), aresta("cB", "eB")]);

  it("encadeia o próximo roteiro em 'coletando', sem relógio, e registra encadeou", async () => {
    const { pool, sqls, eventos } = poolFake({ proximoGrafo: grafoB });
    const r = await finalizarFluxoDeAtendimento(pool, {
      organizationId: ORG,
      estado: estadoFim({ tipo: "proximo_fluxo", fluxo: "ptr-B" }),
    });
    expect(r.proximoEnrollmentId).toBe("enr-B");
    const ins = sqls.find((s) => /insert into followup_enrollments/.test(s))!;
    expect(ins).toMatch(/'coletando', null/);
    expect(eventos().map((e) => e.tipo)).toEqual(["roteiro_concluido", "roteiro_iniciado", "roteiro_encadeou"]);
  });

  it("NÃO encadeia para si mesmo (laço sem fim)", async () => {
    const { pool, sqls } = poolFake({ proximoGrafo: grafoB });
    const r = await finalizarFluxoDeAtendimento(pool, {
      organizationId: ORG,
      estado: estadoFim({ tipo: "proximo_fluxo", fluxo: "ptr-A" }),
    });
    expect(r.proximoEnrollmentId).toBeNull();
    expect(sqls.some((s) => /insert into followup_enrollments/.test(s))).toBe(false);
  });
});

describe("montarResumoDoRoteiro (passa-bastão e tela, D4 — sem síntese por modelo)", () => {
  it("rótulo: valor na ordem das perguntas, e o que falta aparece marcado", () => {
    const resumo = montarResumoDoRoteiro({ nomeDoFluxo: "Cadastro", checklist: cidadeECnh(), valores: { cidade: "Campinas" } });
    expect(resumo).toBe('Roteiro "Cadastro" — cidade: Campinas; cnh: (não respondido)');
  });

  it("o bloco do turno leva o resumo anterior e não fala em ferramenta que não existe", () => {
    const e = { ...estadoCom(cidadeECnh()), notaAnterior: 'Roteiro "Cadastro" — cidade: Campinas' };
    const bloco = renderBlocoDeAtendimento(e);
    expect(bloco).toContain('Contexto do atendimento anterior: Roteiro "Cadastro" — cidade: Campinas');
    expect(bloco).not.toContain("flow_collect");
    expect(renderBlocoDeAtendimento(estadoCom(cidadeECnh()))).not.toContain("Contexto do atendimento anterior");
  });
});
