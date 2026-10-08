import { describe, expect, it } from "vitest";

import { linkDePagamentoSeguro } from "./link";

describe("linkDePagamentoSeguro — link vindo do banco só vira href se for https", () => {
  it.each([
    ["javascript:", "javascript:alert(1)", null],
    ["http:", "http://pague.example.com/x", null],
    ["data:", "data:text/html,<script>1</script>", null],
    ["texto solto", "isto não é url", null],
    ["vazio", "", null],
    ["nulo", null, null],
    ["⭐ https válido", "https://invoice.example.com/i/x", "https://invoice.example.com/i/x"],
    ["http no próprio computador (dublê de teste)", "http://127.0.0.1:3995/fatura/in_1", "http://127.0.0.1:3995/fatura/in_1"],
    ["http em localhost", "http://localhost:3995/x", "http://localhost:3995/x"],
    ["http que só PARECE loopback", "http://127.0.0.1.example.com/x", null],
    ["javascript com host loopback no texto", "javascript://127.0.0.1/%0Aalert(1)", null],
  ] as const)("%s", (_caso, entrada, esperado) => {
    expect(linkDePagamentoSeguro(entrada)).toBe(esperado);
  });
});
