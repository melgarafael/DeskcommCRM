import { describe, expect, it, vi } from "vitest";

// O mesmo par de dublês da suíte de saúde: o send resolve credencial no banco
// ANTES de tocar a rede, e um fetch dublado sem isto quebra a resolução — o
// teste falharia em `creds_lookup`, não no que ele quer medir.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) as never }));
vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveZernioCreds: async () => ({
    accountId: "acc_1",
    apiKey: "chave",
    baseUrl: "https://z.example",
    source: "session" as const,
  }),
}));

import { zernioAdapter } from "@/lib/channels/adapters/zernio";

/**
 * O PROVEDOR PEDIU PARA DESACELERAR — E ISSO NÃO É FALHA DA MENSAGEM.
 *
 * Changelog de 28/08 do canal intermediado: os envios têm teto de ~10 mensagens
 * por minuto POR DESTINATÁRIO, e o excesso volta com o erro 131056. A mensagem
 * não tem nada de errado; a VELOCIDADE tem.
 *
 * Sem este código próprio, o 131056 caía no `zernio_send_failed` genérico e o
 * handler marcava `failed` — o follow-up desistia de uma mensagem que sairia
 * daqui a um minuto. Perder venda por pressa, com o cliente do outro lado
 * esperando a resposta.
 *
 * Com ele, o handler traduz para `queued` com o motivo carimbado e pede a nova
 * tentativa (`message.throttled_resend_requested`), que o reenvio desacelerado
 * faz na mesma linha — ver `envio-desacelerado-sai-de-novo.test.ts`. (Este
 * cabeçalho dizia que o agent-engine reagendava por `SEND_QUEUED_RETRY_MS`;
 * medido em 27/10/2026, nada reagendava.)
 */
describe("o 131056 tem código próprio", () => {
  it("o adapter declara `throttled` — é o contrato que o handler consulta", () => {
    expect(zernioAdapter.codes.throttled).toBe("zernio_throttled");
  });

  it("o envio que o provedor freou lança com o código de throttle, não o genérico", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      json: async () => ({ success: false, code: 131056, error: "pace to 10/min" }),
    })) as unknown as typeof fetch;
    try {
      await expect(
        zernioAdapter.send({
          organizationId: "org-1",
          sessionRef: "acc_1",
          to: "5511900000001",
          providerConversationId: "conv_1",
          kind: "text",
          body: "olá",
        }),
      ).rejects.toThrow(/^zernio_throttled/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
