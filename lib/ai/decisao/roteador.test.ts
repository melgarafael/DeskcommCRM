/**
 * O ROTEADOR PERGUNTADO AO JEV — a pergunta, o que sai, e o que se grava.
 *
 * O banco é um dublê de `pg.Pool` aqui. Quem decide com a escolha dele é o
 * turno (`lib/agent-engine/agent/resolve-turn-agent.test.ts`); o caminho
 * inteiro, com Postgres real, é `tests/invariants/jev-roteador-no-turno.test.ts`.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { RouterMember } from "@/lib/agent-engine/agent/router-config";
import { registrarFalha } from "@/lib/ai/decisao/disjuntor";
import {
  consultarJevNoRoteador,
  MEMBROS_NO_MAXIMO,
  perguntaDoRoteador,
  registrarRoteadorDoJev,
  type EscolhaDoJev,
} from "@/lib/ai/decisao/roteador";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const LIGADO = { jev: { ligado: true, aceite: { em: "2026-09-23T12:00:00.000Z", por: ADMIN } } };

/** O disjuntor é por (organização, tarefa) e vive no processo: cada caso usa a sua. */
let seq = 0;
const novaOrg = () => `org-roteador-${++seq}`;

const MEMBROS: RouterMember[] = [
  { agentId: "agente-vendas", intentName: "vendas", intentDescription: "Quer comprar", examples: ["quanto custa"] },
  { agentId: "agente-suporte", intentName: "suporte", intentDescription: "Tem um problema", examples: [] },
];

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

function respostaCom(escolha: string, probabilidades: Record<string, number> = { [escolha]: 0.93 }): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: { roteador: { type: "choice", choice: escolha, probabilities: probabilidades, confidence: 0.8 } },
      usage: { input_tokens: 400, output_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const entrada = (organizationId: string, mensagem = "meu pedido não chegou", membros = MEMBROS) => ({
  organizationId,
  mensagem,
  membros,
  contactId: "contato-1",
  jobId: "job-1",
});

const membros = (n: number): RouterMember[] =>
  Array.from({ length: n }, (_, i) => ({
    agentId: `agente-${i}`,
    intentName: `intencao-${i}`,
    intentDescription: `Descrição ${i}`,
    examples: [],
  }));

describe("perguntaDoRoteador — uma escolha entre as intenções do roteador, e 'nenhuma'", () => {
  it("critérios iguais aos do prompt da IA de sempre, intenção a intenção", () => {
    expect(perguntaDoRoteador(MEMBROS)).toEqual({
      tipo: "choice",
      instrucao: expect.stringContaining("ÚLTIMA mensagem do cliente"),
      criterios: {
        vendas: "Quer comprar. Exemplos: quanto custa.",
        suporte: "Tem um problema.",
        none: "Nenhuma das intenções acima se aplica.",
      },
    });
  });

  it(`de 1 a ${MEMBROS_NO_MAXIMO} membros; fora disso não pergunta (a API recusaria a chamada inteira)`, () => {
    expect(perguntaDoRoteador([])).toBeNull();
    expect(perguntaDoRoteador(membros(1))).not.toBeNull();
    const cheia = perguntaDoRoteador(membros(MEMBROS_NO_MAXIMO));
    // 254 intenções + "nenhuma" = 255, o teto do fornecedor.
    expect(cheia?.tipo === "choice" && Object.keys(cheia.criterios)).toHaveLength(255);
    expect(perguntaDoRoteador(membros(MEMBROS_NO_MAXIMO + 1))).toBeNull();
  });
});

describe("consultarJevNoRoteador", () => {
  it("Jev desligado: nada sai, e a tarefa vale desligada", async () => {
    const { pool } = poolCom({});
    const fetchImpl = vi.fn();
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), { buscarChave: async () => "tsk_x", fetchImpl });
    expect(await jev.estado).toBe("desligada");
    expect(await jev.escolha).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ligado, sem nada gravado: a tarefa nova OBSERVA (R7); só a pergunta dela e a mensagem sozinha, sem telefone (R4/R6)", async () => {
    const { pool } = poolCom(LIGADO);
    const fetchImpl = vi.fn().mockResolvedValue(respostaCom("suporte", { vendas: 0.05, suporte: 0.9, none: 0.05 }));
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg(), "meu pedido não chegou, liga no 11 98765-4321"), {
      buscarChave: async () => "tsk_x",
      baseUrl: "https://jev.duble.test",
      fetchImpl,
    });

    expect(await jev.estado).toBe("observando");
    expect(await jev.escolha).toMatchObject({
      estado: "observando",
      veredito: { intentName: "suporte", confidence: 0.9 },
      modelo: "jev-1.13.0",
      tokensDeEntrada: 400,
    });
    const corpo = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as {
      state: string;
      questions: Record<string, unknown>;
    };
    expect(Object.keys(corpo.questions)).toEqual(["roteador"]);
    expect(corpo.state).toContain("meu pedido não chegou");
    expect(corpo.state).not.toContain("98765-4321");
  });

  it("'nenhuma' vira intenção nula com a probabilidade dela; fora da lista vira nula com confiança zero", async () => {
    const nenhuma = consultarJevNoRoteador(poolCom(LIGADO).pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(respostaCom("none", { none: 0.95 })),
    });
    expect((await nenhuma.escolha)?.veredito).toEqual({ intentName: null, confidence: 0.95 });

    // O roteamento dá ao cliente as ferramentas do agente: uma intenção que o
    // roteador não tem nunca vira agente.
    const inventada = consultarJevNoRoteador(poolCom(LIGADO).pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(respostaCom("financeiro", { financeiro: 0.99 })),
    });
    expect((await inventada.escolha)?.veredito).toEqual({ intentName: null, confidence: 0 });
  });

  it("tarefa desligada pela empresa: nem pergunta", async () => {
    const { pool } = poolCom({ jev: { ...LIGADO.jev, tarefas: { roteador: { estado: "desligada" } } } });
    const fetchImpl = vi.fn();
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), { buscarChave: async () => "tsk_x", fetchImpl });
    expect(await jev.estado).toBe("desligada");
    expect(await jev.escolha).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("roteador com mais intenções do que cabe numa pergunta: não pergunta, e ninguém espera por ele", async () => {
    const fetchImpl = vi.fn();
    const jev = consultarJevNoRoteador(poolCom(LIGADO).pool, entrada(novaOrg(), "oi", membros(MEMBROS_NO_MAXIMO + 1)), {
      buscarChave: async () => "tsk_x",
      fetchImpl,
    });
    expect(await jev.escolha).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mensagem vazia (mídia sem legenda): nem lê o banco", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg(), "   "), { buscarChave: async () => "tsk_x" });
    expect(await jev.estado).toBe("desligada");
    expect(await jev.escolha).toBeNull();
    expect(consultas).toEqual([]);
  });

  it("um membro torto (sem exemplos) não rejeita: vale a IA de sempre", async () => {
    const torto = [{ agentId: "a", intentName: "x", intentDescription: "y" }] as unknown as RouterMember[];
    const jev = consultarJevNoRoteador(poolCom(LIGADO).pool, entrada(novaOrg(), "oi", torto), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn(),
    });
    await expect(jev.escolha).resolves.toBeNull();
  });

  it("chave recusada: linha de erro em Execuções no ponto do roteador, com a origem de quem só opina ao lado", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    });
    expect(await jev.escolha).toBeNull();
    const erro = consultas.find((c) => /insert into public\.llm_calls/.test(c.sql));
    expect(erro?.sql).toMatch(/'erro'/);
    expect(erro?.sql).toMatch(/'jev_observacao'\)/);
    expect(erro?.params).toEqual(
      expect.arrayContaining(["intent_router", "contato-1", "job-1", "jev_credencial_invalida", 401]),
    );
  });
});

const ESCOLHA: EscolhaDoJev = {
  estado: "observando",
  veredito: { intentName: "suporte", confidence: 0.9 },
  confianca: 0.8,
  modelo: "jev-1.13.0",
  tokensDeEntrada: 400,
  tokensDeSaida: 3,
  latenciaMs: 250,
};

describe("o que se grava", () => {
  it("observar: o par em jev_observacoes E o custo em llm_calls, no mesmo comando, com o agente de cada lado", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(respostaCom("suporte", { suporte: 0.9 })),
    });
    jev.observar({
      conversationId: "conversa-1",
      messageId: "mensagem-1",
      rotuloDe: (v) => (v.intentName === "suporte" ? "agente-suporte" : "agente-vendas"),
      vereditoDaIa: { intentName: "vendas", confidence: 0.7 },
      decidiu: false,
      aIaCobriu: false,
    });
    await vi.waitFor(() => expect(consultas.some((c) => /jev_observacoes/.test(c.sql))).toBe(true));

    const gravacao = consultas.find((c) => /jev_observacoes/.test(c.sql))!;
    expect(gravacao.sql).toMatch(/insert into public\.llm_calls/);
    expect(gravacao.sql).toMatch(/'intent_router', 'typesafe'/);
    expect(gravacao.params).toEqual(
      expect.arrayContaining([
        "roteador",
        "observando",
        "conversa-1",
        "mensagem-1",
        "agente-suporte",
        "agente-vendas",
        "jev_observacao",
        "typesafe/jev-1.13.0",
      ]),
    );
  });

  it("observar sem a IA de sempre: o lado dela fica nulo (sem par), e decidindo a origem é jev", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(respostaCom("suporte")),
    });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: true, aIaCobriu: false });
    await vi.waitFor(() => expect(consultas.some((c) => /jev_observacoes/.test(c.sql))).toBe(true));
    const { params } = consultas.find((c) => /jev_observacoes/.test(c.sql))!;
    // $17 = rotulo_atual; $9 = origem da linha de custo.
    expect(params[16]).toBeNull();
    expect(params[8]).toBe("jev");
  });

  it("observar sem escolha do Jev não grava nada", async () => {
    const { pool, consultas } = poolCom({});
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), { buscarChave: async () => "tsk_x" });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: false, aIaCobriu: false });
    await jev.escolha;
    await new Promise((r) => setTimeout(r, 0));
    expect(consultas.filter((c) => /insert/.test(c.sql))).toEqual([]);
  });

  it("um rótulo que lança não vira rejeição solta (derrubaria o worker): vira aviso", async () => {
    const { pool } = poolCom(LIGADO);
    const soltas: unknown[] = [];
    const ouvir = (e: unknown) => soltas.push(e);
    process.on("unhandledRejection", ouvir);
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), {
        buscarChave: async () => "tsk_x",
        fetchImpl: vi.fn().mockResolvedValue(respostaCom("suporte")),
      });
      jev.observar({
        conversationId: null,
        messageId: null,
        rotuloDe: () => {
          throw new Error("rótulo quebrado");
        },
        vereditoDaIa: null,
        decidiu: false,
        aIaCobriu: false,
      });
      await vi.waitFor(() => expect(aviso).toHaveBeenCalledWith(expect.stringContaining("não foi gravada")));
      expect(soltas).toEqual([]);
    } finally {
      process.off("unhandledRejection", ouvir);
      aviso.mockRestore();
    }
  });

  /**
   * Decidindo, a IA de sempre cobre o Jev que não respondeu. Sem esta linha, o
   * cartão dizia zero coberturas e nenhuma falha com o Jev estourando o teto em
   * parte das mensagens — e quem o deixou decidir não tinha como saber.
   */
  it("decidindo, o Jev fora do ar e a IA de sempre cobrindo: uma linha de cobertura, com o motivo", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 503 })),
    });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: false, aIaCobriu: true });
    await vi.waitFor(() => expect(consultas.some((c) => /'reserva_do_jev'/.test(c.sql))).toBe(true));
    const cobertura = consultas.find((c) => /'reserva_do_jev'/.test(c.sql))!;
    expect(cobertura.sql).toMatch(/insert into public\.llm_calls/);
    expect(cobertura.sql).toMatch(/'intent_router', 'typesafe'/);
    expect(cobertura.sql).toMatch(/'erro'/);
    expect(cobertura.params).toEqual(expect.arrayContaining(["contato-1", "job-1", "jev_provedor_indisponivel", 503]));
  });

  it("decidindo, a chave recusada: a linha de erro que ela já deixou é remarcada como cobertura, sem duplicar", async () => {
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        return { rows: [{ settings: LIGADO, id: "linha-da-falha" }] };
      }),
    } as unknown as pg.Pool;
    const org = novaOrg();
    const jev = consultarJevNoRoteador(pool, entrada(org), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: false, aIaCobriu: true });
    await vi.waitFor(() => expect(consultas.some((c) => /^update public\.llm_calls/.test(c.sql.trim()))).toBe(true));
    expect(consultas.filter((c) => /insert into public\.llm_calls/.test(c.sql))).toHaveLength(1);
    expect(consultas.find((c) => /^update/.test(c.sql.trim()))!.params).toEqual(["linha-da-falha", org]);
  });

  /**
   * Nada saiu para a rede — sem chave, ou o disjuntor segurou —, mas decidindo a
   * IA de sempre cobriu do mesmo jeito. Numa queda longa eram 3 linhas e depois
   * uma a cada 5 minutos, com centenas de mensagens cobertas sem rastro.
   */
  const casosSemRede: Array<{ caso: string; codigo: string; chave: string | null; disjuntorAberto: boolean }> = [
    { caso: "sem chave", codigo: "jev_sem_credencial", chave: null, disjuntorAberto: false },
    { caso: "com o disjuntor aberto", codigo: "jev_disjuntor_aberto", chave: "tsk_x", disjuntorAberto: true },
  ];
  it.each(casosSemRede)("decidindo e $caso: a cobertura deixa linha, sem observação de concordância", async ({ codigo, chave, disjuntorAberto }) => {
    const { pool, consultas } = poolCom(LIGADO);
    const org = novaOrg();
    // O fornecedor pediu pausa: o disjuntor abre na hora, e nada sai para a rede.
    if (disjuntorAberto) registrarFalha({ organizationId: org, tarefa: "roteador" }, "limite_de_taxa");
    const fetchImpl = vi.fn();
    const jev = consultarJevNoRoteador(pool, entrada(org), { buscarChave: async () => chave, fetchImpl });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: false, aIaCobriu: true });
    await vi.waitFor(() => expect(consultas.some((c) => /'reserva_do_jev'/.test(c.sql))).toBe(true));
    const cobertura = consultas.find((c) => /'reserva_do_jev'/.test(c.sql))!;
    expect(cobertura.sql).toMatch(/insert into public\.llm_calls/);
    expect(cobertura.params).toEqual([org, "contato-1", "job-1", "typesafe/jev-1.13.0", null, codigo, null]);
    expect(consultas.filter((c) => /jev_observacoes/.test(c.sql))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("controle: sem chave e observando, nada a registrar — a IA de sempre não cobriu ninguém", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), { buscarChave: async () => null });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: false, aIaCobriu: false });
    await jev.escolha;
    await new Promise((r) => setTimeout(r, 0));
    expect(consultas.filter((c) => /insert|update/.test(c.sql))).toEqual([]);
  });

  it("controle: observando, a falha que passa sozinha não vira linha nenhuma", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    const jev = consultarJevNoRoteador(pool, entrada(novaOrg()), {
      buscarChave: async () => "tsk_x",
      fetchImpl: vi.fn().mockResolvedValue(new Response("{}", { status: 503 })),
    });
    jev.observar({ conversationId: null, messageId: null, rotuloDe: () => "a", vereditoDaIa: null, decidiu: false, aIaCobriu: false });
    await jev.escolha;
    await new Promise((r) => setTimeout(r, 0));
    expect(consultas.filter((c) => /insert|update/.test(c.sql))).toEqual([]);
  });

  it("sem observação (a tela de teste, R5): só o custo, nenhuma linha de concordância", async () => {
    const { pool, consultas } = poolCom(LIGADO);
    await registrarRoteadorDoJev(pool, {
      organizationId: novaOrg(),
      contactId: null,
      jobId: null,
      jev: ESCOLHA,
      decidiu: false,
      observacao: null,
    });
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toMatch(/insert into public\.llm_calls/);
    expect(consultas[0]!.sql).not.toMatch(/jev_observacoes/);
    // A origem é a do teste: "registrada para comparar" seria falso em Execuções.
    expect(consultas[0]!.params[8]).toBe("jev_teste");
  });

  it("falha do banco na gravação não lança", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("banco fora")) } as unknown as pg.Pool;
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      registrarRoteadorDoJev(pool, {
        organizationId: novaOrg(),
        contactId: null,
        jobId: null,
        jev: ESCOLHA,
        decidiu: false,
        observacao: { conversationId: null, messageId: null, rotuloDoJev: "a", rotuloDaIa: "b" },
      }),
    ).resolves.toBeUndefined();
    aviso.mockRestore();
  });
});
