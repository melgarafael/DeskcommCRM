/**
 * A BASE DA BOT API HONRA O CONTRATO DO `.env.example`.
 *
 * O `.env.example` entrega `TELEGRAM_API_BASE_URL=` VAZIA e promete, ao lado:
 * "Vazia = o host real". O caminho normal de quem instala é `cp .env.example
 * .env` e deixar o override como veio — ou seja, o estado que precisa funcionar
 * é **presente e vazio**, não só ausente.
 *
 * `??` não cumpre essa promessa (string vazia é valor), e um valor sem esquema
 * absoluto monta `/bot<token>/<método>` sem host — o `fetch` do Node lança
 * `TypeError: Failed to parse URL` e todo envio pelo canal quebra. Os dois casos
 * têm de cair no host real, sem exceção.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { telegramApiBase } from "@/lib/channels/bot/webhook";
import { telegramApiUrl } from "@/lib/channels/bot/credentials";

const CHAVE = "TELEGRAM_API_BASE_URL";
const PRODUCAO = "https://api.telegram.org";

// O `.env.local` desta máquina entra no `process.env` via `vitest.setup.ts`,
// então o valor real sai e volta em volta de cada caso.
let original: string | undefined;
beforeEach(() => {
  original = process.env[CHAVE];
});
afterEach(() => {
  if (original === undefined) delete process.env[CHAVE];
  else process.env[CHAVE] = original;
});

describe("telegramApiBase", () => {
  it("AUSENTE cai na Bot API real", () => {
    delete process.env[CHAVE];
    expect(telegramApiBase()).toBe(PRODUCAO);
  });

  it("VAZIA e só-espaços caem na Bot API real — a promessa do `.env.example`", () => {
    process.env[CHAVE] = "";
    expect(telegramApiBase()).toBe(PRODUCAO);
    process.env[CHAVE] = "   ";
    expect(telegramApiBase()).toBe(PRODUCAO);
  });

  it("aponta para o receptor de prova e apara a barra final", () => {
    process.env[CHAVE] = "http://127.0.0.1:9/tg";
    expect(telegramApiBase()).toBe("http://127.0.0.1:9/tg");
    process.env[CHAVE] = "http://127.0.0.1:9/tg/";
    expect(telegramApiBase()).toBe("http://127.0.0.1:9/tg");
  });

  it("recusa o que não é base absoluta http(s) em vez de montar URL sem host", () => {
    for (const ruim of ["api.telegram.org", "ftp://x.invalid", "file:///tmp/x", "/v1"]) {
      process.env[CHAVE] = ruim;
      expect(telegramApiBase(), `valor: ${ruim}`).toBe(PRODUCAO);
    }
  });

  it("a URL do método passa a sair da base resolvida", () => {
    process.env[CHAVE] = "http://127.0.0.1:9/tg/";
    expect(telegramApiUrl("123:abc", "sendMessage")).toBe(
      "http://127.0.0.1:9/tg/bot123:abc/sendMessage",
    );
    delete process.env[CHAVE];
    expect(telegramApiUrl("123:abc", "getMe")).toBe("https://api.telegram.org/bot123:abc/getMe");
  });
});
