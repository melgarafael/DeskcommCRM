import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const raiz = process.cwd();
const abrir = readFileSync(
  join(raiz, "app/api/v1/agencia/clientes/[id]/abrir/route.ts"),
  "utf8",
);
const encerrar = readFileSync(
  join(raiz, "app/api/v1/agencia/sessao/encerrar/route.ts"),
  "utf8",
);

describe("sessão delegada de agência e cache curto de autorização", () => {
  it("invalida a ausência cacheada antes de navegar para o cliente", () => {
    expect(abrir).toContain("invalidarUsuario(auth.user.id)");
    expect(abrir.indexOf("invalidarUsuario(auth.user.id)")).toBeLessThan(
      abrir.indexOf('action: "agency.session_started"'),
    );
  });

  it("invalida identidade e sessão antes de voltar para a agência", () => {
    expect(encerrar).toContain("invalidarUsuario(user.id)");
    expect(encerrar).toContain("invalidarSessao(sessaoAtual.chave)");
    expect(encerrar.indexOf("invalidarUsuario(user.id)")).toBeLessThan(
      encerrar.indexOf('store.set("active_org"'),
    );
  });
});
