/**
 * A LEITURA QUE UM CASO DEIXOU PARA TRÁS NÃO ESCREVE NO CASO SEGUINTE.
 *
 * Tela renderizada sem dublê de rede faz leitura real; ela falha, o
 * `apiClient` repete com espera e cada repetição escreve `request_retried`.
 * Quando a última linha caía com o vitest fechando o worker, a parte do
 * `verify` reprovava com todos os testes verdes (`EnvironmentTeardownError:
 * Closing rpc while "onUserConsoleLog" was pending` — runs 44800565620,
 * 44800719458, 44738293573, entre outros).
 *
 * O primeiro caso dispara a leitura e termina sem esperá-la, como faz uma tela.
 * O segundo espera mais que as duas esperas do retry somadas e confere que a
 * cadeia do primeiro não escreveu nada — porque o setup a cancelou ao fim dele
 * (`cancelarRequisicoesEmVoo`, em `tests/setup/vitest.setup.ts`). Sem o
 * cancelamento, a terceira tentativa escreve aqui dentro.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { logger } from "@/lib/logger";

const ROTA = "/api/v1/leitura-sem-duble";
const logInfo = vi.spyOn(logger, "info");
let leitura: Promise<unknown> | undefined;

afterAll(() => {
  logInfo.mockRestore();
});

describe("leitura sem dublê de rede", () => {
  it("o caso dispara a leitura e termina sem esperá-la, como uma tela", () => {
    leitura = apiClient.get(ROTA).catch((erro: unknown) => erro);
    expect(leitura).toBeDefined();
  });

  it("a cadeia de retry do caso anterior não escreve depois que ele terminou", async () => {
    logInfo.mockClear();
    // ~200 ms + ~400 ms de espera do retry, com folga para o jitter.
    await new Promise((resolver) => setTimeout(resolver, 900));
    const linhasDaRota = logInfo.mock.calls.filter(
      ([msg, ctx]) => msg === "request_retried" && ctx?.rota === ROTA,
    );
    expect(linhasDaRota).toEqual([]);
    expect(await leitura).toMatchObject({ name: "AbortError" });
  });
});
