import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildOpeningMessage,
  claimsCurrentInboundIsEmpty,
  loadInboundBodyForJob,
} from "@/lib/agent-engine/agent/inbound-turn";
import {
  frameMediaBody,
  type LeadContext,
} from "@/lib/agent-engine/edge/crm/get-lead-context";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

/**
 * A LINHA DO ÁUDIO — e por que este arquivo não é o `turno-responde-a-mensagem-do-job`.
 *
 * Aquele provou que a linha canônica vem do `inbound_message_id` do job, e não da
 * última inbound do histórico. Este prova COMO essa mesma linha é LIDA. Os dois
 * defeitos são irmãos e o nome de cada um diz qual é qual:
 *
 *  • lá: o turno lia a linha ERRADA (um registro concorrente sequestrava o turno);
 *  • aqui: o turno lia a linha CERTA do jeito errado — a coluna `body` crua,
 *    enquanto o histórico logo abaixo compunha o corpo dela (`fitToBudget`).
 *
 * Áudio e foto chegam do WhatsApp sem legenda: `body` NULL, conteúdo no derivado
 * (`media_derived_text` — gravado DEPOIS, por `workers/media-derive-worker.ts`, o
 * que faz disto uma corrida) ou no marcador `[tipo]`. Lida crua, a linha canônica
 * valia `''` e o defeito saía pelos DOIS lados do turno:
 *
 *  1. a abertura anunciava "não há texto utilizável" sobre uma mensagem que TEM
 *     texto — o texto estava no histórico, na mesma abertura;
 *  2. `claimsCurrentInboundIsEmpty` devolve `false` quando o texto canônico é
 *     `''`, então a barreira do falso-vazio ficava DESARMADA exatamente quando o
 *     prompt acabara de dizer que não havia texto. O modelo repetia "sua mensagem
 *     chegou em branco" e nada o barrava.
 *
 * O caso 3 abaixo é o contrapeso: a correção não pode inventar texto. Linha sem
 * mídia e sem corpo continua valendo `''`, porque aí o vazio é a verdade.
 */

const INBOUND_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const TRANSCRICAO = "Oi, quero remarcar minha consulta para sexta de manhã.";

/** A linha como o WAHA a grava num PTT sem legenda (`waha/ingest.ts`: `body: texto`). */
const LINHA_DO_AUDIO = {
  type: "audio",
  body: null,
  media_url: "https://cdn.exemplo/audio.ogg",
  media_storage_path: null,
  media_derived_text: TRANSCRICAO,
};

function pool(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { db: { query } as unknown as Queryable, query };
}

/** O caminho de produção inteiro: a linha do job lida pela função que o turno usa. */
async function textoDoJob(rows: unknown[]): Promise<string | null> {
  const { db } = pool(rows);
  return loadInboundBodyForJob(db, {
    tenantId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    inboundMessageId: INBOUND_MESSAGE_ID,
  });
}

/** O contexto começa pelo histórico — que já compunha o corpo da MESMA linha. */
function contextoCom(OHistorico: LeadContext["messages"]): LeadContext {
  return {
    lead_id: "11111111-1111-4111-8111-111111111111",
    contact: { name: "Cristiano", phone: null, email: null, tags: [], is_blocked: false },
    conversation_id: "22222222-2222-4222-8222-222222222222",
    last_human_decision: null,
    messages: OHistorico,
  };
}

describe("a linha canônica do job é lida como o histórico lê", () => {
  it("áudio transcrito chega com o TEXTO do cliente, nunca vazio", async () => {
    // É a MESMA composição do histórico, e não uma parecida: o valor tem que ser
    // idêntico ao que `fitToBudget` monta para esta linha, senão a abertura e o
    // histórico voltam a discordar sobre a mesma mensagem.
    await expect(textoDoJob([LINHA_DO_AUDIO])).resolves.toBe(
      frameMediaBody("audio", null, TRANSCRICAO),
    );
  });

  it("mídia que ainda não tem derivado vale o marcador do histórico — recebida não é vazio", async () => {
    await expect(textoDoJob([{ ...LINHA_DO_AUDIO, media_derived_text: null }])).resolves.toBe(
      "[audio]",
    );
  });

  it("linha sem mídia e sem corpo continua vazia — a correção não inventa texto", async () => {
    await expect(
      textoDoJob([{ ...LINHA_DO_AUDIO, type: "text", media_url: null, media_derived_text: null }]),
    ).resolves.toBe("");
  });
});

describe("a abertura não anuncia mensagem vazia quando ela tem texto", () => {
  it("com o texto canônico do áudio, a fonte prioritária entra e o 'não há texto' sai", async () => {
    const texto = (await textoDoJob([LINHA_DO_AUDIO])) ?? "";
    const abertura = buildOpeningMessage(
      null,
      null,
      contextoCom([{ direction: "inbound", body: texto, sent_at: "2026-09-06T18:10:00-04:00" }]),
      "sem notas",
      false,
      [],
      "",
      texto,
    );

    expect(abertura).toContain("## Mensagem atual do cliente — fonte prioritária");
    expect(abertura).not.toContain("Não há texto utilizável");
    expect(abertura).toContain(TRANSCRICAO);
  });

  it("e a barreira do falso-vazio fica ARMADA para barrar a frase do 'veio em branco'", async () => {
    // Sem isto o conserto do prompt fica sozinho: o texto canônico vazio desarma
    // a barreira que existe justamente para o modelo não repetir o resumo
    // contaminado. As duas metades são o mesmo defeito.
    const texto = (await textoDoJob([LINHA_DO_AUDIO])) ?? "";
    expect(
      claimsCurrentInboundIsEmpty(
        "Desculpe, sua mensagem chegou em branco. Pode reenviar?",
        texto,
      ),
    ).toBe(true);
  });
});

/**
 * O comportamento acima prova as duas pontas lidas pelo MESMO caminho. Não prova
 * que elas PERMANECEM no mesmo caminho: uma segunda receita de corpo dentro do
 * histórico (ou uma leitura crua de volta na linha do job) passaria despercebida
 * por qualquer teste de função pura, que só vê o que recebe.
 */
describe("fiação — histórico e linha do job compõem o corpo pela MESMA função", () => {
  const FONTE = readFileSync(
    join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"),
    "utf8",
  );
  const CTX = readFileSync(
    join(process.cwd(), "lib/agent-engine/edge/crm/get-lead-context.ts"),
    "utf8",
  );

  /**
   * O histórico recortado — mesmo padrão de recorte do
   * `mensagem-atual-prioritaria.test.ts`, e pela mesma razão: uma receita só se
   * prova ausente de um TRECHO. Procurá-la no arquivo inteiro acusaria a própria
   * função que a centraliza.
   */
  const corpoDoHistorico = (() => {
    const i = CTX.indexOf("function fitToBudget(");
    const j = CTX.indexOf("const MEDIA_NOUN", i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return CTX.slice(i, j);
  })();

  it("os dois leitores chamam `corpoDaMensagem`", () => {
    expect(FONTE).toMatch(/corpoDaMensagem\(row\)/);
    expect(corpoDoHistorico).toMatch(/const body = corpoDaMensagem\(m\)/);
  });

  it("a linha do job não volta a ler a coluna crua", () => {
    expect(FONTE).not.toMatch(/row\.body \?\? ''/);
  });

  it("o histórico não voltou a ter receita própria de corpo", () => {
    expect(corpoDoHistorico).not.toMatch(/body \?\? \(hasMedia/);
    expect(corpoDoHistorico).not.toMatch(/frameMediaBody\(/);
  });
});
