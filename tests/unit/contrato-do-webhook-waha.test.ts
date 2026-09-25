import { describe, expect, it, vi } from "vitest";

/**
 * O CONTRATO do webhook deste canal — e as duas maneiras de errar ao escrevê-lo.
 *
 * Metade dos casos prova que o schema RECUSA o que fazia a ingestão estourar
 * calada. A outra metade prova que ele NÃO recusa mais nada — que é o risco de
 * verdade desta mudança: um webhook de WhatsApp real traz campos que ninguém
 * catalogou, e um schema apertado demais troca "mensagem entra no CRM" por
 * "mensagem descartada em silêncio", que é pior que o defeito consertado.
 *
 * Por isso o payload REAL é medido inteiro, com `toEqual` contra o que
 * `JSON.parse` produzia sozinho: se um campo se perder no caminho, o teste diz.
 */

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  waha_session_name: "default",
  webhook_secret_encrypted: "\\x00",
  status: "WORKING",
  is_warmup_complete: true,
  warmup_started_at: null,
};

const arquivados: Record<string, unknown>[] = [];
const despachados: unknown[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      // A rota lê o id da linha arquivada (`insert().select("id")`) e depois grava
      // o desfecho nela (`update().eq("id", …)`) — ver `lib/waha/desfecho-do-webhook.ts`.
      insert: (linha: Record<string, unknown>) => {
        arquivados.push(linha);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: "log-1" }, error: null }) }) };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async () => ({ data: "segredo-decifrado-longo", error: null }),
  }),
}));

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));

vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

vi.mock("@/lib/waha/webhook-auth", () => ({
  authenticateWahaWebhook: () => ({ ok: true, signatureVerified: true }),
}));

vi.mock("@/lib/waha/ingest", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  dispatchWahaEvent: async (_a: unknown, _s: unknown, envelope: unknown) => {
    despachados.push(envelope);
  },
}));

import { conferirContratoWaha, lerRoteamentoWaha } from "@/lib/waha/envelope";
import { parseChatId } from "@/lib/waha/ingest";
import { POST } from "@/app/api/v1/webhooks/waha/route";

/**
 * Transcrição de `webhook_events_log` da produção (2026-08-06) — a mesma fonte
 * de `telefone-alternativo-do-payload.test.ts`. Ninguém teria INVENTADO
 * `remoteJidAlt`; é essa a diferença entre medir o WhatsApp e medir a
 * imaginação de quem escreve o teste.
 */
const REAL = {
  event: "message.any",
  session: "default",
  payload: {
    id: "false_70192801575156@lid_3A60443E83484256AF03",
    from: "70192801575156@lid",
    fromMe: false,
    body: "oi, tudo bem?",
    timestamp: 1_760_000_000,
    hasMedia: false,
    _data: {
      pushName: "Cliente Real",
      key: {
        id: "3A60443E83484256AF03",
        fromMe: false,
        remoteJid: "70192801575156@lid",
        participant: "",
        remoteJidAlt: "558183647258@s.whatsapp.net",
        addressingMode: "lid",
      },
      message: { conversation: "oi, tudo bem?" },
    },
  },
};

/**
 * A rota confere o contrato em DOIS estágios (roteamento antes do arquivo,
 * conteúdo depois — ver o AC do PRD §3.3). Compor os dois aqui mede o mesmo
 * que a rota mede, sem repetir o `if` em cada caso.
 */
const lerEnvelopeWaha = (rawBody: string) => {
  const r = lerRoteamentoWaha(rawBody);
  return r.ok ? conferirContratoWaha(r.envelope) : r;
};

const pedido = (corpo: unknown) =>
  ({
    text: async () => (typeof corpo === "string" ? corpo : JSON.stringify(corpo)),
    headers: new Headers({ "x-webhook-hmac": "sha512=abc" }),
  }) as never;

describe("o payload real atravessa inteiro", () => {
  it("aceita o evento de produção e devolve o MESMO objeto que o cast devolvia", () => {
    const cru = JSON.stringify(REAL);
    const r = lerEnvelopeWaha(cru);

    expect(r.ok).toBe(true);
    // Nada de `toMatchObject`: o que se quer provar é que nada SUMIU.
    expect(r.ok && r.envelope).toEqual(JSON.parse(cru));
  });

  it("campo que ninguém catalogou passa intacto — é o risco desta issue", () => {
    // Um `.strict()` aqui transformaria um campo novo do provider em mensagem
    // descartada. O schema é loose exatamente para isso não acontecer.
    const comNovidade = {
      ...REAL,
      campoDoFuturo: { qualquer: [1, 2, 3] },
      payload: { ...REAL.payload, replyTo: "abc", _data: { ...REAL.payload._data, novo: true } },
    };
    const r = lerEnvelopeWaha(JSON.stringify(comNovidade));

    expect(r.ok).toBe(true);
    expect(r.ok && r.envelope).toEqual(comNovidade);
  });

  it("`null` é ausência, não erro — é como todo provider diz 'não tenho'", () => {
    const r = lerEnvelopeWaha(
      JSON.stringify({ event: "message", session: "default", payload: { id: "x", body: null, to: null, media: null } }),
    );
    expect(r.ok).toBe(true);
  });

  it("evento sem payload nenhum continua passando (ack, status, presença)", () => {
    expect(lerEnvelopeWaha(JSON.stringify({ event: "session.status", session: "default" })).ok).toBe(true);
  });
});

describe("o payload fora do contrato é recusado, e o campo é nomeado", () => {
  const recusa = (payload: Record<string, unknown>): string[] => {
    const r = lerEnvelopeWaha(JSON.stringify({ event: "message", session: "default", payload }));
    if (r.ok) throw new Error("o schema ACEITOU um payload que devia recusar");
    expect(r.motivo).toBe("contrato_violado");
    return [...r.campos].sort();
  };

  it("`from` não-string — o campo que fazia a ingestão estourar", () => {
    expect(recusa({ id: "x", from: 5 })).toEqual(["payload.from"]);
  });

  it("sem o contrato, esse mesmo valor LANÇAVA lá dentro", () => {
    // É o mecanismo inteiro do defeito: `parseChatId` chama `.endsWith`, o
    // `try/catch` da rota engolia a exceção, e a resposta era 200.
    expect(() => parseChatId(5 as unknown as string)).toThrow(TypeError);
  });

  it("nomeia TODOS os campos recusados, não só o primeiro", () => {
    expect(recusa({ id: "x", from: 2, timestamp: "agora", body: 7 })).toEqual([
      "payload.body",
      "payload.from",
      "payload.timestamp",
    ]);
  });

  it("o estágio 1 recusa o que ele mesmo lê — a sessão e o id que vão para o arquivo", () => {
    // Estes dois não podem esperar pelo estágio 2: um resolve a organização, o
    // outro é coluna do próprio arquivo.
    const r = lerRoteamentoWaha(JSON.stringify({ session: 1, payload: { id: 2 } }));
    if (r.ok) throw new Error("o estágio de roteamento ACEITOU o que devia recusar");
    expect([...r.campos].sort()).toEqual(["payload.id", "session"]);
  });

  it("recusa dentro de `_data.key`, onde mora o telefone do cliente", () => {
    expect(recusa({ _data: { key: { remoteJidAlt: 55 } } })).toEqual(["payload._data.key.remoteJidAlt"]);
  });

  it("corpo que nem é objeto não vira envelope vazio", () => {
    expect(lerEnvelopeWaha('"sou uma string"').ok).toBe(false);
    expect(lerEnvelopeWaha("[1,2,3]").ok).toBe(false);
  });

  it("json quebrado é motivo PRÓPRIO — o corpo é outra coisa que o formato", () => {
    const r = lerEnvelopeWaha("{nao é json");
    expect(r).toMatchObject({ ok: false, motivo: "json_invalido", campos: [] });
  });

  it("a recusa carrega o CAMINHO e nunca o valor — que é dado de cliente", () => {
    // O valor aqui tem 20 mil caracteres e é um telefone repetido. Se ele
    // vazasse para `campos`, iria parar no log e no corpo da resposta.
    const enorme = "5531988887777".repeat(1500);
    expect(recusa({ id: "x", timestamp: enorme })).toEqual(["payload.timestamp"]);
  });
});

describe("a rota — o desfecho que o provider enxerga", () => {
  it("payload real: 200, e o dispatch recebe o envelope inteiro", async () => {
    despachados.length = 0;
    const res = await POST(pedido(REAL));

    expect(res.status).toBe(200);
    expect(despachados).toHaveLength(1);
    expect(despachados[0]).toEqual(REAL);
  });

  it("`from` não-string: 400 com o campo, e NADA chega ao dispatch", async () => {
    // Este era o 200 mudo: a exceção estourava dentro do dispatch, o `catch` da
    // rota a engolia, e o provider riscava o evento da fila.
    despachados.length = 0;
    arquivados.length = 0;
    const res = await POST(pedido({ event: "message", session: "default", payload: { id: "x", from: 5 } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_failed", details: { campos: ["payload.from"] } },
    });
    expect(despachados).toHaveLength(0);
  });

  it("o corpo cru é ARQUIVADO mesmo quando o contrato reprova — é o AC do PRD §3.3", async () => {
    // "Webhook com HMAC válido grava raw em `webhook_events_log` mesmo se o
    // parse falhar depois". Conferir o contrato inteiro antes do INSERT
    // destruiria exatamente a evidência de que o fio mudou. Por isso a rota
    // confere em dois estágios, e este caso é o que segura essa ordem.
    despachados.length = 0;
    arquivados.length = 0;
    const corpo = { event: "message", session: "default", payload: { id: "wamid.X", from: 5 } };

    const res = await POST(pedido(corpo));

    expect(res.status).toBe(400);
    expect(arquivados, "o corpo cru se perdeu — a evidência do formato novo sumiu").toHaveLength(1);
    expect(arquivados[0]).toMatchObject({
      raw_body: JSON.stringify(corpo),
      event_type: "message",
      external_id: "wamid.X",
    });
  });

  it("json quebrado segue devolvendo o mesmo 400 de sempre", async () => {
    const res = await POST(pedido("{nao é json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request", message: "invalid_json" } });
  });
});
