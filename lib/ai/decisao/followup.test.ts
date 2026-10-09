/**
 * A RESPOSTA AO FOLLOW-UP PERGUNTADA AO JEV — a pergunta, o que sai, e o que se
 * grava.
 *
 * O banco é um dublê de `pg.Pool` aqui. Quem conclui o passo com a saída da IA
 * de sempre é o turno (`lib/agent-engine/agent/followup-turn.ts`); o caminho
 * inteiro, com Postgres real e o handler de produção, é
 * `tests/invariants/jev-followup-no-turno.test.ts`.
 */
import { readFileSync } from "node:fs";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { consultarJevNoFollowup, perguntaDoFollowup, type EntradaDoFollowup } from "@/lib/ai/decisao/followup";
import { SAIDAS_NO_MAXIMO, TAREFA_DO_FOLLOWUP } from "@/lib/ai/decisao/tarefas";
import { DICIONARIO } from "@/lib/i18n/dicionario";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: ADMIN };
const LIGADO = { jev: { ligado: true, aceite: ACEITE } };
const CLASSES = ["quer", "não quer", "depois"];
const MENSAGEM = "quero sim, me liga no 11 98765-4321";

/** O disjuntor é por (organização, tarefa) e vive no processo: cada caso usa a sua. */
let seq = 0;
const novaOrg = () => `org-followup-${++seq}`;

interface Consulta {
  sql: string;
  params: unknown[];
}

/** `settings` responde à leitura do estado; `falhaNaEscrita` faz o INSERT lançar. */
function poolCom(settings: unknown, opts: { falhaNaEscrita?: boolean } = {}) {
  const consultas: Consulta[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      consultas.push({ sql, params });
      if (/insert/i.test(sql)) {
        if (opts.falhaNaEscrita) throw new Error("conexão caiu");
        return { rows: [{ id: "linha-de-erro" }] };
      }
      return { rows: [{ settings }] };
    }),
  } as unknown as pg.Pool;
  return { pool, consultas };
}

function respostaCom(escolha: string, tipo = "choice"): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        followup:
          tipo === "choice"
            ? { type: "choice", choice: escolha, probabilities: { [escolha]: 0.91 }, confidence: 0.8 }
            : { type: "noul", noul: 0.9 },
      },
      usage: { input_tokens: 210, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function entrada(organizationId: string, over: Partial<EntradaDoFollowup> = {}): EntradaDoFollowup {
  return {
    organizationId,
    contactId: "contato-1",
    jobId: "job-1",
    conversationId: "conversa-1",
    mensagem: MENSAGEM,
    classes: CLASSES,
    dica: "Quem pede o link quer.",
    idDaMensagem: vi.fn(async () => "mensagem-1"),
    ...over,
  };
}

const deps = (fetchImpl: ReturnType<typeof vi.fn>) => ({
  buscarChave: async () => "tsk_duble",
  baseUrl: "https://jev.duble.test",
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

const corpoDoPedido = (fetchImpl: ReturnType<typeof vi.fn>) =>
  JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as {
    state: string;
    questions: Record<string, { type: string; instructions: string; criteria: Record<string, unknown> }>;
  };

describe("perguntaDoFollowup — uma escolha entre as saídas do passo, de igual para igual com a IA de sempre", () => {
  it("as saídas viram critérios sem descrição (o nome é a definição), a dica vai na instrução, e não há 'nenhuma'", () => {
    const p = perguntaDoFollowup(CLASSES, "  Quem pede o link quer.  ");
    expect(p).toEqual({
      tipo: "choice",
      instrucao: expect.stringContaining("Dica de quem montou o fluxo: Quem pede o link quer."),
      criterios: { quer: null, "não quer": null, depois: null },
    });
    expect(Object.keys(p?.tipo === "choice" ? p.criterios : {})).toEqual(CLASSES);
    // Sem dica, só a instrução.
    expect(perguntaDoFollowup(CLASSES)?.instrucao).not.toContain("Dica");
    expect(perguntaDoFollowup(CLASSES, "   ")?.instrucao).not.toContain("Dica");
  });

  it.each([
    ["nenhuma saída", []],
    // A IA de sempre só poderia devolver ela, e o Jev também: concordância certa, paga e vazia.
    ["uma saída só", ["respondeu"]],
    ["uma saída em branco", ["quer", ""]],
    ["uma saída só de espaços", ["quer", "   "]],
    ["duas saídas iguais", ["quer", "quer"]],
    [`mais de ${SAIDAS_NO_MAXIMO} saídas`, Array.from({ length: SAIDAS_NO_MAXIMO + 1 }, (_, i) => `s${i}`)],
  ])("fora do contrato do fornecedor (%s), a pergunta não sai", (_caso, classes) => {
    expect(perguntaDoFollowup(classes)).toBeNull();
  });

  it(`até ${SAIDAS_NO_MAXIMO} saídas, cabe (controle do teto)`, () => {
    const p = perguntaDoFollowup(Array.from({ length: SAIDAS_NO_MAXIMO }, (_, i) => `s${i}`));
    expect(p?.tipo === "choice" && Object.keys(p.criterios)).toHaveLength(SAIDAS_NO_MAXIMO);
  });
});

describe("consultarJevNoFollowup", () => {
  it("Jev desligado: nada sai, nem o id da mensagem é buscado", async () => {
    const { pool } = poolCom({});
    const fetchImpl = vi.fn();
    const e = entrada(novaOrg());
    const jev = consultarJevNoFollowup(pool, e, deps(fetchImpl));
    expect(await jev.escolha).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(e.idDaMensagem).not.toHaveBeenCalled();
  });

  it("a tarefa pausada: nada sai", async () => {
    const { pool } = poolCom({ jev: { ...LIGADO.jev, tarefas: { followup: { estado: "desligada" } } } });
    const fetchImpl = vi.fn();
    expect(await consultarJevNoFollowup(pool, entrada(novaOrg()), deps(fetchImpl)).escolha).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ligado, sem nada gravado: OBSERVA (R7); só a pergunta dela, as saídas do passo e a resposta sozinha, sem telefone (R4/R6)", async () => {
    const { pool } = poolCom(LIGADO);
    const fetchImpl = vi.fn().mockResolvedValue(respostaCom("não quer"));
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg()), deps(fetchImpl));

    expect(await jev.escolha).toMatchObject({
      estado: "observando",
      classe: "não quer",
      probabilidade: 0.91,
      confianca: 0.8,
      modelo: "jev-1.13.0",
      tokensDeEntrada: 210,
      messageId: "mensagem-1",
    });
    const corpo = corpoDoPedido(fetchImpl);
    expect(Object.keys(corpo.questions)).toEqual(["followup"]);
    expect(corpo.questions.followup!.type).toBe("choice");
    expect(Object.keys(corpo.questions.followup!.criteria)).toEqual(CLASSES);
    expect(corpo.state).toContain("quero sim");
    expect(corpo.state).not.toContain("98765-4321");
  });

  it("um `decidindo` gravado por outra versão vale observando: a saída do Jev nunca decide aqui", async () => {
    const { pool } = poolCom({ jev: { ...LIGADO.jev, tarefas: { followup: { estado: "decidindo" } } } });
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg()), deps(vi.fn().mockResolvedValue(respostaCom("quer"))));
    expect((await jev.escolha)?.estado).toBe("observando");
  });

  it("resposta em mídia (nada digitado): nada sai, nem o estado é lido", async () => {
    const { pool } = poolCom(LIGADO);
    const fetchImpl = vi.fn();
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg(), { mensagem: "  " }), deps(fetchImpl));
    expect(await jev.escolha).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("saídas fora do contrato: nada sai, nem o estado é lido — e nada se grava", async () => {
    const { pool } = poolCom(LIGADO);
    const fetchImpl = vi.fn();
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg(), { classes: ["quer", "quer"] }), deps(fetchImpl));
    expect(await jev.escolha).toBeNull();
    jev.observar("quer");
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.query).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sem o id da mensagem, não pergunta: a resposta não teria onde ficar", async () => {
    const { pool } = poolCom(LIGADO);
    const fetchImpl = vi.fn();
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg(), { idDaMensagem: async () => null }), deps(fetchImpl));
    expect(await jev.escolha).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["uma saída que o passo não tem", respostaCom("talvez")],
    ["uma resposta que não é escolha", respostaCom("quer", "noul")],
  ])("%s é falha, e nada se grava", async (_caso, resposta) => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg()), deps(vi.fn().mockResolvedValue(resposta)));
    expect(await jev.escolha).toBeNull();
    jev.observar("quer");
    await new Promise((r) => setTimeout(r, 0));
    expect(consultas.filter((c) => /insert/i.test(c.sql))).toEqual([]);
  });

  it("a chave recusada vira linha de erro em Execuções (purpose do ponto, origem de quem só observa)", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoFollowup(
      pool,
      entrada(novaOrg()),
      deps(vi.fn().mockResolvedValue(new Response("{}", { status: 401 }))),
    );
    expect(await jev.escolha).toBeNull();
    const [erro] = consultas.filter((c) => /insert/i.test(c.sql));
    expect(erro!.sql).toContain("'jev_observacao'");
    expect(erro!.params).toEqual(expect.arrayContaining(["followup_classify", "jev_credencial_invalida", 401]));
  });
});

describe("observar — o par e o custo, no mesmo comando, sem o texto do cliente", () => {
  async function gravado(classeDaIa: string | null) {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg()), deps(vi.fn().mockResolvedValue(respostaCom("não quer"))));
    jev.observar(classeDaIa);
    await vi.waitFor(() => expect(consultas.filter((c) => /insert/i.test(c.sql))).toHaveLength(1));
    return consultas.find((c) => /insert/i.test(c.sql))!;
  }

  it("uma linha em jev_observacoes (a saída dele × a da IA de sempre, com a mensagem e o job) e uma em llm_calls", async () => {
    const { sql, params } = await gravado("quer");
    expect(sql).toMatch(/insert into public\.jev_observacoes[\s\S]*insert into public\.llm_calls/);
    expect(sql).toContain("'followup_classify', 'typesafe'");
    expect(sql).toContain("'jev_observacao'");
    expect(params).toEqual(
      expect.arrayContaining([TAREFA_DO_FOLLOWUP.id, "observando", "conversa-1", "mensagem-1", "job-1", "não quer", "quer", 0.91]),
    );
    // O texto do cliente não vai para o banco — nem inteiro, nem o pedaço.
    expect(JSON.stringify(params)).not.toContain("quero sim");
  });

  it("o retry não conta em dobro: o índice único por mensagem, que só preenche o lado da IA quando faltava", async () => {
    const { sql } = await gravado("quer");
    expect(sql).toMatch(/on conflict \(organization_id, tarefa, message_id\) where message_id is not null/);
    expect(sql).toMatch(
      /do update set rotulo_atual = excluded\.rotulo_atual\s+where o\.rotulo_atual is null and o\.job_id is not distinct from excluded\.job_id/,
    );
  });

  it("sem a saída da IA de sempre, a linha fica sem par (rótulo de hoje nulo)", async () => {
    const { params } = await gravado(null);
    // $16 é o `rotulo_atual`.
    expect(params[15]).toBeNull();
  });

  it("a gravação que falha não lança: é telemetria", async () => {
    const { pool } = poolCom(LIGADO, { falhaNaEscrita: true });
    const jev = consultarJevNoFollowup(pool, entrada(novaOrg()), deps(vi.fn().mockResolvedValue(respostaCom("quer"))));
    await jev.escolha;
    expect(() => jev.observar("quer")).not.toThrow();
    await vi.waitFor(() => expect(vi.mocked(pool.query).mock.calls.some(([sql]) => /insert/i.test(String(sql)))).toBe(true));
  });
});

describe("os textos da tarefa, para quem não é engenheiro", () => {
  const zh = JSON.parse(readFileSync("lib/i18n/traducoes/zh-CN.json", "utf8")) as Record<string, string>;

  it("o nome, o que faz e por que só observa têm espanhol e chinês, em frase inteira", () => {
    for (const pt of [TAREFA_DO_FOLLOWUP.rotulo, TAREFA_DO_FOLLOWUP.oQueFaz, TAREFA_DO_FOLLOWUP.soObserva]) {
      expect(DICIONARIO[pt]?.es, pt.slice(0, 40)).toBeTruthy();
      expect(zh[pt], pt.slice(0, 40)).toBeTruthy();
    }
  });

  it("não promete saídas fixas nem que o Jev decide", () => {
    for (const texto of [TAREFA_DO_FOLLOWUP.oQueFaz, TAREFA_DO_FOLLOWUP.concordancia.antes]) {
      expect(texto).not.toMatch(/aceitou|recusou|falar depois/);
    }
    expect(TAREFA_DO_FOLLOWUP.soObserva).toMatch(/não há como deixar o Jev decidir/);
  });
});
