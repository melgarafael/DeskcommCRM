import { describe, expect, it } from "vitest";

import { resolverBaseDeTeste } from "./base-de-teste";

const APP_LOCAL = "http://localhost:3001";

describe("resolverBaseDeTeste — o endereço de teste do provedor só vale em bancada", () => {
  it.each([
    ["vazio", "", APP_LOCAL, null],
    ["loopback com o app em loopback", "http://127.0.0.1:3995", APP_LOCAL, "http://127.0.0.1:3995"],
    ["a barra final sai", "http://127.0.0.1:3995/", APP_LOCAL, "http://127.0.0.1:3995"],
    ["localhost também é loopback", "http://localhost:3995", "http://127.0.0.1:3001", "http://localhost:3995"],
    ["app numa VPS de verdade: ignorada", "http://127.0.0.1:3995", "https://crm.cliente.com.br", null],
    ["host que só começa com 127", "http://127.0.0.1.evil.com:3995", APP_LOCAL, null],
    ["fora do loopback", "https://api.stripe.com", APP_LOCAL, null],
    ["não é URL", "não é url", APP_LOCAL, null],
    ["esquema que não é http", "file:///etc/passwd", APP_LOCAL, null],
  ])("%s", (_caso, bruto, app, esperado) => {
    expect(resolverBaseDeTeste(bruto, app)).toBe(esperado);
  });
});
