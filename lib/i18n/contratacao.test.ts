import { describe, expect, it } from "vitest";

import { traduzir } from "./dicionario";

/** Mensagens que a API da contratação devolve e a tela mostra com `t(e.message)`. */
const DA_API = [
  "O plano mudou. Confira a escolha antes de continuar para o pagamento.", // lib/cobranca/checkout.ts
  "Confira seu plano e continue para o pagamento.", // checkout/route.ts, sem intenção
  "Não foi possível retomar sua contratação. Tente novamente.", // checkout/route.ts, intenção ilegível
];

describe("contratação em espanhol", () => {
  it.each(DA_API)("%s", (texto) => {
    expect(traduzir(texto, "es")).not.toBe(texto);
  });
});
