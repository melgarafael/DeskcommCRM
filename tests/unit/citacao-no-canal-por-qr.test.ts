import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A CITAÇÃO EXISTIA EM TODA PARTE, MENOS ONDE ELA SAI.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * O caminho estava inteiro: a tela deixa escolher a mensagem, o handler resolve
 * o `external_id` da citada, o banco guarda `reply_to_message_id`, e a bolha
 * aparece pendurada na original. No CRM.
 *
 * No WhatsApp do cliente chegava mensagem SOLTA. O adapter do canal por QR
 * simplesmente não lia `envelope.replyToExternalId` — o campo existia no
 * envelope, o canal intermediado já o usava, e este ignorava.
 *
 * É o pior formato de defeito deste produto: a tela promete, nada fica
 * vermelho, e quem descobre é o atendente quando o cliente responde sem
 * entender do que se fala.
 *
 * ─── O formato do id é onde isto falharia em silêncio ──────────────────────
 *
 * `reply_to` quer o id COMPLETO (`{fromMe}_{chatId}_{bareId}`). O WAHA é
 * assimétrico (ver `bareWaMessageId`): a resposta de envio devolve o cru, o
 * webhook devolve o completo. Medido numa instalação real: as 1.734 mensagens
 * de ENTRADA têm o completo — e citar o que o CLIENTE disse é o caso que
 * importa.
 */

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
});

/** Captura o corpo que sai para o WAHA. */
function espiao() {
  const corpos: Record<string, unknown>[] = [];
  globalThis.fetch = vi.fn(async (_u: unknown, init?: unknown) => {
    const b = ((init ?? {}) as { body?: string }).body;
    if (b) corpos.push(JSON.parse(b) as Record<string, unknown>);
    return { ok: true, status: 200, json: async () => ({ id: "3EB0ABC" }), text: async () => "" };
  }) as unknown as typeof fetch;
  return corpos;
}

async function cliente() {
  const { WahaClient } = await import("@/lib/waha/client");
  return new WahaClient("http://waha", "chave");
}

const CITADA = "false_127904277102624@lid_3EB060A3E6B358FFFF84DC";

describe("o canal por QR manda a citação", () => {
  it("o `reply_to` sai com o id COMPLETO, como a API pede", async () => {
    const corpos = espiao();
    await (await cliente()).sendMessage("s1", "595@c.us", "hijale no recuerdo bro", CITADA);
    expect(corpos[0]?.reply_to, "a citação não saiu — chega mensagem solta").toBe(CITADA);
    expect(corpos[0]?.text).toBe("hijale no recuerdo bro");
  });

  it("sem citação, o campo NÃO vai no corpo", async () => {
    // `reply_to: null` é pedir para citar "nada". O envio comum não pode passar
    // a carregar um campo vazio só porque o outro caso existe.
    const corpos = espiao();
    await (await cliente()).sendMessage("s1", "595@c.us", "oi");
    expect(Object.keys(corpos[0] ?? {})).not.toContain("reply_to");
  });

  it("string vazia também não vira citação", async () => {
    const corpos = espiao();
    await (await cliente()).sendMessage("s1", "595@c.us", "oi", "");
    expect(Object.keys(corpos[0] ?? {})).not.toContain("reply_to");
  });
});

describe("o adapter repassa o que o envelope traz", () => {
  /**
   * ⚠️ O CLIENTE É DUBLADO, e não montado a partir de env.
   *
   * A primeira versão usava `vi.stubEnv` para dar `WAHA_BASE_URL` e
   * `WAHA_API_KEY` ao `getWahaClient()`. Passava na minha máquina e FALHOU no
   * CI — porque `lib/env.ts` parseia `process.env` uma vez, no carregamento do
   * módulo, e o stub chega depois. Sem env, `getWahaClient()` devolve `null`, o
   * adapter sai por cima e nenhum corpo é capturado.
   *
   * Ou seja: o teste dizia "a citação chega" porque a MINHA máquina tinha as
   * credenciais. Teste que depende do ambiente de quem roda não prova nada — e
   * este mentia para o lado pior, o verde.
   */
  it("`replyToExternalId` chega ao corpo do envio", async () => {
    const chamadas: unknown[][] = [];
    vi.doMock("@/lib/waha/client", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      getWahaClient: () => ({
        sendMessage: (...a: unknown[]) => {
          chamadas.push(a);
          return Promise.resolve({ id: "3EB0ABC" });
        },
      }),
    }));
    vi.resetModules();
    const { wahaAdapter } = await import("@/lib/channels/adapters/waha");
    await wahaAdapter.send({
      // `organizationId` entrou no envelope na sincronia de 21/08 — o adapter
      // não o usa aqui, mas o tipo o exige.
      organizationId: "org-1",
      sessionRef: "s1",
      to: "595@c.us",
      kind: "text",
      body: "hijale no recuerdo bro",
      replyToExternalId: CITADA,
    });
    // O 4º argumento de `sendMessage` é a citação — o elo que faltava.
    expect(chamadas[0]?.[3], "o adapter voltou a ignorar a citação").toBe(CITADA);
    vi.doUnmock("@/lib/waha/client");
    vi.resetModules();
  });
});
