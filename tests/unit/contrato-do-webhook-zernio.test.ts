import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";
import type * as EntradaAceita from "@/lib/channels/entrada-aceita";

/**
 * O CONTRATO do webhook do canal intermediado — e por que o defeito aqui era
 * diferente dos outros dois canais.
 *
 * Este parser nunca estourou: ele lê tudo por `str()`, que devolve `null` para
 * o que não é string. O preço não era exceção, era SILÊNCIO. Um
 * `conversationId` que chegasse número virava `null`, `parseZernioInbound`
 * devolvia `null`, e a rota respondia 200 `evento_sem_interesse` — a mesma
 * resposta de um evento que de fato não interessa. A mensagem do cliente sumia
 * com carimbo de normalidade.
 *
 * Os casos abaixo medem os dois lados: o que agora é recusado alto, e o muito
 * mais importante — tudo que continua passando.
 */

const SESSAO = {
  id: "sess-1",
  organization_id: "org-1",
  provider: "zernio",
  display_name: "Loja",
  phone_number: "+5531999990000",
  webhook_secret_encrypted: "\\xabcd",
  archived_at: null,
};
const SECRET = "segredo-longo-o-suficiente";

const arquivoFechado: { status: string; erro?: string | null; validSignature: boolean | null }[] = [];
const ingeridos: unknown[] = [];

// O cliente dublado responde à busca da guarda de conta
// (`inboundPayloadBelongsToSession`): desde 23/09 o WhatsApp do provedor recusa
// evento de OUTRA conta do mesmo espaço, e para isso a guarda pergunta ao banco
// qual é a conta desta sessão. O `{}` de antes fazia a busca lançar
// `admin.from is not a function`, e o caso reprovava pelo motivo errado. A conta
// devolvida é a MESMA do payload deste arquivo — o que se mede aqui é o
// contrato do webhook, não a guarda (que tem o seu próprio arquivo).
vi.mock("@/lib/supabase/admin", () => {
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) cadeia[m] = () => cadeia;
  cadeia.maybeSingle = async () => ({ data: { zernio_account_id: "6a3572a15f7d1751ab117832" }, error: null });
  return { createAdminClient: () => ({ from: () => cadeia }) };
});

vi.mock("@/lib/channels/archived", () => ({
  ARCHIVED_AT: "archived_at",
  queryTolerantToMissingArchived: async () => ({ data: SESSAO, error: null }),
}));

vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => SECRET }));

vi.mock("@/lib/channels/arquivo-de-webhook", () => ({
  abrirArquivoDoWebhook: async () => "arquivo-1",
  fecharArquivoDoWebhook: async (_a: unknown, _id: unknown, desfecho: (typeof arquivoFechado)[number]) => {
    arquivoFechado.push(desfecho);
  },
}));

vi.mock("@/lib/channels/zernio/ingest", () => ({
  ingestZernioInbound: async (_a: unknown, input: unknown) => {
    ingeridos.push(input);
    return { status: "ingested", reason: "mensagem" };
  },
  aplicarEdicaoZernio: async () => "aplicada",
}));

// A mensagem nova responde antes de processar: a marca de aceita é dublada e o
// que a rota agenda no `after()` fica aqui, para o caso rodá-lo depois da resposta.
const depois = vi.hoisted(() => ({ tarefas: [] as Array<() => Promise<unknown>> }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof NextServer>()),
  after: (tarefa: () => Promise<unknown>) => {
    depois.tarefas.push(tarefa);
  },
}));
vi.mock("@/lib/channels/entrada-aceita", async (orig) => ({
  ...(await orig<typeof EntradaAceita>()),
  aceitarEntrada: async () => true,
}));

import { lerEnvelopeZernio } from "@/lib/channels/zernio/envelope";
import { parseZernioInbound } from "@/lib/channels/zernio/webhook";
import { POST } from "@/app/api/v1/webhooks/channel/[token]/route";

/** Forma do evento medida contra o provider — a mesma de `channel-webhook-zernio.test.ts`. */
const REAL = {
  id: "evt_1",
  event: "message.received",
  account: { id: "6a3572a15f7d1751ab117832" },
  message: {
    id: "m_1",
    conversationId: "6a76a2dc4b8fe115e5f6c300",
    platform: "whatsapp",
    platformMessageId: "wamid.ABC",
    direction: "incoming",
    text: "hola",
    attachments: [{ type: "image", url: "https://api.exemplo.invalid/m/1" }],
    sender: { phoneNumber: "+595991733685", name: "Marcelo", businessScopedUserId: "PY.138367" },
    sentAt: "2026-08-08T01:00:00.000Z",
    isRead: false,
  },
};

const pedido = (corpo: unknown) => {
  const cru = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
  return {
    text: async () => cru,
    headers: new Headers({
      "x-zernio-signature": createHmac("sha256", SECRET).update(cru, "utf8").digest("hex"),
    }),
  } as never;
};
const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

describe("o payload real atravessa inteiro", () => {
  it("aceita o evento medido e devolve o MESMO objeto que `JSON.parse` devolvia", () => {
    const r = lerEnvelopeZernio(JSON.stringify(REAL));
    expect(r.ok).toBe(true);
    expect(r.ok && r.envelope).toEqual(REAL);
  });

  it("o parser produz o MESMO resultado com e sem o schema no meio", () => {
    const r = lerEnvelopeZernio(JSON.stringify(REAL));
    expect(r.ok && parseZernioInbound(r.envelope)).toEqual(parseZernioInbound(REAL));
  });

  it("campo que ninguém catalogou passa intacto", () => {
    const comNovidade = {
      ...REAL,
      campoDoFuturo: [1, 2],
      message: { ...REAL.message, quotedMessageId: "wamid.X", reactions: [{ emoji: "👍" }] },
    };
    const r = lerEnvelopeZernio(JSON.stringify(comNovidade));
    expect(r.ok).toBe(true);
    expect(r.ok && r.envelope).toEqual(comNovidade);
  });

  it("`attachments` torto NÃO derruba a mensagem — o leitor já trata qualquer forma", () => {
    // Apertar este campo trocaria "anexo ignorado" por "MENSAGEM descartada".
    for (const attachments of [null, "nem é lista", {}, [1, 2], [{ semUrl: true }]]) {
      const r = lerEnvelopeZernio(JSON.stringify({ ...REAL, message: { ...REAL.message, attachments } }));
      expect(r.ok, `attachments=${JSON.stringify(attachments)} foi recusado`).toBe(true);
    }
  });

  it("mensagem SEM anexo nenhum passa — a maioria delas", () => {
    const { attachments: _fora, ...semAnexo } = REAL.message;
    expect(lerEnvelopeZernio(JSON.stringify({ ...REAL, message: semAnexo })).ok).toBe(true);
  });

  it("`error.code` chega NÚMERO no payload real, e continua chegando", () => {
    const r = lerEnvelopeZernio(
      JSON.stringify({ event: "message.failed", message: REAL.message, error: { code: 131047, title: "x" } }),
    );
    expect(r.ok).toBe(true);
  });

  it("evento de aviso, sem `message` nenhuma, passa", () => {
    const r = lerEnvelopeZernio(
      JSON.stringify({ event: "whatsapp.number.suspended", reason: "pagamento", number: { reason: "kyc" } }),
    );
    expect(r.ok).toBe(true);
  });

  it("`null` é ausência, não erro", () => {
    expect(lerEnvelopeZernio(JSON.stringify({ event: "x", message: null, account: null })).ok).toBe(true);
  });
});

describe("o payload fora do contrato é recusado, e o campo é nomeado", () => {
  const recusa = (corpo: unknown): string[] => {
    const r = lerEnvelopeZernio(JSON.stringify(corpo));
    if (r.ok) throw new Error("o schema ACEITOU um payload que devia recusar");
    expect(r.motivo).toBe("contrato_violado");
    return [...r.campos].sort();
  };

  it("`conversationId` numérico — o campo que sumia com a mensagem", () => {
    expect(recusa({ ...REAL, message: { ...REAL.message, conversationId: 12345 } })).toEqual([
      "message.conversationId",
    ]);
  });

  it("sem o contrato, esse mesmo payload virava 200 `evento_sem_interesse`", () => {
    // O mecanismo do silêncio: `str(12345)` devolve null, a guarda de
    // `conversationId` dispara, e o parser diz "não é dos nossos".
    expect(parseZernioInbound({ ...REAL, message: { ...REAL.message, conversationId: 12345 } })).toBeNull();
  });

  it("`phoneNumber` do remetente com tipo errado — vira contato órfão", () => {
    expect(recusa({ ...REAL, message: { ...REAL.message, sender: { phoneNumber: 595991733685 } } })).toEqual([
      "message.sender.phoneNumber",
    ]);
  });

  it("corpo que nem é objeto não vira envelope vazio", () => {
    expect(lerEnvelopeZernio("[1,2,3]").ok).toBe(false);
    expect(lerEnvelopeZernio("null").ok).toBe(false);
  });
});

describe("a rota — o desfecho que o provider enxerga", () => {
  it("payload real bem assinado: 200 antes da ingestão, e a mensagem é ingerida depois", async () => {
    ingeridos.length = 0;
    arquivoFechado.length = 0;
    depois.tarefas.length = 0;

    const res = await POST(pedido(REAL), ctx);

    expect(res.status).toBe(200);
    expect(ingeridos, "a resposta esperou a ingestão").toHaveLength(0);
    for (const tarefa of depois.tarefas.splice(0)) await tarefa();
    expect(ingeridos).toHaveLength(1);
    expect(arquivoFechado[0]).toMatchObject({ status: "processed" });
  });

  it("contrato violado: 400, nada ingerido, e o arquivo guarda o CAMPO", async () => {
    // Era 200 `evento_sem_interesse` com `status: "processed"` no arquivo —
    // indistinguível de um evento que de fato não interessa.
    ingeridos.length = 0;
    arquivoFechado.length = 0;

    const res = await POST(pedido({ ...REAL, message: { ...REAL.message, conversationId: 12345 } }), ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(ingeridos).toHaveLength(0);
    // `validSignature` fica `null` e não `false`: a assinatura CONFERIU; o que
    // falhou foi o formato, e marcá-la como inválida mandaria quem investiga
    // procurar o segredo errado.
    expect(arquivoFechado[0]).toMatchObject({ status: "error", validSignature: null });
    expect(String(arquivoFechado[0]!.erro)).toContain("message.conversationId");
  });

  it("a assinatura continua vindo ANTES do contrato — corpo torto sem HMAC é 401", async () => {
    arquivoFechado.length = 0;
    const res = await POST(
      { text: async () => '{"message":{"conversationId":1}}', headers: new Headers() } as never,
      ctx,
    );
    expect(res.status).toBe(401);
  });
});
