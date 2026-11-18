/**
 * #3363 — A EXECUÇÃO DO ROTEIRO FICA LIGADA A UM CARD EXPLÍCITO E ESTÁVEL.
 *
 * Decisão do mantenedor (27/10, PR #3492): "a execução do roteiro deve ficar
 * ligada a um card explícito e preservar esse destino até terminar. Quando
 * houver vários candidatos, será exigida escolha; editar outro card não pode
 * redirecionar uma resposta."
 *
 * O que a versão anterior fazia — e que estes testes vedam — é escolher o card
 * por `updated_at` mais recente, em CADA leitura e CADA escrita:
 *
 *   (a) vínculo estável: começar com UM card aberto, abrir/editar OUTRO no meio
 *       da execução e responder — a resposta vai para o card do início, não
 *       para o editado por último;
 *   (b) ambiguidade exige escolha: com DOIS cards abertos desde o começo, nada
 *       é fixado, nada é gravado em card nenhum, e a tela recebe a escolha
 *       pendente com os candidatos — sem default silencioso;
 *   (c) um card só: ele é o candidato, e a tela NÃO pergunta;
 *   (d) fim da execução: uma execução nova resolve de novo e NÃO herda o
 *       vínculo da anterior;
 *   (e) concorrência: duas execuções não se contaminam, e duas tentativas de
 *       fixar o MESMO enrollment não trocam o destino já fixado (primeiro vence);
 *   (f) autoria preservada: a gravação não toca em `created_by` nem inventa
 *       atividade com outro autor.
 *
 * O dublê de banco emula o CONTRATO do Postgres — inclusive `order by
 * updated_at desc` devolvendo o card editado por último —, porque é isso que
 * faz o teste valer: com o código de antes, (a) e (b) falham por comportamento,
 * não por tipo.
 */
import { describe, expect, it } from "vitest";
import type pg from "pg";

import {
  carregarEstadoDeAtendimento,
  processarInboundDoFluxo,
  renderBlocoDeAtendimento,
  type EstadoDeAtendimento,
} from "./atendimento";
import type { FlowEdge, FlowGraph, FlowNode } from "./graph-schema";
import {
  fixarNegocioDoRoteiro,
  lerNegocioFixado,
  resumoDoNegocio,
  resolverVinculoDoNegocio,
  type CandidatoAoNegocio,
} from "./negocio-do-roteiro";

const ORG = "org-A";
const CONTATO = "ct";

// ─── grafo: um roteiro de uma pergunta, com o destino pedido ─────────────────

function no(node: Partial<FlowNode> & Pick<FlowNode, "id" | "type" | "config">): FlowNode {
  return { label: node.id, position: { x: 0, y: 0 }, ...node } as FlowNode;
}

function aresta(source: string, target: string): FlowEdge {
  return { id: `${source}-${target}`, source, target, priority: 0, condition: { type: "always" } };
}

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

function grafoDe(key: string, destino: "contato" | "negocio" = "negocio"): FlowGraph {
  return {
    nodes: [no({ id: "t", type: "trigger", config: {} }), pergunta(key, { destino }), no({ id: "e", type: "end", config: { outcome: "converted" } })],
    edges: [aresta("t", `c-${key}`), aresta(`c-${key}`, "e")],
  } as FlowGraph;
}

// ─── dublê de banco: `crm_leads` + trilha do roteiro ────────────────────────

interface CartaoFalso {
  id: string;
  titulo: string;
  custom_fields: Record<string, unknown>;
  aberto: boolean;
  /** Ordem de criação — o desempate determinístico dos candidatos. */
  criadoEm: number;
  /** É o que a versão ANTERIOR usava para escolher: o último editado. */
  atualizadoEm: number;
}

interface EventoFalso {
  enrollmentId: string;
  tipo: string;
  payload: Record<string, unknown>;
  chave: string | null;
}

function criarBanco(opts: {
  graph: FlowGraph;
  cartoes: CartaoFalso[];
  camposDoContato?: Record<string, unknown>;
  enrollmentId?: string;
}) {
  const cartoes = new Map(opts.cartoes.map((c) => [c.id, { ...c, custom_fields: { ...c.custom_fields } }]));
  const eventos: EventoFalso[] = [];
  const sqls: string[] = [];
  const params: unknown[][] = [];
  let relogio = 100;
  let enrollmentAtual = opts.enrollmentId ?? "enr-1";

  const abertos = () =>
    [...cartoes.values()].filter((c) => c.aberto).sort((a, b) => a.criadoEm - b.criadoEm || a.id.localeCompare(b.id));

  const fixadoDe = (enr: string): string | null => {
    const ev = eventos.find((e) => e.enrollmentId === enr && e.tipo === "roteiro_negocio");
    const lead = ev?.payload.lead_id;
    return typeof lead === "string" ? lead : null;
  };

  const aplicarGravacao = (leadId: string, campo: string, valor: string): number => {
    const cartao = cartoes.get(leadId);
    if (!cartao || !cartao.aberto) return 0;
    cartao.custom_fields[campo] = valor;
    cartao.atualizadoEm = ++relogio;
    return 1;
  };

  const query = async (sql: string, values: unknown[] = []) => {
    sqls.push(sql);
    params.push(values);

    if (/insert into followup_enrollment_events/.test(sql)) {
      const chave = values[5] as string | null;
      const enrollment = values[1] as string;
      if (chave !== null && eventos.some((e) => e.enrollmentId === enrollment && e.chave === chave)) {
        return { rows: [], rowCount: 0 };
      }
      eventos.push({
        enrollmentId: enrollment,
        tipo: values[3] as string,
        payload: JSON.parse(values[4] as string) as Record<string, unknown>,
        chave,
      });
      return { rows: [], rowCount: 1 };
    }

    // O vínculo fixado desta execução.
    if (/event_type = 'roteiro_negocio'/.test(sql)) {
      const lead = fixadoDe(values[1] as string);
      return { rows: lead === null ? [] : [{ lead_id: lead }], rowCount: lead === null ? 0 : 1 };
    }

    // Candidatos: os cards ABERTOS, em ordem de criação.
    if (/select id, title/.test(sql)) {
      return { rows: abertos().map((c) => ({ id: c.id, title: c.titulo })), rowCount: abertos().length };
    }

    // A LEITURA da versão anterior: o card aberto de `updated_at` mais recente.
    if (/from crm_leads/.test(sql) && /order by updated_at desc/.test(sql)) {
      const maisRecente = [...cartoes.values()].filter((c) => c.aberto).sort((a, b) => b.atualizadoEm - a.atualizadoEm)[0];
      return { rows: maisRecente ? [{ id: maisRecente.id, custom_fields: maisRecente.custom_fields }] : [], rowCount: maisRecente ? 1 : 0 };
    }

    // A LEITURA nova: o card EXPLÍCITO do vínculo, pelo id.
    if (/select custom_fields[\s\S]*from crm_leads/.test(sql)) {
      const cartao = cartoes.get(values[1] as string);
      return { rows: cartao && cartao.aberto ? [{ custom_fields: cartao.custom_fields }] : [], rowCount: cartao && cartao.aberto ? 1 : 0 };
    }

    if (/e\.status = 'coletando'/.test(sql)) {
      return {
        rows: [
          {
            id: enrollmentAtual,
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
      return { rows: [{ custom_fields: opts.camposDoContato ?? {} }], rowCount: 1 };
    }
    if (/from followup_enrollment_events/.test(sql)) return { rows: [], rowCount: 0 };

    if (/update crm_leads/.test(sql)) {
      const campo = values[2] as string;
      const valor = values[3] as string;
      // A escrita da versão anterior: subconsulta por `updated_at`.
      if (/order by updated_at desc/.test(sql)) {
        const maisRecente = [...cartoes.values()].filter((c) => c.aberto).sort((a, b) => b.atualizadoEm - a.atualizadoEm)[0];
        if (!maisRecente) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: aplicarGravacao(maisRecente.id, campo, valor) };
      }
      return { rows: [], rowCount: aplicarGravacao(values[4] as string, campo, valor) };
    }
    if (/update contacts/.test(sql)) return { rows: [], rowCount: 1 };
    if (/update followup_enrollments/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  return {
    pool: { query } as unknown as pg.Pool,
    sqls,
    params,
    eventos,
    cartao: (id: string) => cartoes.get(id)!,
    abrirCartao: (cartao: Omit<CartaoFalso, "aberto" | "custom_fields" | "criadoEm" | "atualizadoEm">) => {
      cartoes.set(cartao.id, {
        ...cartao,
        aberto: true,
        custom_fields: {},
        criadoEm: relogio++,
        atualizadoEm: relogio++,
      });
    },
    fecharCartao: (id: string) => {
      const c = cartoes.get(id);
      if (c) c.aberto = false;
    },
    /** Qual execução o `carregarEstadoDeAtendimento` enxerga neste passo. */
    usarEnrollment: (id: string) => {
      enrollmentAtual = id;
    },
    /** O "alguém editou o card" do defeito: outro card fica o mais recente. */
    editar: (id: string) => {
      const c = cartoes.get(id);
      if (c) c.atualizadoEm = ++relogio;
    },
    fixadoDe,
  };
}

const cartaoDe = (id: string, titulo: string, campos: Record<string, unknown> = {}): CartaoFalso => ({
  id,
  titulo,
  custom_fields: campos,
  aberto: true,
  criadoEm: 1,
  atualizadoEm: 1,
});

const carregar = (pool: pg.Pool) =>
  carregarEstadoDeAtendimento(pool, { organizationId: ORG, contactId: CONTATO });

/** Responde a pergunta do roteiro pelo caminho do VALIDADOR (uma resposta por mensagem). */
const responder = (pool: pg.Pool, estado: EstadoDeAtendimento, valor: string, messageId = "m1") =>
  processarInboundDoFluxo(pool, {
    organizationId: ORG,
    estado,
    texto: valor,
    messageId,
    validacoes: [{ campo: "destino_viagem", valor }],
  });

// ─────────────────────────────────────────────────────────────────────────────

describe("(a) vínculo estável: editar outro card no meio da execução não redireciona a resposta", () => {
  it("a resposta vai para o card do INÍCIO, mesmo com outro card editado depois", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile")],
    });

    // Início da execução: UM card aberto ⇒ ele é o vínculo, e fica registrado.
    const inicio = await carregar(banco.pool);
    expect(inicio).not.toBeNull();
    expect(banco.fixadoDe("enr-1")).toBe("lead-A");
    expect(inicio!.negocio).toEqual({ tipo: "fixado", leadId: "lead-A", titulo: "Viagem Chile" });

    // O meio da execução: alguém edita OUTRO card do mesmo contato (o clássico
    // "último card editado" do defeito). Este card passa a ser o mais recente.
    banco.abrirCartao({ id: "lead-B", titulo: "Viagem Bahia" });
    banco.editar("lead-B");
    banco.editar("lead-B");

    // Turno seguinte: o estado é recarregado e a resposta é gravada.
    const turno = await carregar(banco.pool);
    expect(turno!.negocio).toEqual({ tipo: "fixado", leadId: "lead-A", titulo: "Viagem Chile" });
    const r = await responder(banco.pool, turno!, "Cancun");

    expect(r.concluiu).toBe(true);
    expect(banco.cartao("lead-A").custom_fields).toEqual({ destino_viagem: "Cancun" });
    expect(banco.cartao("lead-B").custom_fields).toEqual({});
    // O vínculo é fixado UMA vez: nem a recarga nem a gravação o reescrevem.
    expect(banco.eventos.filter((e) => e.tipo === "roteiro_negocio")).toHaveLength(1);
  });

  it("a LEITURA também não redireciona: o valor \"já respondido\" vem do card do vínculo", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile", { destino_viagem: "Cancun" })],
    });
    await carregar(banco.pool);
    banco.abrirCartao({ id: "lead-B", titulo: "Viagem Bahia" });
    banco.editar("lead-B");

    const turno = await carregar(banco.pool);
    expect(turno!.valores).toEqual({ destino_viagem: "Cancun" });
    expect(turno!.situacao.pendentes).toEqual([]);
  });
});

describe("(b) dois cards abertos: escolha obrigatória, sem default silencioso", () => {
  it("nada é fixado, nada é gravado em card nenhum, e o estado diz que falta escolha", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile"), cartaoDe("lead-B", "Viagem Bahia")],
    });

    const estado = await carregar(banco.pool);
    expect(estado!.negocio).toEqual({
      tipo: "ambiguo",
      candidatos: [
        { id: "lead-A", titulo: "Viagem Chile" },
        { id: "lead-B", titulo: "Viagem Bahia" },
      ],
    });
    expect(banco.fixadoDe("enr-1")).toBeNull();

    const r = await responder(banco.pool, estado!, "Cancun");
    expect(r.concluiu).toBe(false);
    expect(banco.cartao("lead-A").custom_fields).toEqual({});
    expect(banco.cartao("lead-B").custom_fields).toEqual({});
    expect(banco.fixadoDe("enr-1")).toBeNull();
  });

  it("o bloco do turno diz à IA que a escolha é de uma pessoa — não do cliente", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile"), cartaoDe("lead-B", "Viagem Bahia")],
    });
    const estado = await carregar(banco.pool);
    const bloco = renderBlocoDeAtendimento(estado!);
    expect(bloco).toContain("2 negócios abertos");
    expect(bloco).toContain("Viagem Chile");
    expect(bloco).toContain("Viagem Bahia");
    expect(bloco).toContain("não pergunte");
  });

  it("a tela recebe a escolha PENDENTE com os candidatos (sem escolha, sem lista)", () => {
    const candidatos: CandidatoAoNegocio[] = [
      { id: "lead-A", titulo: "Viagem Chile" },
      { id: "lead-B", titulo: "Viagem Bahia" },
    ];
    expect(resumoDoNegocio(candidatos, null)).toEqual({
      vinculo: null,
      candidatos,
      escolha_pendente: true,
    });
    expect(resumoDoNegocio(candidatos, "lead-B")).toEqual({
      vinculo: { id: "lead-B", titulo: "Viagem Bahia" },
      candidatos,
      escolha_pendente: false,
    });
  });
});

describe("(c) um card só: ele é o candidato e não se pergunta", () => {
  it("fica fixado, a tela não pede escolha e a resposta é gravada nele", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile")],
    });
    const estado = await carregar(banco.pool);
    expect(estado!.negocio).toEqual({ tipo: "fixado", leadId: "lead-A", titulo: "Viagem Chile" });

    const resumo = resumoDoNegocio([{ id: "lead-A", titulo: "Viagem Chile" }], "lead-A");
    expect(resumo.escolha_pendente).toBe(false);
    expect(renderBlocoDeAtendimento(estado!)).not.toContain("negócios abertos");

    await responder(banco.pool, estado!, "Cancun");
    expect(banco.cartao("lead-A").custom_fields).toEqual({ destino_viagem: "Cancun" });
  });
});

describe("(d) fim da execução: a próxima não herda o vínculo", () => {
  it("execução nova resolve de novo e fixa o card dela, não o da anterior", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile")],
    });
    await carregar(banco.pool);
    expect(banco.fixadoDe("enr-1")).toBe("lead-A");

    // A execução 1 terminou; o negócio dela foi ganho e outro abriu.
    banco.fecharCartao("lead-A");
    banco.abrirCartao({ id: "lead-C", titulo: "Viagem Peru" });

    banco.usarEnrollment("enr-2");
    const segunda = await carregar(banco.pool);
    expect(segunda!.negocio).toEqual({ tipo: "fixado", leadId: "lead-C", titulo: "Viagem Peru" });
    expect(banco.fixadoDe("enr-2")).toBe("lead-C");
    // O vínculo da primeira continua sendo dela — e só dela.
    expect(banco.fixadoDe("enr-1")).toBe("lead-A");

    // Com DOIS cards abertos na terceira, ela não herda nada de ninguém.
    banco.abrirCartao({ id: "lead-D", titulo: "Viagem Atacama" });
    banco.usarEnrollment("enr-3");
    const terceira = await carregar(banco.pool);
    expect(terceira!.negocio!.tipo).toBe("ambiguo");
    expect(banco.fixadoDe("enr-3")).toBeNull();
  });

  it("ler o vínculo de um enrollment que nunca fixou não devolve o de outro", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile")],
    });
    await fixarNegocioDoRoteiro(banco.pool, { organizationId: ORG, enrollmentId: "enr-1", leadId: "lead-A" });
    expect(await lerNegocioFixado(banco.pool, { organizationId: ORG, enrollmentId: "enr-1" })).toBe("lead-A");
    expect(await lerNegocioFixado(banco.pool, { organizationId: ORG, enrollmentId: "enr-2" })).toBeNull();
  });
});

describe("(e) concorrência: execuções não se contaminam e o primeiro vínculo vence", () => {
  it("duas execuções do mesmo contato gravam cada uma no SEU card", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile")],
    });
    await fixarNegocioDoRoteiro(banco.pool, { organizationId: ORG, enrollmentId: "enr-1", leadId: "lead-A" });
    banco.abrirCartao({ id: "lead-B", titulo: "Viagem Bahia" });
    await fixarNegocioDoRoteiro(banco.pool, { organizationId: ORG, enrollmentId: "enr-2", leadId: "lead-B" });

    banco.usarEnrollment("enr-1");
    const estado1 = (await carregar(banco.pool))!;
    banco.usarEnrollment("enr-2");
    const estado2 = (await carregar(banco.pool))!;
    expect(estado1.negocio).toEqual({ tipo: "fixado", leadId: "lead-A", titulo: "Viagem Chile" });
    expect(estado2.negocio).toEqual({ tipo: "fixado", leadId: "lead-B", titulo: "Viagem Bahia" });

    await responder(banco.pool, estado1, "Cancun");
    await responder(banco.pool, estado2, "Salvador", "m2");

    expect(banco.cartao("lead-A").custom_fields).toEqual({ destino_viagem: "Cancun" });
    expect(banco.cartao("lead-B").custom_fields).toEqual({ destino_viagem: "Salvador" });
  });

  it("duas tentativas simultâneas de fixar o MESMO enrollment: a primeira vence e não há troca", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile"), cartaoDe("lead-B", "Viagem Bahia")],
    });
    const [um, dois] = await Promise.all([
      fixarNegocioDoRoteiro(banco.pool, { organizationId: ORG, enrollmentId: "enr-1", leadId: "lead-A" }),
      fixarNegocioDoRoteiro(banco.pool, { organizationId: ORG, enrollmentId: "enr-1", leadId: "lead-B" }),
    ]);
    expect(um).toBe("lead-A");
    expect(dois).toBe("lead-A");
    expect(banco.fixadoDe("enr-1")).toBe("lead-A");
    expect(banco.eventos.filter((e) => e.tipo === "roteiro_negocio")).toHaveLength(1);
  });
});

describe("(f) autoria preservada", () => {
  it("a gravação no card não mexe em autoria e não inventa atividade", async () => {
    const banco = criarBanco({
      graph: grafoDe("destino_viagem"),
      cartoes: [cartaoDe("lead-A", "Viagem Chile")],
    });
    const estado = await carregar(banco.pool);
    await responder(banco.pool, estado!, "Cancun");

    const escrita = banco.sqls.find((s) => /update crm_leads/.test(s))!;
    expect(escrita).not.toMatch(/created_by|owner_user_id|owner_agent_id/);
    expect(banco.sqls.some((s) => /insert into crm_lead_activities/i.test(s))).toBe(false);
    // A trilha do roteiro guarda o id do card, nunca um "autor" novo.
    const eventoDoVinculo = banco.eventos.find((e) => e.tipo === "roteiro_negocio")!;
    expect(Object.keys(eventoDoVinculo.payload)).toEqual(["lead_id"]);
  });
});

describe("(zero cards) o passo diz o que fazer quando não há negócio aberto", () => {
  it("não fixa, não grava e o bloco explica que a pergunta não tem destino", async () => {
    const banco = criarBanco({ graph: grafoDe("destino_viagem"), cartoes: [] });
    const estado = await carregar(banco.pool);
    expect(estado!.negocio).toEqual({ tipo: "nenhum" });
    const bloco = renderBlocoDeAtendimento(estado!);
    expect(bloco).toContain("não tem negócio aberto");

    await responder(banco.pool, estado!, "Cancun");
    expect(banco.sqls.some((s) => /update crm_leads/.test(s))).toBe(false);
    expect(banco.sqls.some((s) => /update contacts/.test(s))).toBe(false);
  });
});

describe("resolverVinculoDoNegocio: a régua pura", () => {
  it("0 ⇒ nenhum, 1 ⇒ fixado, 2+ ⇒ ambíguo (nunca o mais recente)", () => {
    expect(resolverVinculoDoNegocio([])).toEqual({ tipo: "nenhum" });
    expect(resolverVinculoDoNegocio([{ id: "a", titulo: "A" }])).toEqual({ tipo: "fixado", leadId: "a", titulo: "A" });
    expect(
      resolverVinculoDoNegocio([
        { id: "a", titulo: "A" },
        { id: "b", titulo: "B" },
      ]),
    ).toEqual({
      tipo: "ambiguo",
      candidatos: [
        { id: "a", titulo: "A" },
        { id: "b", titulo: "B" },
      ],
    });
  });
});
