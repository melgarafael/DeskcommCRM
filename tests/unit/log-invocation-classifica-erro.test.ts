/**
 * `/app/ai/runs` existe para dizer "o que aconteceu e o que fazer". Com o
 * caminho legado gravando `error_code: "erro_legado"` para QUALQUER falha, ela
 * dizia as duas coisas erradas: numa instalação real a chave da OpenRouter
 * estava sem saldo, a tela mostrou três vezes `erro_legado` sem linha de
 * conserto, e o dono foi procurar bug de código num problema de fatura.
 */
import { describe, expect, it } from "vitest";

import { codigoDoErro } from "@/lib/ai/log-invocation";

describe("codigoDoErro — mesma régua do motor", () => {
  it("saldo acabado vira limite_ou_saldo (o caso medido)", () => {
    expect(
      codigoDoErro({
        message:
          '{"message":"Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, and if so, purchase more at https://openrouter.ai/settings/credits"}',
      }),
    ).toBe("limite_ou_saldo");
  });

  it("chave recusada vira credencial_recusada", () => {
    expect(codigoDoErro({ message: "401 Unauthorized: invalid api key" })).toBe(
      "credencial_recusada",
    );
    expect(codigoDoErro({ message: "recusado", status: 403 })).toBe("credencial_recusada");
  });

  it("modelo que não existe mais vira modelo_inexistente", () => {
    expect(codigoDoErro({ message: "The model `gpt-4-turbo-x` does not exist" })).toBe(
      "modelo_inexistente",
    );
  });

  it("provedor fora do ar vira provedor_indisponivel", () => {
    expect(codigoDoErro({ message: "fetch failed" })).toBe("provedor_indisponivel");
    expect(codigoDoErro({ message: "boom", statusCode: 503 })).toBe("provedor_indisponivel");
  });

  it("payload sem message não estoura — classifica o que der", () => {
    expect(typeof codigoDoErro({ detalhe: "algo estranho" })).toBe("string");
  });

  it("nunca devolve o balde antigo", () => {
    expect(codigoDoErro({ message: "qualquer coisa" })).not.toBe("erro_legado");
  });
});
