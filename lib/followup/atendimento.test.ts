import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import {
  escolherFluxoDoTurno,
  escolherFluxoPelaEtapa,
  escolherFluxoPeloGatilho,
  finalizarFluxoDeAtendimento,
  iniciarFluxoDeAtendimento,
  podeComecarParaOContato,
  mapearChecklist,
  melhorFluxoPorGatilho,
  montarResumoDoRoteiro,
  processarInboundDoFluxo,
  encerrarRoteirosVencidos,
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
  // Padrão: toda pergunta já foi feita (o turno comum). `new Set()` = nenhuma.
  perguntasFeitas: ReadonlySet<string> = new Set(
    checklist.passos.flatMap((p) => (p.kind === "collect" ? [p.node.config.key] : [])),
  ),
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
    perguntasFeitas,
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

  it("RESPOSTA TARDIA (#1130, @vgamkt): pergunta ESGOTADA aceita o valor que o validador leu", async () => {
    // `cidade` no teto (3 de 3) = esgotada; `cnh` segue pendente.
    const { pool, sqls, params, eventos } = poolFake();
    const estado = estadoCom(cidadeECnh(), {}, { cidade: 3 });
    expect(estado.situacao.esgotadas.map((n) => n.config.key)).toEqual(["cidade"]);

    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado,
      texto: "ah, eu moro em Campinas",
      messageId: "m1",
      validacoes: [{ campo: "cidade", valor: "Campinas" }],
    });

    const i = sqls.findIndex((s) => /update contacts/.test(s));
    expect(i, "o valor tardio precisa ser gravado no contato").toBeGreaterThanOrEqual(0);
    expect(params[i]).toEqual([ORG, "ct", "cidade", "Campinas"]);
    expect(eventos().map((e) => e.tipo)).toContain("roteiro_resposta");
  });

  it("controle: campo fora do roteiro continua descartado", async () => {
    const { pool, sqls } = poolFake();
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(cidadeECnh(), {}, { cidade: 3 }),
      texto: "meu cpf é 529.982.247-25",
      messageId: "m1",
      validacoes: [{ campo: "cpf", valor: "52998224725" }],
    });
    expect(sqls.some((s) => /update contacts/.test(s))).toBe(false);
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

describe("encerrarRoteirosVencidos (prazo, 0397)", () => {
  it("chama a função do banco com o lote e devolve quantos encerrou", async () => {
    const rpc = vi.fn(async () => ({ data: 3, error: null }));
    expect(await encerrarRoteirosVencidos({ rpc }, 50)).toBe(3);
    expect(rpc).toHaveBeenCalledWith("fn_encerrar_roteiros_vencidos", { p_limite: 50 });
  });

  it("erro do banco sobe — quem chama loga, não engole calado", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "permission denied" } }));
    await expect(encerrarRoteirosVencidos({ rpc })).rejects.toThrow("permission denied");
  });
});

describe("pergunta que não foi feita (revisão adversarial do PR 2)", () => {
  const cnh = () =>
    lista(
      [trigger("t"), no({ id: "c1", type: "collect", config: { key: "tem_cnh", label: "Tem CNH", type: "boolean", required: true, permite_correcao: true } }), end("e")],
      [aresta("t", "c1"), aresta("c1", "e")],
    );

  it('"sim" sem a pergunta feita: nem resposta, nem tentativa', async () => {
    const { pool, sqls, eventos } = poolFake();
    const r = await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(cnh(), {}, {}, new Set()),
      texto: "sim",
      messageId: "m1",
    });
    expect(r.concluiu).toBe(false);
    expect(sqls.some((q) => /update contacts/.test(q))).toBe(false);
    expect(eventos().map((e) => e.tipo)).toEqual(["roteiro_mensagem"]);
  });

  it('com a pergunta feita, o mesmo "sim" responde', async () => {
    const { pool, sqls } = poolFake();
    await processarInboundDoFluxo(pool, { organizationId: ORG, estado: estadoCom(cnh()), texto: "sim", messageId: "m1" });
    expect(sqls.some((q) => /update contacts/.test(q))).toBe(true);
  });
});


// #1130 (@vgamkt), decisão do doc 69 (b): cada roteiro escolhe se recomeça para
// quem já o concluiu; o padrão é NÃO. Antes, repetir a palavra-gatilho reabria
// um cadastro já respondido.
describe("roteiro já concluído: recomeça só se o roteiro permitir", () => {
  const grafoCom = (settings?: Record<string, unknown>) =>
    ({
      ...grafo(
        [trigger("t"), collect("c1", "cidade"), end("e")],
        [aresta("t", "c1"), aresta("c1", "e")],
      ),
      ...(settings ? { settings: { max_tentativas_pergunta: 3, ...settings } } : {}),
    }) as FlowGraph;

  it("regra pura: padrão não recomeça; `pode_recomecar` libera; quem nunca concluiu sempre começa", () => {
    expect(podeComecarParaOContato(undefined, false)).toBe(true);
    expect(podeComecarParaOContato(undefined, true)).toBe(false);
    expect(podeComecarParaOContato({ max_tentativas_pergunta: 3 }, true)).toBe(false);
    expect(podeComecarParaOContato({ max_tentativas_pergunta: 3, pode_recomecar: true }, true)).toBe(true);
  });

  function bancoDoGatilho(linhas: Array<{ id: string; nome: string; graph: FlowGraph; ja_concluiu: boolean }>) {
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        chamadas.push({ sql, params });
        return { rows: linhas, rowCount: linhas.length };
      },
    } as unknown as pg.Pool;
    return { pool, chamadas };
  }

  it("gatilho: o roteiro concluído sai da disputa e a palavra vai para o outro", async () => {
    const { pool, chamadas } = bancoDoGatilho([
      { id: "cadastro", nome: "Cadastro", graph: { ...grafoCom(), settings: { max_tentativas_pergunta: 3, gatilhos: ["quero"] } } as FlowGraph, ja_concluiu: true },
      { id: "agenda", nome: "Agenda", graph: { ...grafoCom(), settings: { max_tentativas_pergunta: 3, gatilhos: ["quero"] } } as FlowGraph, ja_concluiu: false },
    ]);
    const r = await escolherFluxoPeloGatilho(pool, { organizationId: ORG, contactId: "ct-1", texto: "quero" });
    expect(r?.id).toBe("agenda");
    // O "já concluiu" é do CONTATO desta mensagem, na organização dela.
    expect(chamadas[0]!.params).toEqual([ORG, "ct-1"]);
    expect(chamadas[0]!.sql).toMatch(/e\.contact_id = \$2/);
    expect(chamadas[0]!.sql).toMatch(/e\.status = 'completed'/);
    // ...e do MESMO roteiro: sem isto, concluir QUALQUER roteiro tiraria todos da disputa.
    expect(chamadas[0]!.sql).toMatch(/e\.pointer_id = p\.id/);
  });

  it("gatilho: com `pode_recomecar`, o roteiro concluído volta a ganhar a palavra", async () => {
    const { pool } = bancoDoGatilho([
      { id: "agenda", nome: "Agenda", graph: { ...grafoCom(), settings: { max_tentativas_pergunta: 3, gatilhos: ["agendar"], pode_recomecar: true } } as FlowGraph, ja_concluiu: true },
    ]);
    const r = await escolherFluxoPeloGatilho(pool, { organizationId: ORG, contactId: "ct-1", texto: "quero agendar" });
    expect(r?.id).toBe("agenda");
  });

  // #2630 — A ENTRADA POR ETAPA DO FUNIL (irmã da entrada por palavra-gatilho).
  const ETAPA_X = "11111111-1111-4111-8111-111111111111";
  const ETAPA_Y = "22222222-2222-4222-8222-222222222222";
  /** A entrada do card na etapa, fixa: o dublê não pode depender do relógio. */
  const ENTRADA = "2026-10-01T10:00:00.000Z";
  const ANTES_DA_ENTRADA = "2026-09-01T10:00:00.000Z";
  const DEPOIS_DA_ENTRADA = "2026-10-02T10:00:00.000Z";

  /**
   * O banco da entrada por etapa: a etapa do CARD do contato (com a ENTRADA
   * nela) + os roteiros ativos + os enrollments já nascidos do contato.
   *
   * O `ultimo_nascimento` é calculado aqui aplicando SÓ o que o SQL escreve —
   * mesma doutrina do dublê do encadeamento A→B, abaixo: se o subselect do
   * nascimento sumir da consulta (ou o filtro de status, no card), este dublê
   * deixa de barrar o roteiro e o caso novo fica VERMELHO.
   */
  function bancoDaEtapa(
    etapa: string | null,
    linhas: Array<{ id: string; nome: string; graph: FlowGraph; ja_concluiu: boolean }>,
    opts: {
      /** `crm_leads.stage_changed_at` — o carimbo da 0071. `null` = sem carimbo. */
      stageChangedAt?: string | Date | null;
      /** `crm_leads.created_at` — a reserva do card criado direto na etapa. */
      createdAt?: string | Date | null;
      /** `crm_leads.status` — o card FECHADO (ganho/perdido) pode ficar na etapa. */
      status?: string;
      /** Enrollments já nascidos: (roteiro, quando nasceu). */
      enrollments?: Array<{ pointer_id: string; started_at: string | Date }>;
    } = {},
  ) {
    const stageChangedAt = opts.stageChangedAt === undefined ? ENTRADA : opts.stageChangedAt;
    const createdAt = opts.createdAt === undefined ? ENTRADA : opts.createdAt;
    const status = opts.status ?? "open";
    const enrollments = opts.enrollments ?? [];
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        chamadas.push({ sql, params });
        if (/from crm_leads/.test(sql)) {
          // O filtro de status é do SQL: sem `status = 'open'` o card fechado
          // volta a ligar o roteiro — e o caso do card ganho/perdido fica VERMELHO.
          const soAberto = /status = 'open'/.test(sql);
          if (etapa === null || (soAberto && status !== "open")) return { rows: [], rowCount: 0 };
          return {
            rows: [{ stage_id: etapa, stage_changed_at: stageChangedAt, created_at: createdAt }],
            rowCount: 1,
          };
        }
        if (/from followup_flow_pointers p/.test(sql)) {
          // O NASCIMENTO mais recente do roteiro para o contato (#3253), quando o
          // SELECT o pede: a comparação com a entrada do card é de
          // `entradaJaGasta`, e sem o subselect nada gasta a entrada.
          const pedeNascimento = /max\(e\.started_at\)/.test(sql);
          const linhasDaEntrada = linhas.map((l) => {
            const doRoteiro = enrollments
              .filter((e) => e.pointer_id === l.id)
              .map((e) => e.started_at)
              .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
            return {
              ...l,
              ultimo_nascimento: pedeNascimento ? (doRoteiro.at(-1) ?? null) : null,
            };
          });
          return { rows: linhasDaEntrada, rowCount: linhasDaEntrada.length };
        }
        return { rows: linhas, rowCount: linhas.length };
      },
    } as unknown as pg.Pool;
    return { pool, chamadas };
  }

  const porEtapa = (...etapas: string[]) =>
    ({ max_tentativas_pergunta: 3, etapas_do_funil: etapas }) as FlowGraph["settings"];

  it("etapa: o card na etapa do roteiro liga o roteiro, e a etapa é lida do CARD do contato", async () => {
    const { pool, chamadas } = bancoDaEtapa(ETAPA_X, [
      { id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
    ]);
    const r = await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" });
    expect(r).toEqual({ id: "proposta", nome: "Proposta" });
    // O card vem do contato DESTA organização, pela mesma leitura que o motor usa.
    expect(chamadas[0]!.params).toEqual([ORG, "ct-1"]);
    expect(chamadas[0]!.sql).toMatch(/from crm_leads/);
    expect(chamadas[0]!.sql).toMatch(/order by updated_at desc/);
    // E a disputa é entre roteiros da superfície de atendimento, ativos.
    expect(chamadas[1]!.sql).toMatch(/p\.surface = 'atendimento'/);
  });

  it("etapa: o card em OUTRA etapa não liga este roteiro", async () => {
    const { pool } = bancoDaEtapa(ETAPA_Y, [
      { id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
    ]);
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
  });

  it("etapa: contato sem card não liga nada — e nem paga a consulta dos roteiros", async () => {
    const { pool, chamadas } = bancoDaEtapa(null, [
      { id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
    ]);
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
    expect(chamadas).toHaveLength(1);
  });

  it("etapa: roteiro já concluído sai da disputa; com `pode_recomecar`, ele volta", async () => {
    const concluido = { id: "antigo", nome: "Antigo", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: true };
    // Sozinho e concluído: não liga (o padrão é não recomeçar).
    const semRecomeco = bancoDaEtapa(ETAPA_X, [concluido]);
    expect(await escolherFluxoPelaEtapa(semRecomeco.pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
    // Com `pode_recomecar`, liga.
    const comRecomeco = bancoDaEtapa(ETAPA_X, [
      { ...concluido, graph: { ...grafoCom(), settings: { ...porEtapa(ETAPA_X), pode_recomecar: true } } as FlowGraph },
    ]);
    expect((await escolherFluxoPelaEtapa(comRecomeco.pool, { organizationId: ORG, contactId: "ct-1" }))?.id).toBe("antigo");
  });

  it("etapa: dois roteiros na MESMA etapa — o desempate é o nome, não a ordem do banco", async () => {
    const { pool } = bancoDaEtapa(ETAPA_X, [
      { id: "z", nome: "Zebra", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
      { id: "a", nome: "Alfa", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
    ]);
    expect((await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" }))?.id).toBe("a");
  });

  // ─── A ENTRADA, e não o estado (#3253, revisão do mantenedor) ──────────────
  // "Começar quando o card ENTRAR na etapa": a etapa vale UMA VEZ POR ENTRADA.
  // A âncora da entrada é `stage_changed_at` (carimbo da 0071), com o
  // `created_at` de reserva para o card criado direto na etapa — o caso que o
  // mantenedor nomeou, em que não há movimento nenhum para carimbar.

  it("⭐ ENTRADA JÁ GASTA: o enrollment nascido depois de o card entrar na etapa tira o roteiro da disputa", async () => {
    const { pool, chamadas } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { enrollments: [{ pointer_id: "proposta", started_at: DEPOIS_DA_ENTRADA }] },
    );
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
    // A consulta lê a ENTRADA do card (os dois candidatos de âncora) e a leitura
    // dos roteiros ativos traz o NASCIMENTO mais recente de cada um, para o
    // par (contato, roteiro) — a comparação é de `entradaJaGasta`.
    expect(chamadas[0]!.sql).toMatch(/stage_changed_at/);
    expect(chamadas[0]!.sql).toMatch(/created_at/);
    expect(chamadas[1]!.sql).toMatch(/max\(e\.started_at\)/);
    expect(chamadas[1]!.sql).toMatch(/e\.pointer_id = p\.id/);
    expect(chamadas[1]!.params).toEqual([ORG, "ct-1"]);
  });

  it("entrada NOVA: enrollment nascido antes de o card voltar à etapa não gasta esta entrada", async () => {
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { enrollments: [{ pointer_id: "proposta", started_at: ANTES_DA_ENTRADA }] },
    );
    expect((await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" }))?.id).toBe("proposta");
  });

  it("⭐ com `pode_recomecar`, o card PARADO na etapa não rearma a cada turno: a entrada já foi gasta", async () => {
    // O roteiro está armado para recomeçar e o contato o concluiu — pela regra
    // do `pode_recomecar` ele voltaria; mas o enrollment desta entrada já
    // nasceu, então não há entrada nova para consumir.
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [
        {
          id: "agenda",
          nome: "Agenda",
          graph: { ...grafoCom(), settings: { ...porEtapa(ETAPA_X), pode_recomecar: true } } as FlowGraph,
          ja_concluiu: true,
        },
      ],
      { enrollments: [{ pointer_id: "agenda", started_at: DEPOIS_DA_ENTRADA }] },
    );
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
  });

  it("⭐ card criado DIRETO na etapa (sem `stage_changed_at`): a entrada é o `created_at` do card", async () => {
    const roteiro = {
      id: "proposta",
      nome: "Proposta",
      graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph,
      ja_concluiu: false,
    };
    // Enrollment nascido depois da criação: a entrada (a criação) já foi gasta.
    const depois = bancoDaEtapa(ETAPA_X, [roteiro], {
      stageChangedAt: null,
      createdAt: ENTRADA,
      enrollments: [{ pointer_id: "proposta", started_at: DEPOIS_DA_ENTRADA }],
    });
    expect(await escolherFluxoPelaEtapa(depois.pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
    // Enrollment nascido ANTES da criação não é desta entrada: o roteiro liga.
    const antes = bancoDaEtapa(ETAPA_X, [roteiro], {
      stageChangedAt: null,
      createdAt: ENTRADA,
      enrollments: [{ pointer_id: "proposta", started_at: ANTES_DA_ENTRADA }],
    });
    expect((await escolherFluxoPelaEtapa(antes.pool, { organizationId: ORG, contactId: "ct-1" }))?.id).toBe("proposta");
  });

  it("o carimbo da 0071 ganha do `created_at`: a entrada é o ÚLTIMO movimento do card", async () => {
    // Card criado em 01/09 e movido para a etapa em 01/10: um enrollment nascido
    // entre as duas datas é ANTERIOR à entrada e não a gasta.
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      {
        stageChangedAt: ENTRADA,
        createdAt: ANTES_DA_ENTRADA,
        enrollments: [{ pointer_id: "proposta", started_at: "2026-09-15T10:00:00.000Z" }],
      },
    );
    expect((await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" }))?.id).toBe("proposta");
  });

  it("⭐ o pg devolve `timestamptz` como Date: nascimento 500 ms depois da entrada, no MESMO segundo, já gasta a entrada", async () => {
    // A forma real do node-pg (sem parser customizado): Date, e não string ISO.
    // `Date.parse(Date)` passa pelo toString() e corta o ms — os dois instantes
    // empatavam, a entrada contava como não gasta e o roteiro reabria.
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [
        {
          id: "agenda",
          nome: "Agenda",
          graph: { ...grafoCom(), settings: { ...porEtapa(ETAPA_X), pode_recomecar: true } } as FlowGraph,
          ja_concluiu: true,
        },
      ],
      {
        stageChangedAt: new Date("2026-10-22T12:00:00.300Z"),
        enrollments: [{ pointer_id: "agenda", started_at: new Date("2026-10-22T12:00:00.800Z") }],
      },
    );
    expect(await escolherFluxoDoTurno(pool, { organizationId: ORG, contactId: "ct-1", texto: "oi, tudo bem?" })).toBeNull();
  });

  it("ACEITO e declarado: o card que JÁ ESTAVA na etapa quando a caixa foi marcada liga na mensagem seguinte", async () => {
    // Entrada antiga e nenhum enrollment depois dela: não há como distinguir
    // "entrou agora" de "estava lá quando o roteiro foi armado". A tela e o
    // changelog dizem isso ao operador (revisão do #3253, caso 3).
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { stageChangedAt: new Date("2026-01-01T00:00:00Z") },
    );
    expect(await escolherFluxoDoTurno(pool, { organizationId: ORG, contactId: "ct-1", texto: "oi" })).toEqual({
      id: "proposta",
      nome: "Proposta",
      origem: "etapa",
    });
  });

  it("etapa: card sem data de entrada legível — nada liga, e nenhum roteiro é consultado", async () => {
    const { pool, chamadas } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { stageChangedAt: null, createdAt: null },
    );
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
    expect(chamadas).toHaveLength(1);
  });

  // ─── O CARD FECHADO NÃO LIGA A PORTA DA ETAPA (#3253, detalhe do mantenedor) ─
  // Ganho ou perdido, o card pode ficar PARADO na etapa — e um negócio que já
  // terminou não pode armar o roteiro de atendimento.

  it("⭐ card GANHO parado na etapa não liga o roteiro — e a leitura dos roteiros nem acontece", async () => {
    const { pool, chamadas } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { status: "won" },
    );
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
    expect(await escolherFluxoDoTurno(pool, { organizationId: ORG, contactId: "ct-1", texto: "oi, tudo bem?" })).toBeNull();
    // A consulta olha o STATUS do card: o filtro é do SQL, e sem ele o card
    // fechado voltaria a ligar.
    expect(chamadas[0]!.sql).toMatch(/status = 'open'/);
  });

  it("⭐ card PERDIDO parado na etapa também não liga o roteiro", async () => {
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { status: "lost" },
    );
    expect(await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" })).toBeNull();
  });

  it("card ABERTO na mesma etapa segue ligando (o filtro não fechou a porta boa)", async () => {
    const { pool } = bancoDaEtapa(
      ETAPA_X,
      [{ id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false }],
      { status: "open" },
    );
    expect((await escolherFluxoPelaEtapa(pool, { organizationId: ORG, contactId: "ct-1" }))?.id).toBe("proposta");
  });

  // ─── UMA LEITURA POR TURNO (#3253, detalhe do mantenedor) ───────────────────
  // A palavra-gatilho e a etapa leem o MESMO conjunto de roteiros ativos; ler por
  // porta fazia o turno pagar a lista DUAS vezes sempre que a palavra não casava.

  it("⭐ palavra-gatilho que NÃO casa: a lista de roteiros ativos é lida uma vez só, e a etapa a reaproveita", async () => {
    const { pool, chamadas } = bancoDaEtapa(ETAPA_X, [
      { id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
    ]);
    const r = await escolherFluxoDoTurno(pool, { organizationId: ORG, contactId: "ct-1", texto: "oi, tudo bem?" });
    // A etapa decide, e as duas portas custaram UMA leitura de roteiros.
    expect(r).toEqual({ id: "proposta", nome: "Proposta", origem: "etapa" });
    expect(chamadas.filter((c) => /from followup_flow_pointers p/.test(c.sql))).toHaveLength(1);
    // A ordem é a declarada: a palavra-gatilho lê os roteiros, e só então o card.
    expect(chamadas[0]!.sql).toMatch(/from followup_flow_pointers p/);
    expect(chamadas[1]!.sql).toMatch(/from crm_leads/);
  });

  it("palavra-gatilho que casa: nenhum card é lido — o pedido explícito encerra a disputa", async () => {
    const { pool, chamadas } = bancoDaEtapa(ETAPA_X, [
      {
        id: "cadastro",
        nome: "Cadastro",
        graph: { ...grafoCom(), settings: { max_tentativas_pergunta: 3, gatilhos: ["quero"], etapas_do_funil: [ETAPA_X] } } as FlowGraph,
        ja_concluiu: false,
      },
    ]);
    const r = await escolherFluxoDoTurno(pool, { organizationId: ORG, contactId: "ct-1", texto: "quero" });
    expect(r).toEqual({ id: "cadastro", nome: "Cadastro", origem: "gatilho" });
    expect(chamadas.some((c) => /from crm_leads/.test(c.sql))).toBe(false);
  });

  it("contato sem card aberto: nenhuma leitura de roteiros é paga à toa", async () => {
    const { pool, chamadas } = bancoDaEtapa(null, [
      { id: "proposta", nome: "Proposta", graph: { ...grafoCom(), settings: porEtapa(ETAPA_X) } as FlowGraph, ja_concluiu: false },
    ]);
    const r = await escolherFluxoDoTurno(pool, { organizationId: ORG, contactId: "ct-1", texto: "oi, tudo bem?" });
    expect(r).toBeNull();
    // Uma leitura de roteiros (a da palavra-gatilho); a etapa não paga a dela.
    expect(chamadas.filter((c) => /from followup_flow_pointers p/.test(c.sql))).toHaveLength(1);
  });

  function bancoDoInicio(linha: { graph: FlowGraph; ja_concluiu: boolean }) {
    const sqls: string[] = [];
    const params: unknown[][] = [];
    const pool = {
      query: async (sql: string, p: unknown[] = []) => {
        sqls.push(sql);
        params.push(p);
        if (/select p\.active_version_id, v\.graph/.test(sql)) {
          return { rows: [{ active_version_id: "ver-1", ...linha }], rowCount: 1 };
        }
        if (/insert into followup_enrollments/.test(sql)) return { rows: [{ id: "enr-1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as pg.Pool;
    return { pool, sqls, params };
  }

  for (const origem of ["gatilho", "roteador", "encadeamento"] as const) {
    it(`início por ${origem}: contato que já concluiu NÃO recomeça no padrão`, async () => {
      const { pool, sqls, params } = bancoDoInicio({ graph: grafoCom(), ja_concluiu: true });
      const r = await iniciarFluxoDeAtendimento(pool, {
        organizationId: ORG,
        contactId: "ct-1",
        flowPointerId: "ptr-1",
        origem,
      });
      expect(r).toBeNull();
      expect(sqls.some((s) => /insert into followup_enrollments/.test(s))).toBe(false);
      expect(params[0]).toEqual([ORG, "ptr-1", "ct-1"]);
      expect(sqls[0]).toMatch(/e\.pointer_id = p\.id/);
    });
  }

  it("início: com `pode_recomecar`, recomeça", async () => {
    const { pool } = bancoDoInicio({ graph: grafoCom({ pode_recomecar: true }), ja_concluiu: true });
    const r = await iniciarFluxoDeAtendimento(pool, {
      organizationId: ORG,
      contactId: "ct-1",
      flowPointerId: "ptr-1",
      origem: "gatilho",
    });
    expect(r).toBe("enr-1");
  });

  it("início: quem nunca concluiu começa, no padrão", async () => {
    const { pool } = bancoDoInicio({ graph: grafoCom(), ja_concluiu: false });
    const r = await iniciarFluxoDeAtendimento(pool, {
      organizationId: ORG,
      contactId: "ct-1",
      flowPointerId: "ptr-1",
      origem: "gatilho",
    });
    expect(r).toBe("enr-1");
  });

  // Revisão da 2ª rodada: apagar `e.pointer_id = p.id` do `jaConcluiuSql` deixava
  // a suíte verde. O dublê abaixo guarda a tabela de enrollments e calcula o
  // `ja_concluiu` aplicando SÓ os predicados que o SQL escreve — sem o do
  // roteiro, o A recém-concluído conta como "B já concluído" e B é recusado.
  it("encadeamento A→B: B começa com A concluído (B sem `pode_recomecar`)", async () => {
    const enrollments = [{ id: "enr-A", pointer_id: "ptr-A", contact_id: "ct", status: "coletando" }];
    const grafoB = grafo([trigger("tB"), collect("cB", "outro"), end("eB")], [aresta("tB", "cB"), aresta("cB", "eB")]);
    const sqls: string[] = [];
    const query = async (sql: string, v: unknown[] = []) => {
      sqls.push(sql);
      if (/update followup_enrollments/.test(sql)) {
        for (const e of enrollments) if (e.id === v[1] && e.status === "coletando") e.status = "completed";
        return { rows: [], rowCount: 1 };
      }
      if (/select p\.active_version_id, v\.graph/.test(sql)) {
        const [, pointer, contato] = v;
        const ja_concluiu = enrollments.some(
          (e) =>
            (!/e\.pointer_id = p\.id/.test(sql) || e.pointer_id === pointer) &&
            (!/e\.contact_id = \$3/.test(sql) || e.contact_id === contato) &&
            (!/e\.status = 'completed'/.test(sql) || e.status === "completed"),
        );
        return { rows: [{ active_version_id: "ver-B", graph: grafoB, ja_concluiu }], rowCount: 1 };
      }
      if (/insert into followup_enrollments/.test(sql)) return { rows: [{ id: "enr-B" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const fimParaB = no({
      id: "e",
      type: "end",
      config: {
        outcome: "converted",
        ao_finalizar: { tipo: "proximo_fluxo", fluxo: "ptr-B" },
      } as Extract<FlowNode, { type: "end" }>["config"],
    });
    const r = await finalizarFluxoDeAtendimento({ query } as unknown as pg.Pool, {
      organizationId: ORG,
      estado: estadoCom(lista([trigger("t"), collect("c1", "cidade"), fimParaB], [aresta("t", "c1"), aresta("c1", "e")]), {
        cidade: "Campinas",
      }),
    });
    expect(enrollments[0]!.status).toBe("completed");
    expect(r.proximoEnrollmentId).toBe("enr-B");
    expect(sqls.some((s) => /insert into followup_enrollments/.test(s))).toBe(true);
  });
});
