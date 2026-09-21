import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import { finalizarFluxoDeAtendimento, mapearChecklist, melhorFluxoPorGatilho, montarNotaDeConclusao, renderBlocoDeAtendimento, situacaoDoChecklist, type ChecklistDeAtendimento, type EstadoDeAtendimento } from "./atendimento";

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

describe("montarNotaDeConclusao (síntese do fluxo concluído)", () => {
  const built = mapearChecklist(
    grafo(
      [trigger("t"), collect("c1", "cidade"), collect("c2", "cnh"), end("e")],
      [aresta("t", "c1"), aresta("c1", "c2"), aresta("c2", "e")],
    ),
  );
  if (!built.ok) throw new Error("grafo de teste inválido");
  const lista = built.checklist;

  const estado = (valores: Record<string, string>): EstadoDeAtendimento => ({
    enrollment: {
      id: "enr",
      pointer_id: "ptr",
      version_id: "ver",
      contact_id: "ct",
      current_node_id: "n",
      status: "active",
    },
    nomeDoFluxo: "Qualificação",
    checklist: lista,
    valores,
    tentativas: {},
    maxTentativas: 3,
    situacao: situacaoDoChecklist(lista, new Set(Object.keys(valores))),
  });

  it("traz o nome do fluxo e os valores normalizados, na ordem das perguntas", () => {
    const nota = montarNotaDeConclusao(estado({ cidade: "Campinas", cnh: "true" }));
    expect(nota).toContain('Fluxo "Qualificação"');
    expect(nota).toContain("cidade: Campinas");
    expect(nota).toContain("cnh: true");
    expect(nota.indexOf("cidade:")).toBeLessThan(nota.indexOf("cnh:"));
  });

  it("marca o que NÃO foi respondido em vez de omitir (o próximo passo sabe o que ficou aberto)", () => {
    const nota = montarNotaDeConclusao(estado({ cidade: "Campinas" }));
    expect(nota).toContain("cnh: (não respondido)");
  });

  it("injeta a síntese do fluxo anterior no bloco do turno (passa-bastão)", () => {
    const comNota = { ...estado({ cidade: "Campinas" }), notaAnterior: 'Fluxo "Qualificação" — cidade: Campinas' };
    expect(renderBlocoDeAtendimento(comNota)).toContain(
      'Contexto do atendimento anterior: Fluxo "Qualificação" — cidade: Campinas',
    );
    // Sem nota anterior, o cabeçalho falso não aparece.
    expect(renderBlocoDeAtendimento(estado({ cidade: "Campinas" }))).not.toContain(
      "Contexto do atendimento anterior",
    );
  });
});

describe("finalizarFluxoDeAtendimento (conclusão + encadeamento da venda)", () => {
  const endCom = (ao: unknown) =>
    no({
      id: "e",
      type: "end",
      config: { outcome: "converted", ao_finalizar: ao } as Extract<
        FlowNode,
        { type: "end" }
      >["config"],
    }) as Extract<FlowNode, { type: "end" }>;

  function estadoComFim(ao: unknown, pointerId: string): EstadoDeAtendimento {
    const built = mapearChecklist(
      grafo(
        [trigger("t"), collect("c1", "cidade"), endCom(ao)],
        [aresta("t", "c1"), aresta("c1", "e")],
      ),
    );
    if (!built.ok) throw new Error("grafo de teste inválido");
    return {
      enrollment: {
        id: "enr-A",
        pointer_id: pointerId,
        version_id: "ver-A",
        contact_id: "ct",
        current_node_id: "c1",
        status: "active",
      },
      nomeDoFluxo: "Qualificação",
      checklist: built.checklist,
      valores: { cidade: "Campinas" },
      tentativas: {},
      maxTentativas: 3,
      situacao: situacaoDoChecklist(built.checklist, new Set(["cidade"])),
    };
  }

  /** Dublê de `pg.Pool`: registra SQL/parâmetros e responde por assinatura. */
  function poolFake() {
    const sqls: string[] = [];
    const params: unknown[][] = [];
    const query = async (sql: string, values: unknown[] = []) => {
      sqls.push(sql);
      params.push(values);
      if (/select p\.active_version_id, v\.graph/.test(sql)) {
        return {
          rows: [
            {
              active_version_id: "ver-B",
              graph: grafo(
                [trigger("tB"), collect("cB", "outro"), end("eB")],
                [aresta("tB", "cB"), aresta("cB", "eB")],
              ),
            },
          ],
        };
      }
      if (/insert into followup_enrollments/.test(sql)) return { rows: [{ id: "enr-B" }] };
      return { rows: [] };
    };
    return { pool: { query } as unknown as pg.Pool, sqls, params };
  }

  it("grava a síntese em completion_note e emite concluido", async () => {
    const { pool, sqls, params } = poolFake();
    await finalizarFluxoDeAtendimento(pool, {
      organizationId: "org",
      estado: estadoComFim({ tipo: "nada" }, "A"),
    });
    const update = sqls.findIndex((s) => /update followup_enrollments/.test(s));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(sqls[update]).toContain("completion_note");
    expect(params[update]).toContain('Fluxo "Qualificação" — cidade: Campinas');
    expect(sqls.some((s) => /insert into contact_flow_events/.test(s))).toBe(true);
  });

  it("encadeia o próximo fluxo e emite encadeou", async () => {
    const { pool, sqls } = poolFake();
    const r = await finalizarFluxoDeAtendimento(pool, {
      organizationId: "org",
      estado: estadoComFim({ tipo: "proximo_fluxo", fluxo: "B" }, "A"),
    });
    expect(r.proximoEnrollmentId).toBe("enr-B");
    expect(sqls.some((s) => /insert into followup_enrollments/.test(s))).toBe(true);
    expect(sqls.filter((s) => /insert into contact_flow_events/.test(s)).length).toBeGreaterThanOrEqual(2);
  });

  it("NÃO encadeia para si mesmo (evita laço sem fim)", async () => {
    const { pool, sqls } = poolFake();
    const r = await finalizarFluxoDeAtendimento(pool, {
      organizationId: "org",
      estado: estadoComFim({ tipo: "proximo_fluxo", fluxo: "A" }, "A"),
    });
    expect(r.proximoEnrollmentId).toBeNull();
    expect(sqls.some((s) => /insert into followup_enrollments/.test(s))).toBe(false);
  });
});

describe("processarInboundDoFluxo — estado já completo conclui e encadeia", () => {
  it("sem pendentes e completo: NÃO devolve cedo — fecha o fluxo (era o bug do teste ao vivo)", () => {
    const src = readFileSync(join(process.cwd(), "lib/followup/atendimento.ts"), "utf8");
    // O caminho `primeiro === undefined` precisa considerar `completo` e chamar
    // o finalizador; antes ele retornava direto e o enrollment ficava `active`.
    expect(src).toMatch(/if \(primeiro === undefined\) \{[\s\S]*estado\.situacao\.completo[\s\S]*finalizarFluxoDeAtendimento/);
  });
});

describe("idempotência do inbound do fluxo (retry de job não reprocessa)", () => {
  it("processarInboundDoFluxo corta por message_id já visto na trilha", () => {
    const src = readFileSync(join(process.cwd(), "lib/followup/atendimento.ts"), "utf8");
    // A checagem precisa existir ANTES de qualquer gravação e filtrar por
    // enrollment + message_id, contando eventos resposta/fora_do_fluxo.
    expect(src).toMatch(/from contact_flow_events[\s\S]*message_id = \$3[\s\S]*kind in \('resposta','fora_do_fluxo'\)/);
    expect(src).toMatch(/if \(\(ja\.rows\[0\]\?\.n \?\? 0\) > 0\) return \{ estado, concluiu: false \}/);
  });
});

describe("captura MULTI-campo (2026-09-21)", () => {
  it("aceita QUALQUER pendente, não só o primeiro (senão só o 1º campo é gravado)", () => {
    const src = readFileSync(join(process.cwd(), "lib/followup/atendimento.ts"), "utf8");
    // Medido ao vivo: o validador devolveu os 5 campos, mas a gravação só aceitou
    // `moto_troca` porque `ehPendente` comparava só com `pendentes[0]`.
    expect(src).toMatch(/const ehPendente = estado\.situacao\.pendentes\.some\(/);
  });
});

describe("auditoria 2026-09-19 — o nao_respondeu do validador cai no classificador puro", () => {
  it("distinguir aceno (conta tentativa) de desvio (não conta) preserva o teto", () => {
    const src = readFileSync(join(process.cwd(), "lib/followup/atendimento.ts"), "utf8");
    // O validador trata respostas/correções no bloco `validacoes`; o caminho SEM
    // validação decide pelo classificador puro (aceno conta tentativa; desvio não).
    // Antes era `: { resultado: "desviou" }`, e TODO nao_respondeu virava desvio —
    // "ok"/emoji nunca esgotavam a pergunta (max_tentativas_pergunta inerte).
    expect(src).toMatch(
      /if \(args\.validacoes !== undefined[\s\S]*classificarInbound\(comoCampoParaCaptura\(primeiro\), args\.texto\)/,
    );
    expect(src).not.toMatch(/:\s*\{ resultado: "desviou" as const \};/);
  });
});
