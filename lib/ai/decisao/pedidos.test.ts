/**
 * OS PEDIDOS DO CLIENTE PERGUNTADOS AO JEV — a cascata, o denominador, o corte
 * e o que se grava.
 *
 * A regra de hoje entra aqui como ela é — a função que o worker roda
 * (`regraDeHoje`, em `workers/ai-sentiment-worker.pedidos.ts`), e não uma cópia
 * dela —, para a cascata ser provada com as frases de verdade, e não com um
 * `true` escrito à mão. O caminho pelo worker de clima, com a leitura dos fatos
 * do turno, é `tests/unit/clima-da-conversa-no-worker.test.ts`.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { TAREFA_DO_PEDIDO_PARA_PARAR } from "@/lib/ai/decisao/tarefas";
import { POLITICAS_DE_AVISO } from "@/lib/ai/inbox-destino";
import {
  AVISOS_DOS_PEDIDOS,
  avisarAEquipe,
  CORTE_DO_PEDIDO,
  observarPedidos,
  pedidosAPerguntar,
  rotuloDoPedido,
  turnoRodaria,
  type AConversaAgora,
  type EntradaDosPedidos,
  type FatosDoTurno,
  type RegraPegou,
} from "@/lib/ai/decisao/pedidos";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { regraDeHoje as regraDoWorker } from "@/workers/ai-sentiment-worker.pedidos";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: ADMIN };
const LIGADO = lerConfigDoJev({ jev: { ligado: true, aceite: ACEITE } });
const TURNO_QUE_RODA: FatosDoTurno = {
  atendimentoExterno: false,
  sessaoTemQuemAtenda: true,
  iaPodeResponder: true,
  contatoBloqueado: false,
  contatoComUmaPessoa: false,
  grupo: false,
};

/**
 * A regra de hoje sobre UMA frase, sem mensagens anteriores sem resposta e sem
 * as palavras do agente — a função do worker, a de verdade: o descadastro,
 * pedido ou provável, também é regra de pessoa (no turno, ele passa a conversa).
 */
const regraDeHoje = (texto: string): RegraPegou => regraDoWorker([texto], []);

const idsPerguntados = (texto: string, config = LIGADO) =>
  pedidosAPerguntar(config, regraDeHoje(texto)).map((p) => p.id);

describe("a cascata: o Jev só é perguntado onde a regra de hoje disse não", () => {
  it("a frase natural que a regra não pega: as duas perguntas saem", () => {
    const frase = "quero falar com alguém de verdade aí, não com robô";
    // Controle: a regra de hoje, de fato, não pega nenhum dos dois.
    expect(regraDeHoje(frase)).toEqual({ humano: false, opt_out: false });
    expect(idsPerguntados(frase)).toEqual(["humano", "opt_out"]);
  });

  it("a regra de descadastro pegou: nenhuma das duas sai — no turno, ela também passa a conversa", () => {
    // Inequívoca (bloqueia na entrada) e provável (cala o agente e passa a
    // conversa a uma pessoa): nas duas, perguntar pelo pedido de pessoa contaria
    // um pedido que o produto já atendeu.
    for (const frase of ["PARAR", "me deixa em paz", "Para com isso, chama o dono"]) {
      expect(regraDeHoje(frase).opt_out, frase).toBe(true);
      expect(detectHumanHandoffRequest(frase), `${frase}: a regra de pessoa sozinha não pega`).toBe(false);
      expect(idsPerguntados(frase), frase).toEqual([]);
    }
  });

  it("a regra de pessoa pegou: a pergunta de pessoa NÃO sai; a de parar de receber sai", () => {
    const frase = "quero falar com um atendente";
    expect(regraDeHoje(frase).humano).toBe(true);
    expect(idsPerguntados(frase)).toEqual(["opt_out"]);
  });

  it("a regra pegou os dois: nenhuma pergunta — e, sem pergunta, nenhuma chamada", () => {
    expect(idsPerguntados("me deixa em paz, quero falar com um atendente")).toEqual([]);
  });

  /**
   * A rajada: o turno aplica a regra a TODAS as mensagens do cliente ainda sem
   * resposta. O pedido que a regra pegou na 1ª não é um que ela deixou passar
   * na 2ª — e a 2ª, sozinha, a regra não pega (controle).
   */
  it("a rajada: a regra pegou o pedido numa mensagem anterior sem resposta — a de pessoa não sai na seguinte", () => {
    const rajada = ["quero falar com um atendente", "por favor, alguém de verdade"];
    expect(regraDeHoje(rajada[1]!).humano, "a 2ª, sozinha, a regra não pega (controle)").toBe(false);
    expect(regraDoWorker(rajada, [])).toEqual({ humano: true, opt_out: false });
    expect(pedidosAPerguntar(LIGADO, regraDoWorker(rajada, [])).map((p) => p.id)).toEqual(["opt_out"]);
    expect(regraDoWorker(["PARAR", "oi"], []), "o descadastro numa anterior pega os dois").toEqual({ humano: true, opt_out: true });
  });

  it("as palavras de passagem de quem pode atender contam em qualquer mensagem da rajada", () => {
    expect(regraDoWorker(["chama o gerente", "rápido"], [])).toEqual({ humano: false, opt_out: false });
    expect(regraDoWorker(["chama o gerente", "rápido"], ["gerente"])).toEqual({ humano: true, opt_out: false });
  });

  it("tarefa pausada não pergunta; o Jev desligado não pergunta nada", () => {
    const soHumano = lerConfigDoJev({ jev: { ligado: true, aceite: ACEITE, tarefas: { opt_out: { estado: "desligada" } } } });
    expect(idsPerguntados("oi", soHumano)).toEqual(["humano"]);
    expect(idsPerguntados("oi", lerConfigDoJev({ jev: { ligado: false, aceite: ACEITE } }))).toEqual([]);
  });

  it("tarefa nova começa observando (R7), e a pergunta leva o estado", () => {
    expect(pedidosAPerguntar(LIGADO, { humano: false, opt_out: false }).map((p) => [p.id, p.estado])).toEqual([
      ["humano", "observando"],
      ["opt_out", "observando"],
    ]);
  });
});

describe("o denominador: só onde o turno do agente rodaria", () => {
  it("com tudo de pé, roda (controle)", () => {
    expect(turnoRodaria(TURNO_QUE_RODA)).toBe(true);
  });

  it.each([
    ["com o atendimento delegado a um sistema de fora (o modo externo, que o dreno descarta)", { atendimentoExterno: true }],
    ["sem ninguém que atenda o número (o portão do dreno, sem os pausados)", { sessaoTemQuemAtenda: false }],
    ["com pessoa no comando, conversa silenciada ou fora da lista do canal", { iaPodeResponder: false }],
    ["com o contato bloqueado", { contatoBloqueado: true }],
    ["com OUTRA conversa do contato com uma pessoa", { contatoComUmaPessoa: true }],
    ["numa conversa de grupo", { grupo: true }],
  ])("%s, não roda", (_caso, fato) => {
    expect(turnoRodaria({ ...TURNO_QUE_RODA, ...fato })).toBe(false);
  });
});

describe("o corte", () => {
  it("pessoa: 0,9; parar de receber: 0,8 — e 'Doy de baja la pauta?' (0,79) segue não, negativo deliberado da regra", () => {
    expect(CORTE_DO_PEDIDO).toEqual({ humano: 0.9, opt_out: 0.8 });
    expect(rotuloDoPedido("humano", 0.9)).toBe("sim");
    expect(rotuloDoPedido("humano", 0.97)).toBe("sim");
    expect(rotuloDoPedido("humano", 0.84)).toBe("nao");
    expect(rotuloDoPedido("humano", 0.8999)).toBe("nao");
    // Parar de receber: os pedidos naturais medidos com a chave real (0,84) contam,
    // e o negativo deliberado da regra ("Doy de baja la pauta?", 0,79) não.
    expect(rotuloDoPedido("opt_out", 0.84)).toBe("sim");
    expect(rotuloDoPedido("opt_out", 0.8)).toBe("sim");
    expect(rotuloDoPedido("opt_out", 0.79)).toBe("nao");
    expect(rotuloDoPedido("opt_out", 0.02)).toBe("nao");
  });
});

// ── observarPedidos: a chamada e a gravação ──────────────────────────────────

type Linha = Record<string, unknown>;

const KINDS_DO_JEV = new Set(["jev_pedido_de_humano", "jev_parar_de_receber"]);

/**
 * Um cliente admin de brinquedo: guarda o que se insere, pode recusar uma
 * tabela, e imita o índice único da 0433 — um aviso do Jev por organização,
 * kind e conversa, QUALQUER que seja o status: o segundo insert volta 23505.
 * Anota cada operação (`tabela.metodo`), e o `update` só existe na Central.
 */
function adminFalso(recusar: Record<string, { code: string; message: string }> = {}, avisos: Linha[] = []) {
  const inseridas: Record<string, Linha[]> = {};
  const operacoes: string[] = [];
  const mesmoAviso = (a: Linha, b: Linha) =>
    a.organization_id === b.organization_id && a.kind === b.kind && a.ref_id === b.ref_id;
  const admin = {
    from: (tabela: string) => ({
      insert: async (linhas: Linha | Linha[]) => {
        operacoes.push(`${tabela}.insert`);
        const erro = recusar[tabela];
        if (erro) return { error: erro };
        const novas = Array.isArray(linhas) ? linhas : [linhas];
        if (tabela === "agent_inbox_items") {
          if (novas.some((n) => KINDS_DO_JEV.has(String(n.kind)) && avisos.some((a) => mesmoAviso(a, n)))) {
            return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          avisos.push(...novas.map((n) => ({ status: "open", ...n })));
        }
        (inseridas[tabela] ??= []).push(...novas);
        return { error: null };
      },
      update: (mudanca: Linha) => {
        operacoes.push(`${tabela}.update`);
        const filtros: Array<[string, unknown]> = [];
        const consulta = {
          eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), consulta),
          then: (ok: (v: { error: null }) => unknown) => {
            for (const a of avisos) if (filtros.every(([c, v]) => a[c] === v)) Object.assign(a, mudanca);
            return Promise.resolve({ error: null }).then(ok);
          },
        };
        return consulta;
      },
    }),
  };
  return { admin: admin as unknown as Parameters<typeof observarPedidos>[0], inseridas, operacoes, avisos };
}

function respostaComNoul(noul: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: Object.fromEntries(Object.entries(noul).map(([id, v]) => [id, { type: "noul", noul: v }])),
      usage: { input_tokens: 420, output_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** O disjuntor é por organização e vive no processo: cada caso usa a sua. */
let seq = 0;
function entrada(over: Partial<EntradaDosPedidos> = {}): EntradaDosPedidos {
  return {
    organizationId: `org-pedidos-${++seq}`,
    conversationId: "33333333-3333-4333-8333-333333333333",
    messageId: "44444444-4444-4444-8444-444444444444",
    contactId: "55555555-5555-4555-8555-555555555555",
    agentId: "66666666-6666-4666-8666-666666666666",
    mensagem: "quero falar com alguém de verdade, meu telefone é (11) 98765-4321",
    idioma: "pt-BR",
    config: LIGADO,
    regraPegou: { humano: false, opt_out: false },
    turno: TURNO_QUE_RODA,
    ...over,
  };
}

const deps = (fetchImpl: ReturnType<typeof vi.fn>) => ({
  buscarChave: async () => "apikey_de_teste_0000",
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

describe("observarPedidos", () => {
  it("pergunta as duas numa chamada só, SEM o telefone, e grava uma linha por pergunta sem texto", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ humano: 0.97, opt_out: 0.02 }));
    const e = entrada();
    const r = await observarPedidos(admin, e, deps(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const corpo = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as {
      state: string;
      questions: Record<string, { type: string }>;
    };
    expect(Object.keys(corpo.questions)).toEqual(["humano", "opt_out"]);
    expect(corpo.questions.humano!.type).toBe("noul");
    expect(corpo.state).toContain("[PHONE]");
    expect(corpo.state).not.toContain("98765-4321");

    expect(r.respondidos.map((p) => [p.id, p.rotulo])).toEqual([
      ["humano", "sim"],
      ["opt_out", "nao"],
    ]);
    expect(r.nova, "a observação desta mensagem entrou agora").toBe(true);
    expect(inseridas.jev_observacoes).toEqual([
      expect.objectContaining({
        organization_id: e.organizationId,
        tarefa: "humano",
        estado: "observando",
        conversation_id: e.conversationId,
        message_id: e.messageId,
        rotulo_jev: "sim",
        probabilidade_jev: 0.97,
        rotulo_atual: "nao",
        modelo: "jev-1.13.0",
      }),
      expect.objectContaining({ tarefa: "opt_out", rotulo_jev: "nao", probabilidade_jev: 0.02, rotulo_atual: "nao" }),
    ]);
    // Nenhuma linha carrega o que o cliente escreveu.
    const tudo = JSON.stringify(inseridas);
    expect(tudo).not.toContain("alguém de verdade");
    expect(tudo).not.toContain("98765");

    expect(inseridas.llm_calls).toEqual([
      expect.objectContaining({
        organization_id: e.organizationId,
        contact_id: e.contactId,
        agent_id: e.agentId,
        purpose: "jev_pedidos",
        provider: "typesafe",
        model: "typesafe/jev-1.13.0",
        input_tokens: 420,
        status: "ok",
        origem_da_escolha: "jev_observacao",
      }),
    ]);
    expect(typeof inseridas.llm_calls![0]!.cost_cents).toBe("number");
  });

  it("a regra pegou uma: só a outra vai na chamada, e só ela é gravada", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ opt_out: 0.3 }));
    await observarPedidos(admin, entrada({ regraPegou: { humano: true, opt_out: false } }), deps(fetchImpl));
    const corpo = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { questions: object };
    expect(Object.keys(corpo.questions)).toEqual(["opt_out"]);
    expect(inseridas.jev_observacoes!.map((l) => l.tarefa)).toEqual(["opt_out"]);
  });

  it.each([
    ["a regra pegou as duas", { regraPegou: { humano: true, opt_out: true } }],
    ["o turno não rodaria", { turno: { ...TURNO_QUE_RODA, contatoBloqueado: true } }],
    ["o número não tem quem atenda", { turno: { ...TURNO_QUE_RODA, sessaoTemQuemAtenda: false } }],
    ["outra conversa do contato está com uma pessoa", { turno: { ...TURNO_QUE_RODA, contatoComUmaPessoa: true } }],
    ["o Jev está desligado", { config: lerConfigDoJev({}) }],
    ["a mensagem é só mídia", { mensagem: "   " }],
  ])("%s: nenhuma chamada, nenhuma linha", async (_caso, over) => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn();
    expect(await observarPedidos(admin, entrada(over), deps(fetchImpl))).toMatchObject({ respondidos: [], nova: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inseridas).toEqual({});
  });

  it("a chave recusada vira linha de erro em Execuções, sem observação", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    expect((await observarPedidos(admin, entrada(), deps(fetchImpl))).respondidos).toEqual([]);
    expect(inseridas.jev_observacoes).toBeUndefined();
    expect(inseridas.llm_calls).toEqual([
      expect.objectContaining({
        purpose: "jev_pedidos",
        status: "erro",
        error_code: "jev_credencial_invalida",
        http_status: 401,
        origem_da_escolha: "jev_observacao",
      }),
    ]);
  });

  it("fora do ar (passa sozinho): nada gravado, e nunca lança", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect((await observarPedidos(admin, entrada(), deps(fetchImpl))).respondidos).toEqual([]);
    expect(inseridas).toEqual({});
  });

  it("a mesma mensagem de novo (retry do dreno): a observação duplicada é recusada, o custo da chamada entra, e ela não é nova", async () => {
    const { admin, inseridas } = adminFalso({ jev_observacoes: { code: "23505", message: "duplicate key" } });
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ humano: 0.5, opt_out: 0.5 }));
    const r = await observarPedidos(admin, entrada(), deps(fetchImpl));
    expect(inseridas.llm_calls).toHaveLength(1);
    expect(r.nova).toBe(false);
  });

  it("uma resposta fora de uma probabilidade não vira observação; a outra, sim", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ humano: 1.7, opt_out: 0.95 }));
    const r = await observarPedidos(admin, entrada(), deps(fetchImpl));
    expect(r.respondidos.map((p) => p.id)).toEqual(["opt_out"]);
    expect(inseridas.jev_observacoes!.map((l) => l.tarefa)).toEqual(["opt_out"]);
  });
});

// ── "Avisar a equipe": o estado decidindo das tarefas em cascata ─────────────

const AVISANDO = (tarefas: Record<string, "decidindo" | "observando" | "desligada">) =>
  lerConfigDoJev({
    jev: {
      ligado: true,
      aceite: ACEITE,
      tarefas: Object.fromEntries(Object.entries(tarefas).map(([id, estado]) => [id, { estado }])),
    },
  });

const CLIMA_NAO_CHAMOU = { chamouUmaPessoa: false };
/** A conversa segue sem ninguém: nem encerrada, nem com uma pessoa. */
const LIVRE: AConversaAgora = { encerrada: false, comUmaPessoa: false };

/** Pergunta, grava e avisa — o que o worker faz, na ordem dele. */
async function observarEAvisar(
  admin: Parameters<typeof observarPedidos>[0],
  e: EntradaDosPedidos,
  noul: Record<string, number>,
  clima = CLIMA_NAO_CHAMOU,
  lerAConversa: () => Promise<AConversaAgora | null> = async () => LIVRE,
) {
  const o = await observarPedidos(admin, e, deps(vi.fn().mockResolvedValue(respostaComNoul(noul))));
  await avisarAEquipe(admin, o, clima, lerAConversa);
  return o;
}

describe("Avisar a equipe", () => {
  it("o pedido percebido abre UM aviso na Central, na conversa, sem o que o cliente escreveu", async () => {
    const { admin, inseridas } = adminFalso();
    const e = entrada({ config: AVISANDO({ humano: "decidindo" }) });
    await observarEAvisar(admin, e, { humano: 0.97, opt_out: 0.02 });

    expect(inseridas.agent_inbox_items).toEqual([
      {
        organization_id: e.organizationId,
        kind: "jev_pedido_de_humano",
        severity: "warn",
        title: AVISOS_DOS_PEDIDOS.humano.titulo,
        body: AVISOS_DOS_PEDIDOS.humano.corpo,
        ref_kind: "conversation",
        ref_id: e.conversationId,
      },
    ]);
    // A Central é lida pela organização inteira: nada do que o cliente escreveu vai para lá.
    const doAviso = JSON.stringify(inseridas.agent_inbox_items);
    expect(doAviso).not.toContain("alguém de verdade");
    expect(doAviso).not.toContain("98765");
    // A observação sai com o estado, e a linha de custo diz que a resposta dele decidiu o aviso.
    expect(inseridas.jev_observacoes!.map((l) => [l.tarefa, l.estado, l.rotulo_jev])).toEqual([
      ["humano", "decidindo", "sim"],
      ["opt_out", "observando", "nao"],
    ]);
    expect(inseridas.llm_calls![0]).toMatchObject({ origem_da_escolha: "jev", status: "ok" });
  });

  /**
   * O corpo fica aberto na Central por dias: ele não pode afirmar o que muda
   * enquanto isso — com quem a conversa está, que nada foi bloqueado, qual é
   * "a última" mensagem.
   */
  it("o texto do aviso não afirma estado que muda depois de ele abrir", () => {
    for (const aviso of Object.values(AVISOS_DOS_PEDIDOS)) {
      for (const texto of [aviso.titulo, aviso.corpo, DICIONARIO[aviso.corpo]?.es ?? ""]) {
        expect(texto).not.toMatch(/segue com o assistente|nada foi bloqueado|última mensagem|sigue con el asistente|nada fue bloqueado|último mensaje/i);
      }
    }
  });

  /**
   * Não há bloqueio à mão no produto: o único escritor do bloqueio é o STOP do
   * próprio cliente (`lib/channels/pos-entrada.ts`; a tela do contato diz o
   * mesmo). Nenhum texto do pedido de parar de receber — o aviso, a orientação
   * da Central, a linha e o diálogo do cartão — pode prometer que uma pessoa
   * bloqueia. O aviso diz o que a equipe PODE fazer: pedir ao cliente a palavra
   * que a regra bloqueia — e a palavra citada, em cada idioma, é uma que ela de
   * fato bloqueia.
   */
  it("o pedido de parar de receber não promete bloqueio por uma pessoa, e cita uma palavra que a regra de fato bloqueia", () => {
    const zh = JSON.parse(readFileSync("lib/i18n/traducoes/zh-CN.json", "utf8")) as Record<string, string>;
    const t = TAREFA_DO_PEDIDO_PARA_PARAR;
    const comAPalavra = [AVISOS_DOS_PEDIDOS.opt_out.corpo, t.aoDecidir, t.aoConfirmarDecidir, t.oQueFaz];
    const semPessoa = [...comAPalavra, POLITICAS_DE_AVISO.jev_parar_de_receber.orientacao];
    for (const pt of semPessoa) {
      for (const texto of [pt, DICIONARIO[pt]?.es, zh[pt]]) {
        expect(texto, `a tradução de "${pt.slice(0, 40)}…" existe (controle)`).toBeTruthy();
        expect(texto).not.toMatch(/pessoa|persona|人工/i);
      }
    }
    for (const pt of comAPalavra) {
      for (const texto of [pt, DICIONARIO[pt]?.es ?? "", zh[pt] ?? ""]) {
        const palavra = /\b[A-Z]{4,}\b/.exec(texto)?.[0] ?? "";
        expect(ehPedidoDeOptOut(palavra), `"${palavra}" em: ${texto.slice(0, 60)}…`).toBe(true);
      }
    }
  });

  it("no idioma da organização: a Central mostra o aviso como ele foi gravado", async () => {
    const { admin, inseridas } = adminFalso();
    await observarEAvisar(admin, entrada({ idioma: "es", config: AVISANDO({ opt_out: "decidindo" }) }), { humano: 0.02, opt_out: 0.95 });
    const [aviso] = inseridas.agent_inbox_items!;
    expect(aviso).toMatchObject({ kind: "jev_parar_de_receber" });
    expect(aviso!.title).toBe(DICIONARIO[AVISOS_DOS_PEDIDOS.opt_out.titulo]?.es);
    expect(aviso!.body).toBe(DICIONARIO[AVISOS_DOS_PEDIDOS.opt_out.corpo]?.es);
  });

  it.each([
    ["observando, ele percebe e só conta", AVISANDO({}), 0.97],
    ["abaixo do corte (0,79), nenhum aviso", AVISANDO({ humano: "decidindo" }), 0.79],
  ])("%s", async (_caso, config, noul) => {
    const { admin, inseridas } = adminFalso();
    await observarEAvisar(admin, entrada({ config }), { humano: noul, opt_out: 0.02 });
    expect(inseridas.jev_observacoes, "a pergunta saiu (controle)").toHaveLength(2);
    expect(inseridas.agent_inbox_items).toBeUndefined();
  });

  it("observando, a linha de custo diz que ele só observou (controle da origem)", async () => {
    const { admin, inseridas } = adminFalso();
    await observarEAvisar(admin, entrada(), { humano: 0.97, opt_out: 0.02 });
    expect(inseridas.llm_calls![0]).toMatchObject({ origem_da_escolha: "jev_observacao" });
  });

  it("o clima da mesma mensagem chamou uma pessoa: o aviso de pessoa não abre, o de parar de receber abre, e as duas observações ficam", async () => {
    const { admin, inseridas } = adminFalso();
    const e = entrada({ config: AVISANDO({ humano: "decidindo", opt_out: "decidindo" }) });
    await observarEAvisar(admin, e, { humano: 0.97, opt_out: 0.96 }, { chamouUmaPessoa: true });
    expect(inseridas.agent_inbox_items!.map((l) => l.kind)).toEqual(["jev_parar_de_receber"]);
    expect(inseridas.jev_observacoes!.map((l) => [l.tarefa, l.rotulo_jev])).toEqual([
      ["humano", "sim"],
      ["opt_out", "sim"],
    ]);
  });

  it("o retry do dreno sobre a mesma mensagem não avisa: a primeira execução já decidiu", async () => {
    const { admin, operacoes } = adminFalso({ jev_observacoes: { code: "23505", message: "duplicate key" } });
    await observarEAvisar(admin, entrada({ config: AVISANDO({ humano: "decidindo" }) }), { humano: 0.97, opt_out: 0.02 });
    expect(operacoes.filter((o) => o.startsWith("agent_inbox_items"))).toEqual([]);
  });

  /**
   * Um aviso por conversa e pedido é do banco (o índice único da 0433, sem
   * status): o insert do segundo volta 23505, e o pedido novo REABRE o que
   * existe — o resolvido volta a aberto, e o aberto fica como está.
   */
  it("o aviso desta conversa e deste pedido já existe: o pedido novo o reabre, sem abrir outro — e a vizinha ganha o dela", async () => {
    const e = entrada({ config: AVISANDO({ humano: "decidindo" }) });
    const resolvido = {
      organization_id: e.organizationId,
      kind: "jev_pedido_de_humano",
      ref_kind: "conversation",
      ref_id: e.conversationId,
      status: "resolved",
      resolved_at: "2026-09-20T00:00:00.000Z",
      created_at: "2026-07-26T00:00:00.000Z",
    };
    const { admin, inseridas, avisos, operacoes } = adminFalso({}, [resolvido]);
    const antes = Date.now();
    await observarEAvisar(admin, e, { humano: 0.97, opt_out: 0.02 });
    expect(inseridas.agent_inbox_items).toBeUndefined();
    expect(avisos).toEqual([expect.objectContaining({ ref_id: e.conversationId, status: "open", resolved_at: null })]);
    expect(operacoes).toContain("agent_inbox_items.update");
    // A Central ordena e data pelo `created_at`: o pedido de agora não pode
    // aparecer "há 2 meses", abaixo dos avisos mais novos.
    expect(Date.parse(String(avisos[0]!.created_at)), "o aviso reaberto tem a data do pedido novo").toBeGreaterThanOrEqual(antes);

    const vizinha = "77777777-7777-4777-8777-777777777777";
    await observarEAvisar(admin, { ...e, conversationId: vizinha }, { humano: 0.97, opt_out: 0.02 });
    expect(inseridas.agent_inbox_items!.map((l) => l.ref_id)).toEqual([vizinha]);
    expect(avisos).toHaveLength(2);
  });

  it("o aviso ainda aberto e um pedido novo: ele sobe para a data de agora, sem abrir outro", async () => {
    const e = entrada({ config: AVISANDO({ humano: "decidindo" }) });
    const aberto = {
      organization_id: e.organizationId,
      kind: "jev_pedido_de_humano",
      ref_kind: "conversation",
      ref_id: e.conversationId,
      status: "open",
      created_at: "2026-07-26T00:00:00.000Z",
    };
    const { admin, avisos } = adminFalso({}, [aberto]);
    const antes = Date.now();
    await observarEAvisar(admin, e, { humano: 0.97, opt_out: 0.02 });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ status: "open" });
    expect(Date.parse(String(avisos[0]!.created_at))).toBeGreaterThanOrEqual(antes);
  });

  it("o mesmo pedido de outro tipo na mesma conversa é outro aviso", async () => {
    const e = entrada({ config: AVISANDO({ humano: "decidindo", opt_out: "decidindo" }) });
    const { admin, inseridas } = adminFalso({}, [
      { organization_id: e.organizationId, kind: "jev_pedido_de_humano", ref_kind: "conversation", ref_id: e.conversationId, status: "open" },
    ]);
    await observarEAvisar(admin, e, { humano: 0.97, opt_out: 0.96 });
    expect(inseridas.agent_inbox_items!.map((l) => l.kind)).toEqual(["jev_parar_de_receber"]);
  });

  /**
   * O aviso é gravado depois do clima, e a conversa pode ter ido para uma pessoa
   * nesse meio — o turno da rajada passou, alguém assumiu. O gatilho da 0433
   * que o fecharia disparou quando ele ainda não existia: relida a conversa, o
   * aviso de um pedido já atendido não nasce. As condições são as do gatilho:
   * encerrada vale para os dois; com uma pessoa (assumida ou passada), só para
   * o de falar com uma pessoa — o de parar de receber pede que a equipe assuma
   * E peça o PARAR, e fecha no bloqueio do contato.
   */
  it.each([
    ["com uma pessoa (assumida ou passada depois da mensagem)", { encerrada: false, comUmaPessoa: true }, ["jev_parar_de_receber"]],
    ["encerrada", { encerrada: true, comUmaPessoa: false }, []],
    ["encerrada e com uma pessoa", { encerrada: true, comUmaPessoa: true }, []],
    ["sem ninguém (controle)", LIVRE, ["jev_pedido_de_humano", "jev_parar_de_receber"]],
    ["não deu para ler: o aviso abre (é informação)", null, ["jev_pedido_de_humano", "jev_parar_de_receber"]],
  ] as const)("a conversa, relida antes do aviso, %s", async (_caso, conversa, kinds) => {
    const { admin, inseridas } = adminFalso();
    const e = entrada({ config: AVISANDO({ humano: "decidindo", opt_out: "decidindo" }) });
    const o = await observarEAvisar(admin, e, { humano: 0.97, opt_out: 0.96 }, CLIMA_NAO_CHAMOU, async () => conversa);
    expect(o.respondidos.map((p) => p.rotulo), "os dois pedidos passaram do corte (controle)").toEqual(["sim", "sim"]);
    expect((inseridas.agent_inbox_items ?? []).map((l) => l.kind)).toEqual(kinds);
    expect(inseridas.jev_observacoes, "a observação fica gravada do mesmo jeito").toHaveLength(2);
  });

  it("a conversa só é relida quando há o que avisar", async () => {
    const lerAConversa = vi.fn(async () => LIVRE);
    const { admin } = adminFalso();
    await observarEAvisar(admin, entrada({ config: AVISANDO({ humano: "decidindo" }) }), { humano: 0.5, opt_out: 0.02 }, CLIMA_NAO_CHAMOU, lerAConversa);
    expect(lerAConversa).not.toHaveBeenCalled();
    await observarEAvisar(admin, entrada({ config: AVISANDO({ humano: "decidindo" }) }), { humano: 0.97, opt_out: 0.02 }, CLIMA_NAO_CHAMOU, lerAConversa);
    expect(lerAConversa).toHaveBeenCalledTimes(1);
  });

  /**
   * Só o 23505 é o retry do dreno. A observação que falhou por outro motivo
   * não tem quem a recupere (o worker nunca lança, e o evento fecha): o Jev
   * disse sim, e o aviso sai.
   */
  it("a observação falhou por outro motivo que não o retry: ainda é nova, e o aviso sai", async () => {
    const { admin, inseridas } = adminFalso({ jev_observacoes: { code: "57014", message: "canceling statement due to statement timeout" } });
    const o = await observarEAvisar(admin, entrada({ config: AVISANDO({ humano: "decidindo" }) }), { humano: 0.97, opt_out: 0.02 });
    expect(o.nova).toBe(true);
    expect(inseridas.agent_inbox_items!.map((l) => l.kind)).toEqual(["jev_pedido_de_humano"]);
  });

  /**
   * R3 com os dois pedidos avisando: o que ele toca é só o que é dele e a
   * Central — nem a conversa, nem o contato, nem mensagem. A cerca estática é
   * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`; aqui, o caminho
   * que roda.
   */
  it("R3: avisando, ele só escreve as tabelas dele e a Central — e nunca lança", async () => {
    const e = entrada({ config: AVISANDO({ humano: "decidindo", opt_out: "decidindo" }) });
    const { admin, inseridas, operacoes } = adminFalso({}, [
      { organization_id: e.organizationId, kind: "jev_parar_de_receber", ref_kind: "conversation", ref_id: e.conversationId, status: "resolved" },
    ]);
    const o = await observarEAvisar(admin, e, { humano: 0.99, opt_out: 0.99 });
    expect(o.respondidos.map((p) => p.rotulo)).toEqual(["sim", "sim"]);
    expect(inseridas.agent_inbox_items!.map((l) => l.kind)).toEqual(["jev_pedido_de_humano"]);
    expect([...new Set(operacoes)].sort()).toEqual([
      "agent_inbox_items.insert",
      "agent_inbox_items.update",
      "jev_observacoes.insert",
      "llm_calls.insert",
    ]);
  });

  it("a Central recusa a escrita: o aviso some, a observação e o custo ficam, e nada lança", async () => {
    const { admin, inseridas } = adminFalso({ agent_inbox_items: { code: "23514", message: "check violation" } });
    const o = await observarEAvisar(admin, entrada({ config: AVISANDO({ humano: "decidindo" }) }), { humano: 0.97, opt_out: 0.02 });
    expect(o.respondidos).toHaveLength(2);
    expect(inseridas.jev_observacoes).toHaveLength(2);
    expect(inseridas.llm_calls).toHaveLength(1);
    expect(inseridas.agent_inbox_items).toBeUndefined();
  });
});
