/**
 * INTERLOCUTOR AUTOMÁTICO (#4590, item 2) — o outro lado é um robô.
 *
 * O defeito medido: um contato que era o atendimento automático de um banco
 * respondeu à IA, e os dois trocaram ~216 mensagens em uma hora, uma a cada
 * ~18 s. O teto por conversa (item 1, já na main) corta a contagem; esta régua
 * reconhece o robô ANTES de a conversa virar pingue-pongue.
 *
 * O que este arquivo prova, e por quê:
 *
 *  1. **menu numerado repetido + respostas da IA no mesmo molde → barra e não
 *     envia.** É o retrato do incidente: duas mensagens idênticas com menu e a
 *     IA já respondendo no mesmo molde.
 *  2. **menu numerado UMA vez, com conversa humana depois → NÃO barra.** É o
 *     controle do falso positivo que o mantenedor temia: loja com "1 - vendas"
 *     é cliente de verdade.
 *  3. **conversa humana normal longa → nunca barra.** O controle mais largo.
 *  4. **ao barrar há aviso na Central e a conversa fica silenciada** — e, se o
 *     aviso não grava, o silêncio NÃO é aplicado.
 *  5. **o teto do item 1 segue como está** — 20 respostas saem, a 21ª é vetada
 *     com `teto_de_respostas`, antes deste gate.
 *
 * Pool/cliente falsos no molde de `teto-de-respostas.test.ts`: o que se
 * exercita é o runner de verdade (`runBeforeSend`), não o gate de mentira.
 */
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  AMOSTRA_DE_MENSAGENS,
  CODIGO_DO_INTERLOCUTOR_AUTOMATICO,
  MOTIVO_DO_SILENCIO_DO_INTERLOCUTOR,
  TITULO_DO_AVISO_DO_INTERLOCUTOR_AUTOMATICO,
  avaliarInterlocutor,
  carregarQuadroDoInterlocutor,
  ehMenuNumerado,
  interlocutorEhAutomatico,
  silenciarConversaPorInterlocutorAutomatico,
} from "@/lib/agent-engine/agent/interlocutor-automatico";
import type { MensagemDaAmostra } from "@/lib/agent-engine/agent/interlocutor-automatico";
import {
  CODIGO_DO_TETO_DE_RESPOSTAS,
  TETO_DE_RESPOSTAS_PADRAO,
} from "@/lib/agent-engine/agent/teto-de-respostas";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** O mínimo que as duas funções de leitura/escrita pedem do banco. */
type Queryable = Pick<pg.Pool, "query">;

const ORG = "00000000-0000-4000-8000-000000000001";
const CONVERSA = "00000000-0000-4000-8000-0000000000a1";
const LEAD = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";
const CANAL = "00000000-0000-4000-8000-000000000004";

const COMECO = new Date("2026-11-10T13:00:00Z"); // 10h BRT, terça

const MENU = "1 - Consultar saldo\n2 - Fazer pagamento\n3 - Falar com atendente";

function recebida(body: string, sentAt: Date): MensagemDaAmostra {
  return { direction: "inbound", body, sentAt, sentVia: null };
}

function respostaDaIa(body: string, sentAt: Date): MensagemDaAmostra {
  return { direction: "outbound", body, sentAt, sentVia: "ai" };
}

/**
 * Bancada: um "banco" com `messages` em memória.
 *
 * Responde às DUAS leituras que a cadeia faz nesta fatia — a contagem do teto
 * (item 1) e a amostra do interlocutor (item 2) — e devolve `rows: []` para o
 * resto, que é a "instalação sem nada configurado" dos testes vizinhos.
 */
function bancada(opcoes: { amostra?: MensagemDaAmostra[]; falharAmostra?: boolean } = {}) {
  const consultas: { sql: string; params: unknown[] }[] = [];
  const amostra = [...(opcoes.amostra ?? [])].sort(
    (a, b) => a.sentAt.getTime() - b.sentAt.getTime(),
  );

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      if (sql.includes("count(*)::int as na_janela")) {
        const [organizationId, conversationId, desde] = params as [string, string, Date];
        const dentro = amostra.filter(
          (m) =>
            m.direction === "outbound" &&
            m.sentVia === "ai" &&
            m.sentAt.getTime() >= new Date(desde).getTime(),
        );
        void organizationId;
        void conversationId;
        return {
          rows: [
            {
              na_janela: dentro.length,
              mais_antiga:
                dentro.length === 0
                  ? null
                  : new Date(Math.min(...dentro.map((m) => m.sentAt.getTime()))),
            },
          ],
        };
      }
      if (sql.includes("select m.direction, m.body, m.sent_at, m.sent_via")) {
        if (opcoes.falharAmostra === true) throw new Error('relation "messages" does not exist');
        // O banco devolve do mais novo para o mais velho — é o `order by ... desc`,
        // e com os nomes das COLUNAS (`sent_at`), não os do nosso objeto.
        return {
          rows: [...amostra]
            .reverse()
            .map((m) => ({
              direction: m.direction,
              body: m.body,
              sent_at: m.sentAt,
              sent_via: m.sentVia,
            })),
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [{ id: "trace-1" }] })),
  } as unknown as pg.Pool;

  return { pool, client, consultas, amostra };
}

function loggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** Uma tentativa de envio COM a cadeia real, armada no formato que o turno usa. */
function tentaEnviar(
  b: ReturnType<typeof bancada>,
  now: Date,
  body = "Claro! Em que posso ajudar?",
  comTeto = false,
) {
  const send = vi.fn(async () => ({ kind: "sent" as const, idempotencyKey: "k", messageId: "m" }));
  const resultado = runBeforeSend({
    pool: b.pool,
    log: loggerFalso(),
    tenantId: ORG,
    leadId: LEAD,
    jobId: JOB,
    channelSessionId: CANAL,
    body,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    resposta: true,
    interlocutorAutomatico: { conversationId: CONVERSA },
    ...(comTeto
      ? { tetoDeRespostas: { conversationId: CONVERSA, porConversa: TETO_DE_RESPOSTAS_PADRAO, janelaMinutos: 60 } }
      : {}),
    now,
    rng: () => 0,
    sleep: async () => {},
    send,
  });
  return { resultado, send };
}

describe("menu repetido + respostas da IA no mesmo molde", () => {
  it("barra e NÃO envia — é o retrato do incidente", async () => {
    const b = bancada({
      amostra: [
        recebida(MENU, new Date(COMECO.getTime() - 60_000)),
        // A MESMA mensagem outra vez, 15 s depois: repetição + menu.
        recebida(MENU, new Date(COMECO.getTime() - 45_000)),
        // A IA já respondeu no mesmo molde 3 vezes — o pingue-pongue instalado.
        respostaDaIa("Olá! Sou o assistente virtual e posso ajudar com o seu saldo agora", new Date(COMECO.getTime() - 40_000)),
        respostaDaIa("Olá! Sou o assistente virtual e posso ajudar com o seu pedido hoje", new Date(COMECO.getTime() - 30_000)),
        respostaDaIa("Olá! Sou o assistente virtual e posso ajudar com a sua conta aqui", new Date(COMECO.getTime() - 20_000)),
      ],
    });

    const { resultado, send } = tentaEnviar(b, COMECO);
    const r = await resultado;

    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("interlocutor_automatico");
    expect(r.code).toBe(CODIGO_DO_INTERLOCUTOR_AUTOMATICO);
    expect(r.message).toMatch(/ATENDIMENTO AUTOMÁTICO/);
    expect(r.message).toMatch(/Encerre o turno/);
    // "não responde aquela mensagem": o canal não foi tocado.
    expect(send).not.toHaveBeenCalled();
    expect(r.trace).toContainEqual({
      gate: "interlocutor_automatico",
      verdict: "veto",
      code: CODIGO_DO_INTERLOCUTOR_AUTOMATICO,
      detail: { pistas: 3, familias: "menu,molde_da_ia", recebidas: 2 },
    });
  });

  it("a régua do disparo exige 3 pistas E 2 famílias", () => {
    expect(interlocutorEhAutomatico({ pistas: 3, familias: ["menu", "repeticao"] })).toBe(true);
    expect(interlocutorEhAutomatico({ pistas: 2, familias: ["menu", "repeticao"] })).toBe(false);
    expect(interlocutorEhAutomatico({ pistas: 5, familias: ["menu"] })).toBe(false);
  });
});

describe("um menu sozinho não pode calar uma loja", () => {
  it("menu numerado UMA vez com conversa humana depois → não barra", async () => {
    const b = bancada({
      amostra: [
        recebida(MENU, new Date(COMECO.getTime() - 300_000)),
        recebida("oi, apertei 1 sem querer, queria falar com uma pessoa sobre a minha compra", new Date(COMECO.getTime() - 240_000)),
        recebida("o pedido chegou com a caixa amassada, consegue me ajudar?", new Date(COMECO.getTime() - 120_000)),
        respostaDaIa("Claro! Pode me passar o número do pedido?", new Date(COMECO.getTime() - 100_000)),
        recebida("é o pedido 88231, comprei na semana passada", new Date(COMECO.getTime() - 80_000)),
      ],
    });

    const { resultado, send } = tentaEnviar(b, COMECO);
    const r = await resultado;

    expect(r.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a MESMA mensagem só duas vezes é reenvio, não robô — repetição exige três", () => {
    const amostra = [
      recebida("segue o comprovante do pix que eu acabei de mandar", new Date(COMECO.getTime() - 600_000)),
      recebida("segue o comprovante do pix que eu acabei de mandar", new Date(COMECO.getTime() - 540_000)),
    ];
    const { pistas, familias } = avaliarInterlocutor(amostra);
    expect(pistas).toBe(0);
    expect(familias).toEqual([]);
  });

  it("o turno sintético reusa a MESMA fixture em segundos e não pode ser barrado", async () => {
    // Lição medida no e2e `qa-l12-funil › próxima ação`: a fixture entrega o
    // mesmo corpo JSON mais de uma vez, em segundos. Isso não é URA — e o turno
    // precisa enviar.
    const mesmo = JSON.stringify({ next_action: "Responder o cliente" });
    const b = bancada({
      amostra: [
        recebida(mesmo, new Date(COMECO.getTime() - 6_000)),
        recebida(JSON.stringify({ next_action: "Enviar o orçamento até sexta" }), new Date(COMECO.getTime() - 4_000)),
        recebida(mesmo, new Date(COMECO.getTime() - 2_000)),
        recebida(JSON.stringify({ next_action: null }), new Date(COMECO.getTime() - 1_000)),
      ],
    });
    const { resultado, send } = tentaEnviar(b, COMECO, "Obrigado. Confirmação 1234.");
    expect((await resultado).status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("o detector de menu exige a lista numerada inteira ou a instrução explícita", () => {
    // Loja com UM item numerado não é menu de URA.
    expect(ehMenuNumerado("1 - vendas")).toBe(false);
    expect(ehMenuNumerado(MENU)).toBe(true);
    expect(ehMenuNumerado("Digite 1 para falar com o atendimento")).toBe(true);
  });
});

describe("conversa humana normal", () => {
  it("conversa longa, variada e em ritmo de gente → nunca barra", async () => {
    const textos = [
      "bom dia, tudo bem? vi o anúncio de vocês no instagram",
      "queria saber se tem o modelo em azul e qual o prazo de entrega pra capital",
      "meu cep é 01310-100, moro perto da avenida paulista",
      "e vocês parcelam em quantas vezes no cartão?",
      "prefiro retirar na loja se der, consigo passar lá amanhã de manhã",
      "fechado, pode separar um pra mim então",
      "só uma dúvida: a garantia cobre troca de tamanho?",
      "ótimo, obrigado pelo atendimento!",
    ];
    const amostra: MensagemDaAmostra[] = textos.map((t, i) =>
      recebida(t, new Date(COMECO.getTime() - (textos.length - i) * 180_000)),
    );
    // Respostas da IA variadas, também em ritmo humano.
    amostra.push(
      respostaDaIa("Bom dia! Temos sim, em azul e em preto. O prazo para a capital é de 2 dias úteis.", new Date(COMECO.getTime() - 1_500_000)),
      respostaDaIa("Parcelamos em até 6x sem juros no cartão. A retirada na loja fica pronta no mesmo dia.", new Date(COMECO.getTime() - 900_000)),
      respostaDaIa("A garantia cobre troca de tamanho em até 30 dias, com a etiqueta no lugar.", new Date(COMECO.getTime() - 300_000)),
    );

    const { pistas, familias } = avaliarInterlocutor(amostra);
    expect(pistas).toBe(0);
    expect(familias).toEqual([]);

    const b = bancada({ amostra });
    const { resultado, send } = tentaEnviar(b, COMECO);
    expect((await resultado).status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a leitura que falha passa com registro, nunca derruba o turno", async () => {
    const b = bancada({ falharAmostra: true });
    const quadro = await carregarQuadroDoInterlocutor(b.client as unknown as Queryable, {
      organizationId: ORG,
      conversationId: CONVERSA,
      log: loggerFalso(),
    });
    expect(quadro.naoConferido).toBe(true);

    const { resultado, send } = tentaEnviar(b, COMECO);
    const r = await resultado;
    expect(r.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.trace).toContainEqual({
      gate: "interlocutor_automatico",
      verdict: "skipped",
      code: "nao_conferido",
    });
  });
});

describe("ao barrar: aviso na Central e conversa silenciada", () => {
  it("grava o aviso (kind other, ref conversation) e só depois silencia a conversa", async () => {
    const chamadas: { sql: string; params: unknown[] }[] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        chamadas.push({ sql, params: params ?? [] });
        if (/insert into agent_inbox_items/.test(sql)) return { rows: [{ id: "item-1" }] };
        return { rows: [] };
      }),
    };

    const desfecho = await silenciarConversaPorInterlocutorAutomatico(
      db as unknown as Queryable,
      {
        organizationId: ORG,
        conversationId: CONVERSA,
        pistas: 3,
        familias: ["menu", "repeticao"],
        log: loggerFalso(),
      },
    );

    expect(desfecho).toEqual({ avisado: true, silenciada: true });

    const aviso = chamadas.find((c) => /insert into agent_inbox_items/.test(c.sql));
    expect(aviso, "nenhum aviso na Central").toBeDefined();
    expect(aviso?.params).toContain("other");
    expect(aviso?.params).toContain(TITULO_DO_AVISO_DO_INTERLOCUTOR_AUTOMATICO);
    expect(aviso?.params).toContain("conversation");
    expect(aviso?.params).toContain(CONVERSA);

    const silencio = chamadas.find((c) => /update conversations/.test(c.sql));
    expect(silencio, "conversa não silenciada").toBeDefined();
    expect(silencio?.sql).toContain("bot_silenced_until = 'infinity'");
    expect(silencio?.params).toEqual([ORG, CONVERSA, MOTIVO_DO_SILENCIO_DO_INTERLOCUTOR]);
    // A ordem é a regra: primeiro o aviso, depois o silêncio.
    expect(chamadas.indexOf(aviso!)).toBeLessThan(chamadas.indexOf(silencio!));
    // Sem coluna nova, e sem marcar o CONTATO como sempre-humano.
    expect(silencio?.sql).not.toContain("force_human");
    expect(silencio?.sql).not.toContain("contacts");
  });

  it("sem aviso na Central, NÃO silencia — silêncio sem aviso é proibido", async () => {
    const updates: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        if (/insert into agent_inbox_items/.test(sql)) throw new Error("inbox fora do ar");
        if (/update conversations/.test(sql)) updates.push(sql);
        return { rows: [] };
      }),
    };

    const desfecho = await silenciarConversaPorInterlocutorAutomatico(
      db as unknown as Queryable,
      {
        organizationId: ORG,
        conversationId: CONVERSA,
        pistas: 3,
        familias: ["menu", "repeticao"],
        log: loggerFalso(),
      },
    );

    expect(desfecho).toEqual({ avisado: false, silenciada: false });
    expect(updates).toEqual([]);
  });
});

describe("o teto do item 1 continua como está", () => {
  it("20 respostas saem, a 21ª é vetada pelo teto — antes deste gate", async () => {
    const amostra: MensagemDaAmostra[] = [
      recebida("oi, queria saber o horário de funcionamento", new Date(COMECO.getTime() - 3_600_000)),
    ];
    // 20 respostas da IA já na janela, com texto VARIADO (sem molde).
    for (let i = 0; i < TETO_DE_RESPOSTAS_PADRAO; i += 1) {
      amostra.push(
        respostaDaIa(
          `Resposta número ${i + 1} sobre o horário de funcionamento da loja nesta semana`,
          new Date(COMECO.getTime() - (TETO_DE_RESPOSTAS_PADRAO - i) * 60_000),
        ),
      );
    }
    const b = bancada({ amostra });

    const { resultado, send } = tentaEnviar(b, COMECO, "Claro! Em que posso ajudar?", true);
    const r = await resultado;

    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.code).toBe(CODIGO_DO_TETO_DE_RESPOSTAS);
    expect(r.gate).toBe("teto_de_respostas");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a leitura é da conversa, com a amostra limitada", () => {
  it("a consulta filtra organização e conversa, e limita a amostra", async () => {
    const b = bancada({ amostra: [recebida("oi", COMECO)] });
    await tentaEnviar(b, COMECO).resultado;

    const leitura = b.consultas.find((c) =>
      c.sql.includes("select m.direction, m.body, m.sent_at, m.sent_via"),
    );
    expect(leitura, "a cadeia não leu a amostra da conversa").toBeDefined();
    expect(leitura?.sql).toMatch(/m\.organization_id = \$1/);
    expect(leitura?.sql).toMatch(/m\.conversation_id = \$2/);
    expect(leitura?.sql).toMatch(/limit \$3/);
    expect(leitura?.params[2]).toBe(AMOSTRA_DE_MENSAGENS);
  });
});
