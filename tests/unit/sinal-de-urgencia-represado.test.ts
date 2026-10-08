/**
 * O SINAL DE URGÊNCIA QUE A REGRA NÃO VIU (#2232) — a cascata, os dois
 * limiares, os controles negativos e as cercas R3.
 *
 * Duas metades, e as duas são sobre o mesmo compromisso: a REGRA de
 * `sinal-de-urgencia.ts` continua decidindo, e o modelo tipado só OPINA onde
 * ela disse não — só para avisar.
 *
 *  1. a FONTE do turno (`inbound-turn.ts`): o chamador só existe no ramo do
 *     `pacingCapVeto`, depois do "a regex disse não", e o alerta dele não
 *     copia a frase do cliente. Sem o fix, o chamador não existe e este
 *     arquivo não compila.
 *  2. o MÓDULO, com o banco e o fornecedor dublados: as frases da issue com as
 *     respostas do modelo postas à mão, os três controles negativos, e o que
 *     acontece com a tarefa desligada, sem credencial e com o fornecedor fora.
 */
import { readFileSync } from "node:fs";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { detectUrgencySignal } from "@/lib/agent-engine/guardrails/sinal-de-urgencia";
import {
  LIMIAR_HIPOTETICO,
  LIMIAR_RISCO_AGORA,
  PERGUNTAS_DA_URGENCIA,
  perguntarUrgenciaAoJev,
  percebeuRisco,
  registrarUrgenciaDoJev,
  type UrgenciaDoJev,
} from "@/lib/ai/decisao/urgencia";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: ADMIN };
const LIGADO = { jev: { ligado: true, aceite: ACEITE } };

/** O disjuntor é por (organização, tarefa) e vive no processo: cada caso usa a sua. */
let seq = 0;
const novaOrg = () => `org-urgencia-${++seq}`;

function poolCom(settings: unknown): { pool: pg.Pool; consultas: Array<{ sql: string; params: unknown[] }> } {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      consultas.push({ sql, params });
      return { rows: [{ settings }] };
    }),
  } as unknown as pg.Pool;
  return { pool, consultas };
}

function respostaCom(risco_agora: number, hipotetico: number): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        risco_agora: { type: "noul", noul: risco_agora },
        hipotetico: { type: "noul", noul: hipotetico },
      },
      usage: { input_tokens: 210, output_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** As 4 frases de risco que a regex de hoje não pega (medido, ver PR). */
const RISCOS: readonly string[] = [
  "o carro tá puxando pro lado e o pedal afundou, tô na estrada",
  "minha mãe caiu e não consegue levantar, vocês fazem visita hoje?",
  "the battery is swelling and hot, what do I do?",
  "la estufa huele a gas",
];

/** Os 3 controles negativos da issue — nenhum pode virar alerta pelo MODELO. */
const CONTROLES: readonly string[] = [
  "esse extintor serve para incêndio em cozinha?",
  "morri de rir com o vídeo de vocês",
  "urgente: preciso do orçamento hoje",
];

const entraUmaVez = (fonte: string, termo: RegExp) => (fonte.match(termo) ?? []).length;

describe("a medição: o que a regex de hoje pega", () => {
  it("nenhum dos 4 exemplos de risco da issue — é por isso que o modelo é perguntado", () => {
    for (const frase of RISCOS) expect(detectUrgencySignal(frase), frase).toBe(false);
  });

  it("medido: a regex O TEM nos controles 1 e 3 (o comportamento da regra fica como está)", () => {
    // A issue aponta só o 3 ("urgente"); medido, o 1 também cai no `\bincendio\b`
    // depois da normalização. Nenhum dos dois passa pelas mãos do modelo, e a
    // regra continua decidindo onde ela já decide — escopo do #2232 é o que ela
    // NÃO vê.
    expect(detectUrgencySignal(CONTROLES[0]!), "incêndio, medido").toBe(true);
    expect(detectUrgencySignal(CONTROLES[2]!), "urgente, como a issue diz").toBe(true);
    expect(detectUrgencySignal(CONTROLES[1]!)).toBe(false);
  });
});

describe("os limiares, em código: risco_agora > 0,8 e hipotetico < 0,5", () => {
  it("os dois juntos — um só não abre nada", () => {
    expect(percebeuRisco(0.95, 0.04)).toBe(true);
    expect(percebeuRisco(0.95, 0.6)).toBe(false);
    expect(percebeuRisco(0.5, 0.04)).toBe(false);
  });

  it("estrito dos dois lados: o igual não passa", () => {
    expect(LIMIAR_RISCO_AGORA).toBe(0.8);
    expect(LIMIAR_HIPOTETICO).toBe(0.5);
    expect(percebeuRisco(0.8, 0.0), "risco igual a 0,8 não passa").toBe(false);
    expect(percebeuRisco(0.9, 0.5), "hipotético igual a 0,5 não passa").toBe(false);
  });
});

describe("a chamada: estado { mensagem } com as duas perguntas tipadas", () => {
  it("as 4 frases de risco, com o modelo dizendo risco: percebe, e a observação conta", async () => {
    for (const frase of RISCOS) {
      const { pool, consultas } = poolCom(LIGADO);
      const fetchImpl = vi.fn().mockResolvedValue(respostaCom(0.96, 0.04));
      const r = await perguntarUrgenciaAoJev(
        pool,
        { organizationId: novaOrg(), conversationId: "c1", messageId: "m1", contactId: null, jobId: "j1", mensagem: frase },
        { buscarChave: async () => "tsk_x", fetchImpl },
      );
      expect(r, frase).toMatchObject({ estado: "observando", percebeu: true, risco_agora: 0.96, modelo: "jev-1.13.0" });

      const corpo = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as {
        state: { mensagem: string };
        questions: Record<string, { type: string; criteria: Record<string, string> }>;
      };
      expect(corpo.state.mensagem, frase).toBe(frase);
      expect(Object.keys(corpo.questions).sort()).toEqual(["hipotetico", "risco_agora"]);
      expect(corpo.questions.risco_agora!.type).toBe("noul");

      await registrarUrgenciaDoJev(pool, {
        organizationId: "org-x",
        contactId: null,
        conversationId: "c1",
        messageId: "m1",
        jobId: "j1",
        urgencia: r!,
      });
      const gravada = consultas.find((q) => q.sql.includes("jev_observacoes"))!;
      const params: unknown[] = gravada.params;
      expect(params, `${frase}: a observação conta (rotulo_jev 'sim')`).toContain("sim");
      // Por construção a regra disse não: é a cascata.
      expect(params).toContain("nao");
      // Nenhum texto do cliente em `jev_observacoes`.
      expect(params.some((x) => String(x).includes(frase)), frase).toBe(false);
    }
  });

  it("os 3 controles negativos, com o modelo dizendo o que ele diz: nenhum percebe risco", async () => {
    // As respostas são as que um modelo treinado dá nestas frases (dubladas, como
    // a issue pede): pergunta de produto, figura de linguagem e pedido urgente de
    // orçamento ficam abaixo dos dois limiares.
    const dublês: ReadonlyArray<readonly [string, number, number]> = [
      [CONTROLES[0]!, 0.35, 0.7],
      [CONTROLES[1]!, 0.1, 0.95],
      [CONTROLES[2]!, 0.4, 0.8],
    ];
    for (const [frase, risco, hipotetico] of dublês) {
      const { pool, consultas } = poolCom(LIGADO);
      const fetchImpl = vi.fn().mockResolvedValue(respostaCom(risco, hipotetico));
      const r = await perguntarUrgenciaAoJev(
        pool,
        { organizationId: novaOrg(), conversationId: "c1", messageId: "m1", contactId: null, jobId: "j1", mensagem: frase },
        { buscarChave: async () => "tsk_x", fetchImpl },
      );
      expect(r, frase).toMatchObject({ percebeu: false, risco_agora: risco, hipotetico });
      await registrarUrgenciaDoJev(pool, {
        organizationId: "org-x",
        contactId: null,
        conversationId: "c1",
        messageId: "m1",
        jobId: "j1",
        urgencia: r!,
      });
      const gravada = consultas.find((q) => q.sql.includes("jev_observacoes"))!;
      const params: unknown[] = gravada.params;
      expect(params.filter((x) => x === "sim"), `${frase}: não conta como percebido`).toEqual([]);
    }
  });

  it("a tarefa desligada ou sem aceite: nada sai para a rede", async () => {
    const casos: ReadonlyArray<readonly [string, unknown]> = [
      ["Jev desligado", {}],
      ["tarefa desligada", { jev: { ...LIGADO.jev, tarefas: { sinal_de_urgencia: { estado: "desligada" } } } }],
      ["ligado sem aceite", { jev: { ligado: true } }],
    ];
    for (const [nome, settings] of casos) {
      const { pool } = poolCom(settings);
      const fetchImpl = vi.fn();
      const r = await perguntarUrgenciaAoJev(
        pool,
        { organizationId: novaOrg(), conversationId: null, messageId: null, contactId: null, jobId: null, mensagem: RISCOS[0]! },
        { buscarChave: async () => "tsk_x", fetchImpl },
      );
      expect(r, nome).toBeNull();
      expect(fetchImpl, nome).not.toHaveBeenCalled();
    }
  });

  it("sem credencial: nada sai para a rede, e sem chamada não há linha em llm_calls", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const fetchImpl = vi.fn();
    const r = await perguntarUrgenciaAoJev(
      pool,
      { organizationId: novaOrg(), conversationId: null, messageId: null, contactId: null, jobId: null, mensagem: RISCOS[0]! },
      { buscarChave: async () => null, fetchImpl },
    );
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    // O turno só grava quando `perguntarUrgenciaAoJev` devolveu algo: sem
    // resposta, nenhuma escrita (a única consulta foi a leitura do estado).
    expect(consultas.filter((q) => q.sql.includes("llm_calls"))).toEqual([]);
  });

  it("provedor fora: comportamento de hoje, e zero linha em llm_calls", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const r = await perguntarUrgenciaAoJev(
      pool,
      { organizationId: novaOrg(), conversationId: null, messageId: null, contactId: null, jobId: null, mensagem: RISCOS[0]! },
      { buscarChave: async () => "tsk_x", fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 500 })) },
    );
    expect(r).toBeNull();
    expect(consultas.filter((q) => q.sql.includes("llm_calls"))).toEqual([]);
  });

  it("o texto do cliente só sai no estado, passado pelo scrub — nunca no log", async () => {
    const { pool } = poolCom(LIGADO);
    const fetchImpl = vi.fn().mockResolvedValue(respostaCom(0.96, 0.04));
    await perguntarUrgenciaAoJev(
      pool,
      {
        organizationId: novaOrg(),
        conversationId: null,
        messageId: null,
        contactId: null,
        jobId: null,
        mensagem: "meu cpf é 123.456.789-00, tô na estrada com freio ruim",
      },
      { buscarChave: async () => "tsk_x", fetchImpl },
    );
    const corpo = String((fetchImpl.mock.calls[0]![1] as RequestInit).body);
    expect(corpo, "o CPF não sai da máquina: é o scrub do aceite").not.toContain("123.456.789-00");
    expect(corpo).toContain("[CPF]");
    const fonte = readFileSync("lib/ai/decisao/urgencia.ts", "utf8");
    for (const aviso of fonte.matchAll(/logger\.warn\("[^"]*",\s*\{([^}]*)\}/g)) {
      expect(aviso[1], "o contexto do log do Jev não pode carregar a frase do cliente").not.toMatch(/mensagem|frase/);
    }
  });
});

describe("as duas perguntas tipadas", () => {
  it("risco_agora e hipotetico, ambas noul, com critérios de verdade e de mentira", () => {
    expect(Object.keys(PERGUNTAS_DA_URGENCIA).sort()).toEqual(["hipotetico", "risco_agora"]);
    for (const p of Object.values(PERGUNTAS_DA_URGENCIA)) {
      expect(p.tipo).toBe("noul");
      const criterios = p.criterios as Partial<Record<"true" | "false", string>>;
      expect((criterios.true ?? "").trim().length).toBeGreaterThan(10);
      expect((criterios.false ?? "").trim().length).toBeGreaterThan(10);
    }
  });
});

/**
 * A FONTE DO TURNO — onde a chamada mora. O módulo sozinho não prova o
 * denominador: sem estas asserções, ele poderia ser chamado em qualquer turno,
 * em toda mensagem, ou junto com a regex.
 */
describe("inbound-turn: só no ramo represado, e só depois da regex dizer não", () => {
  const fonte = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const inicio = fonte.indexOf("if (pacingCapVeto !== null && outcomes.length === 0)");
  const fim = fonte.indexOf("throw new JobSettledError(", inicio);
  const bloco = fonte.slice(inicio, fim);

  it("a varredura enxerga o ramo (controle: sem ele, o resto passaria vazio)", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(inicio);
    expect(bloco.length).toBeGreaterThan(500);
  });

  it("o chamador existe UMA vez só, e dentro do ramo do pacingCapVeto", () => {
    expect(entraUmaVez(fonte, /perguntarUrgenciaAoJev\(/g)).toBe(1);
    expect(bloco).toContain("perguntarUrgenciaAoJev(");
    expect(fonte.slice(0, inicio)).not.toContain("perguntarUrgenciaAoJev(");
  });

  it("a regex roda primeiro: o modelo só é perguntado no `else` dela", () => {
    const PORTAO = "inboundsPendentes.some((texto) => detectUrgencySignal(texto))";
    expect(bloco, "o portão da regex é o mesmo da cerca #1747 — não muda de lugar").toContain(PORTAO);
    expect(entraUmaVez(bloco, /detectUrgencySignal\(/g)).toBe(1);
    const regra = bloco.indexOf(PORTAO);
    const chamada = bloco.indexOf("perguntarUrgenciaAoJev(");
    const senao = bloco.indexOf("} else if (!preview) {");
    expect(regra).toBeGreaterThan(-1);
    expect(senao).toBeGreaterThan(regra);
    expect(chamada).toBeGreaterThan(senao);
  });

  it("nasce em observação: o alerta do modelo abre só com 'Avisar a equipe' (decidindo)", () => {
    expect(bloco).toContain("urgencia.percebeu && urgencia.estado === 'decidindo'");
  });

  it("o alerta é o MESMO da regex: kind handoff, crítico, e com a origem para a equipe", () => {
    const iTitulo = bloco.indexOf("Lead com risco percebido pelo modelo");
    const iAbre = bloco.lastIndexOf("insertInboxItem(", iTitulo);
    const iFecha = bloco.indexOf("'kind_e_ref'", iTitulo);
    const alerta = bloco.slice(iAbre, iFecha);
    const corpo = alerta.slice(alerta.indexOf("body:"), alerta.indexOf("refKind:"));
    expect(alerta).toContain("kind: 'handoff'");
    expect(alerta).toContain("severity: 'critical'");
    expect(corpo).toContain("percebido pelo modelo de decisão");
    // Decisão 3 do #1747: a frase do cliente não entra na Central.
    expect(corpo).not.toMatch(/mensagemRepresada|inboundsPendentes|urgencia\./);
  });

  it("R3: o chamador não responde, não cala, não passa a conversa e não fura o teto", () => {
    // O bloco inteiro só reagenda, grava observação/alerta e encerra o job —
    // nenhuma escrita que silencie, bloqueie ou mande mensagem.
    expect(bloco).not.toMatch(/bot_silenced_until|force_human|is_blocked|insert into public\.messages/);
    // E o que ele faz DEPOIS do veto é o mesmo de sempre: o reagendamento.
    expect(bloco).toContain("await rescheduleJob(");
  });
});

/**
 * COLUNA → PARÂMETRO, lido no SQL que vai ao banco. O dublê do pool aceita
 * qualquer coisa, então "o params contém 'sim'" passava com o `job_id` de
 * `llm_calls` recebendo o id da MENSAGEM ($5) — que a FK
 * `llm_calls_job_id_fkey → job_queue(id)` recusa no banco real, desfazendo a
 * CTE inteira (observação e custo perdidos, só um `logger.warn`). Aqui cada
 * coluna é casada com o seu placeholder.
 */
describe("registrarUrgenciaDoJev: cada coluna recebe o parâmetro certo", () => {
  function colunasDo(sql: string, tabela: string, params: unknown[]): Record<string, unknown> {
    const m = new RegExp(`insert into public\\.${tabela}\\s*\\(([^)]*)\\)\\s*values\\s*\\(([^)]*)\\)`).exec(sql);
    expect(m, `o insert em ${tabela} existe no SQL`).not.toBeNull();
    const colunas = m![1]!.split(",").map((c) => c.trim());
    const valores = m![2]!.split(",").map((v) => v.trim());
    expect(valores).toHaveLength(colunas.length);
    return Object.fromEntries(
      colunas.map((c, i) => {
        const p = /^\$(\d+)$/.exec(valores[i]!);
        return [c, p ? params[Number(p[1]) - 1] : valores[i]];
      }),
    );
  }

  const urgencia: UrgenciaDoJev = {
    estado: "observando",
    risco_agora: 0.96,
    hipotetico: 0.04,
    percebeu: true,
    modelo: "jev-1.13.0",
    tokensDeEntrada: 210,
    tokensDeSaida: 4,
    latenciaMs: 300,
  };

  async function gravar(jobId: string | null) {
    const { pool, consultas } = poolCom(LIGADO);
    await registrarUrgenciaDoJev(pool, {
      organizationId: "org-1",
      contactId: "contato-1",
      conversationId: "conversa-1",
      messageId: "mensagem-1",
      jobId,
      urgencia,
    });
    const { sql, params } = consultas.find((q) => q.sql.includes("llm_calls"))!;
    return { llm: colunasDo(sql, "llm_calls", params), obs: colunasDo(sql, "jev_observacoes", params) };
  }

  it("llm_calls: job_id é o JOB, nunca a mensagem; contact_id é o contato", async () => {
    const { llm } = await gravar("job-1");
    expect(llm.organization_id).toBe("org-1");
    expect(llm.contact_id).toBe("contato-1");
    expect(llm.job_id, "a FK de job_id aponta para job_queue").toBe("job-1");
    expect(llm.model).toBe("typesafe/jev-1.13.0");
  });

  it("jev_observacoes: message_id é a mensagem e job_id é o job", async () => {
    const { obs } = await gravar("job-1");
    expect(obs.message_id).toBe("mensagem-1");
    expect(obs.job_id).toBe("job-1");
    expect(obs.conversation_id).toBe("conversa-1");
  });

  it("sem job (nulo), job_id vai nulo nas duas — e não vira o id da mensagem", async () => {
    const { llm, obs } = await gravar(null);
    expect(llm.job_id).toBeNull();
    expect(obs.job_id).toBeNull();
  });
});
