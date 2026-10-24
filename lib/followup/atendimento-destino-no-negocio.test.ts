/**
 * #3363 — DESTINO DA GRAVAÇÃO DA RESPOSTA DO ROTEIRO DE ATENDIMENTO.
 *
 * Três cenários, um por critério de aceite, e a prova do quarto (os campos
 * obrigatórios da etapa do funil enxergarem o valor):
 *
 *   A — `destino: 'negocio'` grava em `crm_leads.custom_fields` e NÃO toca em
 *       `contacts.custom_fields` (o card é atualizado em memória pelo dublê, e
 *       é do card que `validaCamposExigidos` lê);
 *   B — o mesmo contato num SEGUNDO negócio é perguntado de novo: a régua "já
 *       respondido" lê o card ABERTO, não o histórico do contato (que é onde o
 *       código de hoje gravaria e por isso pulava a pergunta);
 *   C — `destino` ausente (todo grafo existente) continua lendo e gravando em
 *       `contacts.custom_fields`, byte a byte, e nem paga a leitura do card.
 *
 * A escrita é testada nos DOIS caminhos do roteiro: o leitor do VALIDADOR (várias
 * respostas por mensagem) e a captura determinística (a pergunta pendente lida
 * sozinha pelo motor).
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";

import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";

import {
  carregarEstadoDeAtendimento,
  mapearChecklist,
  processarInboundDoFluxo,
  situacaoDoChecklist,
  valoresDoChecklist,
  type ChecklistDeAtendimento,
  type EstadoDeAtendimento,
} from "./atendimento";
import { collectConfigSchema, type FlowEdge, type FlowGraph, type FlowNode } from "./graph-schema";

const ORG = "org-A";
const CONTATO = "ct";
const ETAPA = "11111111-2222-4333-8444-555555555555";

// ─── construção do grafo (mesmos helpers do atendimento.test.ts) ──────────────

function no(node: Partial<FlowNode> & Pick<FlowNode, "id" | "type" | "config">): FlowNode {
  return { label: node.id, position: { x: 0, y: 0 }, ...node } as FlowNode;
}

function aresta(source: string, target: string): FlowEdge {
  return { id: `${source}-${target}`, source, target, priority: 0, condition: { type: "always" } };
}

const trigger = () => no({ id: "t", type: "trigger", config: {} });
const end = () => no({ id: "e", type: "end", config: { outcome: "converted" } });

type ConfigDaPergunta = Extract<FlowNode, { type: "collect" }>["config"];

function pergunta(key: string, config: Partial<ConfigDaPergunta> = {}): FlowNode {
  const cfg: ConfigDaPergunta = {
    key,
    label: key,
    type: "text",
    required: true,
    permite_correcao: true,
    ...config,
  };
  return no({ id: `c-${key}`, type: "collect", config: cfg });
}

function checklist(g: FlowGraph): ChecklistDeAtendimento {
  const r = mapearChecklist(g);
  if (!r.ok) throw new Error(r.erro);
  return r.checklist;
}

/** Um roteiro de UMA pergunta (`trigger → pergunta → fim`) com o destino pedido. */
function grafoDe(key: string, destino?: "contato" | "negocio"): FlowGraph {
  return {
    nodes: [trigger(), pergunta(key, destino ? { destino } : {}), end()],
    edges: [aresta("t", `c-${key}`), aresta(`c-${key}`, "e")],
  } as FlowGraph;
}

const roteiroDe = (key: string, destino?: "contato" | "negocio") =>
  checklist(grafoDe(key, destino));

function estadoCom(
  chk: ChecklistDeAtendimento,
  valores: Record<string, string> = {},
  tentativas: Record<string, number> = {},
): EstadoDeAtendimento {
  return {
    enrollment: {
      id: "enr-A",
      pointer_id: "ptr-A",
      version_id: "ver-A",
      contact_id: CONTATO,
      current_node_id: "t",
      status: "coletando",
    },
    nomeDoFluxo: "Qualificação",
    checklist: chk,
    valores,
    tentativas,
    perguntasFeitas: new Set(
      chk.passos.flatMap((p) => (p.kind === "collect" ? [p.node.config.key] : [])),
    ),
    maxTentativas: 3,
    situacao: situacaoDoChecklist(chk, new Set(Object.keys(valores)), {
      tentativas,
      maxTentativas: 3,
    }),
  };
}

// ─── dublê de gravação ───────────────────────────────────────────────────────

/**
 * Registra os SQLs e APLICA a gravação no card em memória (`card`), que é como
 * o teste prova que o valor parou em `crm_leads.custom_fields`: quem lê o card
 * depois — `validaCamposExigidos` — enxerga o que o roteiro gravou.
 * `card: null` = o contato não tem negócio aberto.
 */
function poolGravacao(
  opts: { card: Record<string, unknown> | null; contatoAnonimizado?: boolean } = { card: {} },
) {
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
    if (/update crm_leads/.test(sql)) {
      if (opts.card === null) return { rows: [], rowCount: 0 };
      opts.card[values[2] as string] = values[3];
      return { rows: [], rowCount: 1 };
    }
    if (/update followup_enrollments/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const eventos = () =>
    sqls
      .map((s, i) => ({ s, p: params[i]! }))
      .filter(({ s }) => /insert into followup_enrollment_events/.test(s))
      .map(({ p }) => ({
        tipo: p[3] as string,
        payload: JSON.parse(p[4] as string) as Record<string, unknown>,
      }));
  return { pool: { query } as unknown as pg.Pool, sqls, params, eventos };
}

// ─── dublê de leitura (carregarEstadoDeAtendimento) ──────────────────────────

function poolLeitura(opts: {
  graph: unknown;
  camposDoContato: Record<string, unknown>;
  card: { id: string; custom_fields: Record<string, unknown> } | null;
}) {
  const sqls: string[] = [];
  const query = async (sql: string) => {
    sqls.push(sql);
    if (/e\.status = 'coletando'/.test(sql)) {
      return {
        rows: [
          {
            id: "enr-A",
            pointer_id: "ptr-A",
            version_id: "ver-A",
            contact_id: CONTATO,
            current_node_id: "t",
            status: "coletando",
            nome: "Qualificação",
            graph: opts.graph,
          },
        ],
        rowCount: 1,
      };
    }
    if (/e\.status = 'completed'/.test(sql)) return { rows: [], rowCount: 0 };
    if (/select custom_fields from contacts/.test(sql)) {
      return { rows: [{ custom_fields: opts.camposDoContato }], rowCount: 1 };
    }
    if (/from crm_leads/.test(sql)) {
      return { rows: opts.card === null ? [] : [opts.card], rowCount: opts.card === null ? 0 : 1 };
    }
    if (/followup_enrollment_events/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as pg.Pool, sqls };
}

const carregar = (pool: pg.Pool) =>
  carregarEstadoDeAtendimento(pool, { organizationId: ORG, contactId: CONTATO });

// ─────────────────────────────────────────────────────────────────────────────

describe("destino no schema do nó collect (#3363)", () => {
  it("a AUSÊNCIA da chave é `contato` e não é injetada no grafo", () => {
    const r = collectConfigSchema.safeParse({ key: "cidade", label: "Cidade" });
    expect(r.success).toBe(true);
    if (r.success) expect("destino" in r.data).toBe(false);
  });

  it("aceita `negocio` e recusa destino que não existe", () => {
    expect(
      collectConfigSchema.safeParse({ key: "cidade", label: "C", destino: "negocio" }).success,
    ).toBe(true);
    expect(
      collectConfigSchema.safeParse({ key: "cidade", label: "C", destino: "loja" }).success,
    ).toBe(false);
  });
});

describe("cenário A — destino negócio grava no card e NÃO no contato", () => {
  it("pelo leitor do validador: o SQL é de `crm_leads` e nenhum `update contacts` sai", async () => {
    const card: Record<string, unknown> = {};
    const { pool, sqls, params, eventos } = poolGravacao({ card });
    const r = await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(roteiroDe("destino_viagem", "negocio")),
      texto: "quero viajar para Cancun",
      messageId: "m1",
      validacoes: [{ campo: "destino_viagem", valor: "Cancun" }],
    });

    expect(r.concluiu).toBe(true);
    const i = sqls.findIndex((s) => /update crm_leads/.test(s));
    expect(i, "a resposta precisa ir para o card").toBeGreaterThanOrEqual(0);
    expect(sqls[i]).toMatch(/status = 'open'/);
    expect(sqls[i]).toMatch(/order by updated_at desc/);
    expect(params[i]).toEqual([ORG, CONTATO, "destino_viagem", "Cancun"]);
    expect(sqls.some((s) => /update contacts/.test(s))).toBe(false);
    expect(card).toEqual({ destino_viagem: "Cancun" });
    expect(eventos().map((e) => e.tipo)).toEqual([
      "roteiro_mensagem",
      "roteiro_resposta",
      "roteiro_concluido",
    ]);
  });

  it("pela captura determinística (pergunta de DATA): mesmo destino, mesmo card", async () => {
    const card: Record<string, unknown> = {};
    const { pool, sqls } = poolGravacao({ card });
    const g: FlowGraph = {
      nodes: [trigger(), pergunta("data_ida", { type: "date", destino: "negocio" }), end()],
      edges: [aresta("t", "c-data_ida"), aresta("c-data_ida", "e")],
    } as FlowGraph;
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(checklist(g)),
      texto: "dia 12/03/2027",
      messageId: "m1",
    });

    expect(sqls.some((s) => /update crm_leads/.test(s))).toBe(true);
    expect(sqls.some((s) => /update contacts/.test(s))).toBe(false);
    expect(card).toEqual({ data_ida: "2027-03-12" });
  });

  it("sem card aberto não há onde gravar: nada é gravado (nem no contato)", async () => {
    const { pool, sqls } = poolGravacao({ card: null });
    const r = await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(roteiroDe("destino_viagem", "negocio")),
      texto: "Cancun",
      messageId: "m1",
      validacoes: [{ campo: "destino_viagem", valor: "Cancun" }],
    });
    expect(r.concluiu).toBe(false);
    expect(sqls.some((s) => /update contacts/.test(s))).toBe(false);
    expect(sqls.some((s) => /update crm_leads/.test(s))).toBe(true);
  });

  it("campos obrigatórios da etapa do funil ENXERGAM o valor gravado no card", async () => {
    const card: Record<string, unknown> = {};
    const { pool } = poolGravacao({ card });
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(roteiroDe("destino_viagem", "negocio")),
      texto: "Cancun",
      messageId: "m1",
      validacoes: [{ campo: "destino_viagem", valor: "Cancun" }],
    });

    // O MESMO lead que a rota de movimentação lê de `crm_leads`, com a mesma
    // configuração de funil que `obrigatorio_em` declara.
    const settingsDoFunil = {
      fields: [
        {
          key: "destino_viagem",
          label: "Destino",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA] },
        },
      ],
    };
    const semValor = validaCamposExigidos({
      lead: { custom_fields: {} },
      settingsDoFunil,
      destino: { stageId: ETAPA },
    });
    expect(semValor.faltando.map((f) => f.chave)).toEqual(["destino_viagem"]);

    const comValor = validaCamposExigidos({
      lead: { custom_fields: card },
      settingsDoFunil,
      destino: { stageId: ETAPA },
    });
    expect(comValor.faltando).toEqual([]);
  });
});

describe("cenário B — o campo é perguntado de novo a cada negócio", () => {
  const graph = grafoDe("destino_viagem", "negocio");

  it("no MESMO negócio, o valor do card conta como respondido", async () => {
    const { pool } = poolLeitura({
      graph,
      camposDoContato: {},
      card: { id: "lead-1", custom_fields: { destino_viagem: "Cancun" } },
    });
    const estado = await carregar(pool);
    expect(estado).not.toBeNull();
    expect(estado!.valores).toEqual({ destino_viagem: "Cancun" });
    expect(estado!.situacao.pendentes).toEqual([]);
    expect(estado!.situacao.completo).toBe(true);
  });

  it("SEGUNDO negócio do mesmo contato: o histórico no contato não vale — pergunta de novo", async () => {
    // O código de HOJE gravaria o destino do negócio 1 em `contacts.custom_fields`
    // e pularia a pergunta para sempre. É exatamente isto que o cenário B veda.
    const { pool, sqls } = poolLeitura({
      graph,
      camposDoContato: { destino_viagem: "Cancun" },
      card: { id: "lead-2", custom_fields: {} },
    });
    const estado = await carregar(pool);
    expect(estado).not.toBeNull();
    expect(estado!.valores).toEqual({});
    expect(estado!.situacao.pendentes.map((n) => n.config.key)).toEqual(["destino_viagem"]);
    expect(estado!.situacao.completo).toBe(false);
    // O card ABERTO (o novo) é a fonte — e ele foi lido.
    expect(sqls.some((s) => /from crm_leads/.test(s) && /status = 'open'/.test(s))).toBe(true);
  });

  it("contato sem card aberto: a pergunta de negócio segue pendente (não lê o histórico)", async () => {
    const { pool } = poolLeitura({
      graph,
      camposDoContato: { destino_viagem: "Cancun" },
      card: null,
    });
    const estado = await carregar(pool);
    expect(estado).not.toBeNull();
    expect(estado!.valores).toEqual({});
    expect(estado!.situacao.pendentes.map((n) => n.config.key)).toEqual(["destino_viagem"]);
  });
});

describe("cenário C — destino contato é o comportamento de hoje, byte a byte", () => {
  it("grava em `contacts.custom_fields` com o MESMO SQL de sempre e não toca no card", async () => {
    const { pool, sqls, params } = poolGravacao({ card: {} });
    await processarInboundDoFluxo(pool, {
      organizationId: ORG,
      estado: estadoCom(roteiroDe("cidade")),
      texto: "Campinas",
      messageId: "m1",
      validacoes: [{ campo: "cidade", valor: "Campinas" }],
    });
    const i = sqls.findIndex((s) => /update contacts/.test(s));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(sqls[i]).toMatch(/custom_fields = coalesce\(custom_fields, '\{\}'::jsonb\) \|\|/);
    expect(sqls[i]).toMatch(/where organization_id = \$1 and id = \$2/);
    expect(params[i]).toEqual([ORG, CONTATO, "cidade", "Campinas"]);
    expect(sqls.some((s) => /update crm_leads/.test(s))).toBe(false);
  });

  it("lê o valor que o contato já tem e NEM PAGA a leitura do card", async () => {
    const { pool, sqls } = poolLeitura({
      graph: grafoDe("cidade"),
      camposDoContato: { cidade: "Campinas" },
      card: { id: "lead-1", custom_fields: { cidade: "São Paulo" } },
    });
    const estado = await carregar(pool);
    expect(estado).not.toBeNull();
    expect(estado!.valores).toEqual({ cidade: "Campinas" });
    expect(estado!.situacao.pendentes).toEqual([]);
    expect(sqls.some((s) => /from crm_leads/.test(s))).toBe(false);
  });

  it("a fonte de cada pergunta fica separada (roteiro misto lê as duas)", () => {
    const g: FlowGraph = {
      nodes: [
        trigger(),
        pergunta("cidade"),
        pergunta("destino_viagem", { destino: "negocio" }),
        end(),
      ],
      edges: [
        aresta("t", "c-cidade"),
        aresta("c-cidade", "c-destino_viagem"),
        aresta("c-destino_viagem", "e"),
      ],
    } as FlowGraph;
    const chk = checklist(g);
    expect(valoresDoChecklist(chk, { cidade: "Campinas", destino_viagem: "São Paulo" })).toEqual({
      cidade: "Campinas",
    });
    expect(valoresDoChecklist(chk, { cidade: "Campinas" }, { destino_viagem: "Cancun" })).toEqual({
      cidade: "Campinas",
      destino_viagem: "Cancun",
    });
  });
});
