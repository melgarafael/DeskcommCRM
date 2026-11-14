/**
 * TETO DE RESPOSTAS AUTOMÁTICAS POR CONVERSA (#4590) — a trava que faltava.
 *
 * O defeito medido: dois robôs se responderam **216 vezes em uma hora** num
 * contato só, e nenhum gate barrou, porque cada resposta isolada é legítima. O
 * que faltava era uma trava de CONTAGEM por conversa numa janela.
 *
 * O que este arquivo prova, e por quê:
 *
 *  1. **12 respostas seguidas param na N-ésima** — a régua do produto: com o
 *     default (10 em 60 min), as 10 primeiras saem e a 11ª/12ª são vetadas com
 *     `teto_de_respostas` e REGISTRO (trace persistido em `before_send_traces`).
 *  2. **conversa diferente não herda a contagem** — o filtro é por
 *     `conversation_id`, não por contato/número. Sem isto, um cliente com dois
 *     atendimentos pagaria pelo pingue-pongue de outro.
 *  3. **janela vencida libera de novo** — o teto é janela deslizante, não
 *     sentença: passada a hora, a conversa volta a poder responder.
 *  4. **o gate nunca lança** — leitura quebrada vira `nao_conferido` no trace e
 *     o envio segue. Trava auxiliar não derruba turno.
 *  5. **desarmado não muda nada** — follow-up, template e resposta aprovada não
 *     passam por aqui; a ausência do campo é no-op.
 *
 * Plus: pool/cliente falsos no molde de `gate-vazamento-interno.test.ts` — o que
 * se exercita é o runner de verdade (`runBeforeSend`), não o gate de mentira.
 */
import fs from "node:fs";
import path from "node:path";

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  CODIGO_DO_TETO_DE_RESPOSTAS,
  JANELA_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO,
  TETO_DE_RESPOSTAS_PADRAO,
  carregarRespostasDaConversa,
  contarRespostasAutomaticas,
  knobsDoTetoDeRespostas,
  tetoDeRespostasGate,
} from "@/lib/agent-engine/agent/teto-de-respostas";
import { BEFORE_SEND_GATES, runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const ORG = "00000000-0000-4000-8000-000000000001";
const CONVERSA_A = "00000000-0000-4000-8000-0000000000a1";
const CONVERSA_B = "00000000-0000-4000-8000-0000000000b2";
const LEAD = "00000000-0000-4000-8000-000000000002";
const JOB = "00000000-0000-4000-8000-000000000003";
const CANAL = "00000000-0000-4000-8000-000000000004";

/** A linha de `messages` que o envio grava — só os campos que a conta lê. */
interface LinhaDeMensagem {
  organizationId: string;
  conversationId: string;
  direction: string;
  sentVia: string;
  status: string;
  sentAt: Date;
}

function respostaDaIa(conversationId: string, sentAt: Date): LinhaDeMensagem {
  return {
    organizationId: ORG,
    conversationId,
    direction: "outbound",
    sentVia: "ai",
    status: "sent",
    sentAt,
  };
}

/**
 * Bancada: um "banco" com a tabela `messages` em memória.
 *
 * Ela responde a MESMA pergunta que o SQL faz (organização, conversa, outbound,
 * `sent_via = 'ai'`, `status <> 'failed'`, `sent_at >= desde`). As demais
 * consultas do runner devolvem `rows: []` — que é o "instalação sem nada
 * configurado" e é o caminho que o repo usa nos testes vizinhos da cadeia.
 */
function bancada(opcoes: {
  linhas: LinhaDeMensagem[];
  falharContagem?: boolean;
  /** O `min(sent_at)` volta como o PostgREST/jsonb entrega: string ISO. */
  maisAntigaComoTexto?: boolean;
}) {
  const consultas: { sql: string; params: unknown[] }[] = [];
  const linhas = opcoes.linhas;

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      consultas.push({ sql, params: params ?? [] });
      if (sql.includes("count(*)::int as na_janela")) {
        if (opcoes.falharContagem === true) throw new Error('relation "messages" does not exist');
        const [organizationId, conversationId, desde] = params as [string, string, Date];
        const dentro = linhas.filter(
          (l) =>
            l.organizationId === organizationId &&
            l.conversationId === conversationId &&
            l.direction === "outbound" &&
            l.sentVia === "ai" &&
            l.status !== "failed" &&
            l.sentAt.getTime() >= new Date(desde).getTime(),
        );
        const maisAntiga =
          dentro.length === 0
            ? null
            : new Date(Math.min(...dentro.map((l) => l.sentAt.getTime())));
        return {
          rows: [
            {
              na_janela: dentro.length,
              mais_antiga:
                maisAntiga !== null && opcoes.maisAntigaComoTexto === true
                  ? maisAntiga.toISOString()
                  : maisAntiga,
            },
          ],
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

  return { pool, client, consultas, linhas };
}

function loggerFalso(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * Uma tentativa de envio COM a cadeia real (sem `gates:` injetado), armada no
 * formato que o turno usa. 10h de uma terça em São Paulo: dentro de qualquer
 * janela de envio, para que só o gate deste arquivo decida o desfecho.
 */
function tentaEnviar(
  b: ReturnType<typeof bancada>,
  input: {
    conversationId?: string;
    now: Date;
    armado?: boolean;
    knobs?: { porConversa: number; janelaMinutos: number };
  },
): ReturnType<typeof runBeforeSend> {
  return runBeforeSend({
    pool: b.pool,
    log: loggerFalso(),
    tenantId: ORG,
    leadId: LEAD,
    jobId: JOB,
    channelSessionId: CANAL,
    body: "Claro! Qual o melhor horário para você?",
    optedOutThisTurn: false,
    crmDailyLimit: null,
    resposta: true,
    now: input.now,
    rng: () => 0,
    sleep: async () => {},
    ...(input.armado === false
      ? {}
      : {
          tetoDeRespostas: {
            conversationId: input.conversationId ?? CONVERSA_A,
            ...knobsDoTetoDeRespostas(input.knobs),
          },
        }),
    send: async () => ({ kind: "sent", idempotencyKey: "k", messageId: "m" }),
  });
}

const COMECO = new Date("2026-11-10T13:00:00Z"); // 10h BRT, terça

describe("12 respostas seguidas na janela param na décima", () => {
  it("sai 10, veta a 11ª e a 12ª, com código legível e registro durável", async () => {
    const b = bancada({ linhas: [] });
    const desfechos: string[] = [];

    for (let i = 0; i < 12; i += 1) {
      const now = new Date(COMECO.getTime() + i * 30_000); // uma a cada 30 s
      const r = await tentaEnviar(b, { now });
      desfechos.push(r.status === "sent" ? "sent" : r.code);
      // O envio que saiu vira linha em `messages` — é a testemunha da próxima conta.
      if (r.status === "sent") b.linhas.push(respostaDaIa(CONVERSA_A, now));
    }

    expect(desfechos).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      CODIGO_DO_TETO_DE_RESPOSTAS,
      CODIGO_DO_TETO_DE_RESPOSTAS,
    ]);
  });

  it("o veto é REGISTRADO: linha de veto no trace e insert em before_send_traces", async () => {
    const b = bancada({
      linhas: Array.from({ length: TETO_DE_RESPOSTAS_PADRAO }, (_, i) =>
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - (i + 1) * 60_000)),
      ),
    });

    const r = await tentaEnviar(b, { now: COMECO });

    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("teto_de_respostas");
    expect(r.code).toBe(CODIGO_DO_TETO_DE_RESPOSTAS);
    // Motivo legível: número, janela e o que fazer (não reescrever).
    expect(r.message).toContain("10 resposta(s)");
    expect(r.message).toContain("60 min");
    expect(r.message).toMatch(/Encerre o turno/);
    // O trace é o que vira auditoria no banco.
    expect(r.trace).toContainEqual({
      gate: "teto_de_respostas",
      verdict: "veto",
      code: CODIGO_DO_TETO_DE_RESPOSTAS,
      detail: { na_janela: TETO_DE_RESPOSTAS_PADRAO, teto: TETO_DE_RESPOSTAS_PADRAO, janela_minutos: 60 },
    });
    // Escrita autônoma no pool: sobrevive ao rollback do veto.
    const inserts = (b.pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      /insert into before_send_traces/.test(String(c[0])),
    );
    expect(inserts.length, "nenhum insert em before_send_traces").toBeGreaterThan(0);
    expect(String(inserts[0]?.[1])).toContain(CODIGO_DO_TETO_DE_RESPOSTAS);
  });

  it("logo abaixo do teto nada muda — a N-ésima ainda sai", async () => {
    const b = bancada({
      linhas: Array.from({ length: TETO_DE_RESPOSTAS_PADRAO - 1 }, (_, i) =>
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - (i + 1) * 60_000)),
      ),
    });
    const r = await tentaEnviar(b, { now: COMECO });
    expect(r.status).toBe("sent");
  });
});

describe("a conta é POR CONVERSA — não por contato nem por número", () => {
  it("conversa diferente não herda a contagem", async () => {
    // A conversa A está no teto; a B, do MESMO contato e do mesmo número, não.
    const b = bancada({
      linhas: Array.from({ length: TETO_DE_RESPOSTAS_PADRAO + 5 }, (_, i) =>
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - (i + 1) * 30_000)),
      ),
    });

    const naA = await tentaEnviar(b, { now: COMECO, conversationId: CONVERSA_A });
    const naB = await tentaEnviar(b, { now: COMECO, conversationId: CONVERSA_B });

    expect(naA.status).toBe("vetoed");
    expect(naB.status).toBe("sent");
  });

  it("a consulta filtra conversa, autoria da IA e envio que falhou", async () => {
    // A régua tem de estar no SQL, não só no teste: filtro errado (por contato,
    // contando inbound, contando disparo) passaria nos casos acima.
    const b = bancada({ linhas: [] });
    await tentaEnviar(b, { now: COMECO });

    const contagem = b.consultas.find((c) => c.sql.includes("count(*)::int as na_janela"));
    expect(contagem, "a cadeia não consultou a contagem").toBeDefined();
    const sql = contagem?.sql ?? "";
    expect(sql).toMatch(/conversation_id = \$2/);
    expect(sql).toMatch(/direction = 'outbound'/);
    expect(sql).toMatch(/sent_via = 'ai'/);
    expect(sql).toMatch(/status <> 'failed'/);
    expect(sql).toMatch(/sent_at >= \$3/);
    // $3 é a borda da janela: 60 min antes de `now`.
    expect(new Date(contagem?.params[2] as Date).toISOString()).toBe(
      new Date(COMECO.getTime() - JANELA_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO * 60_000).toISOString(),
    );
  });
});

describe("a janela desliza: vencida, a conversa volta a poder responder", () => {
  it("mensagens fora da janela não contam", async () => {
    // 10 respostas, mas de DUAS horas atrás — fora dos 60 min.
    const b = bancada({
      linhas: Array.from({ length: 10 }, (_, i) =>
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - 120 * 60_000 - i * 1000)),
      ),
    });
    expect((await tentaEnviar(b, { now: COMECO })).status).toBe("sent");
  });

  it("passada a janela, a conversa saturada volta a passar", async () => {
    const b = bancada({
      linhas: Array.from({ length: 10 }, (_, i) =>
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - (i + 1) * 60_000)),
      ),
    });
    const agora = await tentaEnviar(b, { now: COMECO });
    const depois = await tentaEnviar(b, {
      now: new Date(COMECO.getTime() + 61 * 60_000),
    });
    expect(agora.status).toBe("vetoed");
    expect(depois.status).toBe("sent");
  });

  it("o veto diz QUANDO a conta volta a caber", async () => {
    const b = bancada({
      linhas: [
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - 50 * 60_000)),
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - 10 * 60_000)),
      ],
    });
    const r = await tentaEnviar(b, { now: COMECO, knobs: { porConversa: 2, janelaMinutos: 60 } });
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    // A mais antiga da janela sai dela 60 min depois de ter saído.
    expect(r.nextAllowedAt?.toISOString()).toBe(
      new Date(COMECO.getTime() - 50 * 60_000 + 60 * 60_000).toISOString(),
    );
  });

  it("a mesma conta quando o `min(sent_at)` chega como string ISO do PostgREST", async () => {
    // A coluna é a MESMA; só o transporte muda (`Date` no driver `pg`, string no
    // PostgREST/jsonb). O `nextAllowedAt` tem de ser idêntico — quem lê a data
    // crua passa pela borda canônica, não por um `instanceof Date` local.
    const b = bancada({
      linhas: [
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - 50 * 60_000)),
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - 10 * 60_000)),
      ],
      maisAntigaComoTexto: true,
    });
    const r = await tentaEnviar(b, { now: COMECO, knobs: { porConversa: 2, janelaMinutos: 60 } });
    expect(r.status).toBe("vetoed");
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.nextAllowedAt?.toISOString()).toBe(
      new Date(COMECO.getTime() - 50 * 60_000 + 60 * 60_000).toISOString(),
    );
  });
});

describe("o gate nunca lança — leitura quebrada não derruba o turno", () => {
  it("a contagem engole o erro e devolve null", async () => {
    const db = {
      query: vi.fn(async () => {
        throw new Error('relation "messages" does not exist');
      }),
    };
    await expect(
      contarRespostasAutomaticas(db as unknown as Pick<pg.Pool, "query">, {
        organizationId: ORG,
        conversationId: CONVERSA_A,
        now: COMECO,
        janelaMinutos: 60,
      }),
    ).resolves.toBeNull();
  });

  it("na cadeia real: banco quebrado → envia, e o trace diz que não conferiu", async () => {
    const b = bancada({ linhas: [], falharContagem: true });
    const r = await tentaEnviar(b, { now: COMECO });

    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({
      gate: "teto_de_respostas",
      verdict: "skipped",
      code: "nao_conferido",
    });
  });

  it("carregarRespostasDaConversa devolve `naJanela: null` em vez de explodir", async () => {
    const log = loggerFalso();
    const estado = await carregarRespostasDaConversa(
      {
        query: async () => {
          throw new Error("timeout");
        },
      } as unknown as Pick<pg.Pool, "query">,
      { organizationId: ORG, armado: { conversationId: CONVERSA_A, ...knobsDoTetoDeRespostas(null) }, now: COMECO, log },
    );
    expect(estado.naJanela).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("armado só onde o defeito nasce", () => {
  it("sem o campo (follow-up, template, resposta aprovada) o gate é no-op", async () => {
    const b = bancada({
      linhas: Array.from({ length: 99 }, (_, i) =>
        respostaDaIa(CONVERSA_A, new Date(COMECO.getTime() - (i + 1) * 1000)),
      ),
    });
    const r = await tentaEnviar(b, { now: COMECO, armado: false });
    expect(r.status).toBe("sent");
    expect(r.trace).toContainEqual({ gate: "teto_de_respostas", verdict: "pass" });
    // E não pagou a leitura: sem o campo, nenhuma consulta de contagem.
    expect(b.consultas.some((c) => c.sql.includes("count(*)::int as na_janela"))).toBe(false);
  });

  it("está na cadeia global, entre a janela e o spinning", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes).toContain(tetoDeRespostasGate.name);
    expect(nomes.indexOf("teto_de_respostas")).toBe(nomes.indexOf("messaging_window") + 1);
    expect(nomes.indexOf("teto_de_respostas")).toBeLessThan(nomes.indexOf("spinning"));
  });

  it("knobs inválidos caem no default conservador", () => {
    expect(knobsDoTetoDeRespostas(null)).toEqual({
      porConversa: TETO_DE_RESPOSTAS_PADRAO,
      janelaMinutos: JANELA_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO,
    });
    expect(knobsDoTetoDeRespostas({ porConversa: 0, janelaMinutos: -5 })).toEqual({
      porConversa: TETO_DE_RESPOSTAS_PADRAO,
      janelaMinutos: JANELA_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO,
    });
    expect(knobsDoTetoDeRespostas({ porConversa: 3.9, janelaMinutos: 15 })).toEqual({
      porConversa: 3,
      janelaMinutos: 15,
    });
  });
});

/**
 * FIAÇÃO — asserção sobre a FONTE, como o irmão `gate-vazamento-interno.test.ts`.
 * O turno (`runAgentTurn`) não tem seam isolável sem harness pesado; o que se
 * garante aqui é que o campo SAI do `send_message` do turno de resposta, com a
 * conversa do payload e os knobs da instalação — e que follow-up e prévia NÃO o
 * armam (lá o teto mediria a coisa errada).
 */
const FONTE_INBOUND = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
  "utf8",
);
const FONTE_FOLLOWUP = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/agent/followup-turn.ts"),
  "utf8",
);

describe("fiação do teto no turno", () => {
  it("o send_message do turno de resposta ARMA o teto, com a conversa e os knobs", () => {
    const trecho = FONTE_INBOUND.slice(
      FONTE_INBOUND.indexOf("const beforeSendArgs = {"),
      FONTE_INBOUND.indexOf("let chain = await runBeforeSend(beforeSendArgs)"),
    );
    expect(trecho.length, "não achei o bloco de args do envio").toBeGreaterThan(100);
    expect(trecho).toMatch(/tetoDeRespostas:\s*{/);
    expect(trecho).toMatch(/conversationId:\s*input\.conversationId/);
    expect(trecho).toMatch(/knobsDoTetoDeRespostas\(deps\.knobs\.tetoDeRespostas\)/);
    // Só onde houve mensagem recebida, e nunca na prévia (o Testar não entrega nada).
    expect(trecho).toMatch(/eResposta && !preview/);
  });

  it("o follow-up determinístico NÃO arma — ali não houve mensagem recebida", () => {
    expect(FONTE_FOLLOWUP).not.toMatch(/tetoDeRespostas/);
  });
});
