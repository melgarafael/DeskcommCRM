/**
 * O `send_ledger` carrega a natureza da falha — e não reenvia a recusa definitiva.
 *
 * Medido ao vivo (15/11/2026): cada volta da fila rotacionava a chave do
 * `failed` e mandava o MESMO conteúdo de novo, que o canal recusava de novo —
 * um balão vermelho a mais por volta. Este arquivo prende:
 *   - o desfecho `failed` diz se é permanente (lido da linha da mensagem);
 *   - a nova tentativa do MESMO corpo, já recusada em definitivo, volta como
 *     `failed` permanente SEM chamar o canal e SEM rotacionar;
 *   - falha transitória e corpo diferente seguem rotacionando, como antes.
 */
import { expect, it, vi } from "vitest";

import { bodyHash, sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";

type Store = Parameters<typeof sendWithLedger>[0];
const intent = { tenantId: "org", leadId: "contact", jobId: "job", seq: 1, body: "Segue o áudio" };
const PERMANENTE = { falha_de_envio: { natureza: "permanente", status_http: 400 } };
const TRANSITORIA = { falha_de_envio: { natureza: "transitoria", status_http: 503 } };

function novoStore(): Store {
  return {
    create: vi.fn(async () => "ledger-novo"),
    find: vi.fn(async () => null),
    rotate: vi.fn(async () => "ledger-rotacionado"),
    message: vi.fn(async () => null),
    update: vi.fn(async () => {}),
    setMediaPath: vi.fn(async () => "x"),
  };
}

/** Linha anterior `failed` (o turno re-rodou), com o corpo de `corpoAnterior`. */
function storeComFalhaAnterior(corpoAnterior: string, metadata: unknown): Store {
  const s = novoStore();
  s.create = vi.fn(async () => {
    throw { code: "23505" };
  });
  s.find = vi.fn(async () => ({
    id: "ledger-anterior",
    status: "failed" as const,
    crm_message_id: "msg-anterior",
    body_hash: bodyHash(corpoAnterior),
  }));
  s.message = vi.fn(async () => ({ id: "msg-anterior", status: "failed", metadata }));
  return s;
}

it("recusa definitiva do canal: o desfecho diz `permanente`, e o ledger registra o porquê", async () => {
  const s = novoStore();
  const send = vi.fn(async (_k: string, id: string) => ({ id, status: "failed", metadata: PERMANENTE }));
  expect(await sendWithLedger(s, intent, send)).toEqual({
    kind: "failed",
    idempotencyKey: "ledger-novo",
    crmMessageId: "ledger-novo",
    permanente: true,
  });
  expect(s.update).toHaveBeenCalledWith(
    "org",
    "ledger-novo",
    "failed",
    "ledger-novo",
    expect.stringContaining("em definitivo"),
  );
});

it("falha transitória (ou linha sem a natureza): `permanente: false` — a fila re-tenta, como antes", async () => {
  for (const metadata of [TRANSITORIA, null, undefined, {}]) {
    const s = novoStore();
    const send = vi.fn(async (_k: string, id: string) => ({ id, status: "failed", metadata }));
    const desfecho = await sendWithLedger(s, intent, send);
    expect(desfecho).toMatchObject({ kind: "failed", permanente: false });
  }
});

it("⭐ o turno re-rodou com o MESMO corpo já recusado em definitivo: nada sai, nada rotaciona", async () => {
  const s = storeComFalhaAnterior(intent.body, PERMANENTE);
  const send = vi.fn();
  expect(await sendWithLedger(s, intent, send)).toEqual({
    kind: "failed",
    idempotencyKey: "ledger-anterior",
    crmMessageId: "msg-anterior",
    permanente: true,
  });
  expect(send, "o mesmo conteúdo foi mandado de novo ao canal que já o recusou").not.toHaveBeenCalled();
  expect(s.rotate).not.toHaveBeenCalled();
  expect(s.message).toHaveBeenCalledWith("org", "msg-anterior");
});

it("falha anterior TRANSITÓRIA com o mesmo corpo: rotaciona e tenta de novo (o de sempre)", async () => {
  const s = storeComFalhaAnterior(intent.body, TRANSITORIA);
  const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
  expect((await sendWithLedger(s, intent, send)).kind).toBe("sent");
  expect(s.rotate).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith("ledger-rotacionado", "ledger-rotacionado");
});

it("recusa definitiva de OUTRO corpo: é pedido novo — rotaciona e tenta", async () => {
  const s = storeComFalhaAnterior("o texto que o turno anterior escreveu", PERMANENTE);
  const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
  expect((await sendWithLedger(s, intent, send)).kind).toBe("sent");
  expect(s.rotate).toHaveBeenCalledTimes(1);
  expect(s.message, "corpo diferente nem precisa ler a mensagem anterior").not.toHaveBeenCalled();
});

it("linha anterior sem `body_hash` (dublê antigo / leitura parcial): rotaciona, como antes", async () => {
  const s = storeComFalhaAnterior(intent.body, PERMANENTE);
  s.find = vi.fn(async () => ({ id: "ledger-anterior", status: "failed" as const, crm_message_id: "msg-anterior" }));
  const send = vi.fn(async (_k: string, id: string) => ({ id, status: "sent" }));
  expect((await sendWithLedger(s, intent, send)).kind).toBe("sent");
  expect(s.rotate).toHaveBeenCalledTimes(1);
});
