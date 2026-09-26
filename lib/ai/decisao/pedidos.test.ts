/**
 * OS PEDIDOS DO CLIENTE PERGUNTADOS AO JEV — a cascata, o denominador, o corte
 * e o que se grava.
 *
 * A regra de hoje entra aqui como ela é (`lib/opt-out/deteccao.ts` e a detecção
 * de pedido de pessoa do turno), para a cascata ser provada com as frases de
 * verdade, e não com um `true` escrito à mão. O caminho pelo worker de clima,
 * com a leitura dos fatos do turno, é `tests/unit/clima-da-conversa-no-worker.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import {
  CORTE_DO_PEDIDO,
  observarPedidos,
  pedidosAPerguntar,
  rotuloDoPedido,
  turnoRodaria,
  type EntradaDosPedidos,
  type FatosDoTurno,
  type RegraPegou,
} from "@/lib/ai/decisao/pedidos";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

const ADMIN = "22222222-2222-4222-8222-222222222222";
const ACEITE = { em: "2026-09-23T12:00:00.000Z", por: ADMIN };
const LIGADO = lerConfigDoJev({ jev: { ligado: true, aceite: ACEITE } });
const TURNO_QUE_RODA: FatosDoTurno = { agenteAtende: true, iaPodeResponder: true, contatoBloqueado: false, grupo: false };

/** A regra de hoje sobre a frase — a mesma que o worker roda (sem as palavras do agente). */
function regraDeHoje(texto: string): RegraPegou {
  return { humano: detectHumanHandoffRequest(texto), opt_out: ehPedidoDeOptOut(texto) || ehOptOutProvavel(texto) };
}

const idsPerguntados = (texto: string, config = LIGADO) =>
  pedidosAPerguntar(config, regraDeHoje(texto)).map((p) => p.id);

describe("a cascata: o Jev só é perguntado onde a regra de hoje disse não", () => {
  it("a frase natural que a regra não pega: as duas perguntas saem", () => {
    const frase = "quero falar com alguém de verdade aí, não com robô";
    // Controle: a regra de hoje, de fato, não pega nenhum dos dois.
    expect(regraDeHoje(frase)).toEqual({ humano: false, opt_out: false });
    expect(idsPerguntados(frase)).toEqual(["humano", "opt_out"]);
  });

  it("a regra de descadastro pegou: a pergunta de parar de receber NÃO sai; a de pessoa sai", () => {
    // Inequívoca (bloqueia na entrada) e provável (só para de responder): as duas contam.
    for (const frase of ["PARAR", "me deixa em paz"]) {
      expect(regraDeHoje(frase).opt_out, frase).toBe(true);
      expect(idsPerguntados(frase), frase).toEqual(["humano"]);
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
    ["sem agente no ar atendendo", { agenteAtende: false }],
    ["com pessoa no comando, conversa silenciada ou fora da lista do canal", { iaPodeResponder: false }],
    ["com o contato bloqueado", { contatoBloqueado: true }],
    ["numa conversa de grupo", { grupo: true }],
  ])("%s, não roda", (_caso, fato) => {
    expect(turnoRodaria({ ...TURNO_QUE_RODA, ...fato })).toBe(false);
  });
});

describe("o corte", () => {
  it("0,9 é sim; 'Doy de baja la pauta?' (0,79) é não — negativo deliberado da regra", () => {
    expect(CORTE_DO_PEDIDO).toBe(0.9);
    expect(rotuloDoPedido(0.9)).toBe("sim");
    expect(rotuloDoPedido(0.97)).toBe("sim");
    expect(rotuloDoPedido(0.79)).toBe("nao");
    expect(rotuloDoPedido(0.8999)).toBe("nao");
  });
});

// ── observarPedidos: a chamada e a gravação ──────────────────────────────────

type Linha = Record<string, unknown>;

/** Um cliente admin de brinquedo: guarda o que se insere, e pode recusar uma tabela. */
function adminFalso(recusar: Record<string, { code: string; message: string }> = {}) {
  const inseridas: Record<string, Linha[]> = {};
  const admin = {
    from: (tabela: string) => ({
      insert: async (linhas: Linha | Linha[]) => {
        const erro = recusar[tabela];
        if (erro) return { error: erro };
        (inseridas[tabela] ??= []).push(...(Array.isArray(linhas) ? linhas : [linhas]));
        return { error: null };
      },
    }),
  };
  return { admin: admin as unknown as Parameters<typeof observarPedidos>[0], inseridas };
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

    expect(r.map((p) => [p.id, p.rotulo])).toEqual([
      ["humano", "sim"],
      ["opt_out", "nao"],
    ]);
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
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ humano: 0.3 }));
    await observarPedidos(admin, entrada({ regraPegou: { humano: false, opt_out: true } }), deps(fetchImpl));
    const corpo = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)) as { questions: object };
    expect(Object.keys(corpo.questions)).toEqual(["humano"]);
    expect(inseridas.jev_observacoes!.map((l) => l.tarefa)).toEqual(["humano"]);
  });

  it.each([
    ["a regra pegou as duas", { regraPegou: { humano: true, opt_out: true } }],
    ["o turno não rodaria", { turno: { ...TURNO_QUE_RODA, contatoBloqueado: true } }],
    ["o Jev está desligado", { config: lerConfigDoJev({}) }],
    ["a mensagem é só mídia", { mensagem: "   " }],
  ])("%s: nenhuma chamada, nenhuma linha", async (_caso, over) => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn();
    expect(await observarPedidos(admin, entrada(over), deps(fetchImpl))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inseridas).toEqual({});
  });

  it("a chave recusada vira linha de erro em Execuções, sem observação", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await observarPedidos(admin, entrada(), deps(fetchImpl))).toEqual([]);
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
    expect(await observarPedidos(admin, entrada(), deps(fetchImpl))).toEqual([]);
    expect(inseridas).toEqual({});
  });

  it("a mesma mensagem de novo (retry do dreno): a observação duplicada é recusada, o custo da chamada entra", async () => {
    const { admin, inseridas } = adminFalso({ jev_observacoes: { code: "23505", message: "duplicate key" } });
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ humano: 0.5, opt_out: 0.5 }));
    await observarPedidos(admin, entrada(), deps(fetchImpl));
    expect(inseridas.llm_calls).toHaveLength(1);
  });

  it("uma resposta fora de uma probabilidade não vira observação; a outra, sim", async () => {
    const { admin, inseridas } = adminFalso();
    const fetchImpl = vi.fn().mockResolvedValue(respostaComNoul({ humano: 1.7, opt_out: 0.95 }));
    const r = await observarPedidos(admin, entrada(), deps(fetchImpl));
    expect(r.map((p) => p.id)).toEqual(["opt_out"]);
    expect(inseridas.jev_observacoes!.map((l) => l.tarefa)).toEqual(["opt_out"]);
  });
});
