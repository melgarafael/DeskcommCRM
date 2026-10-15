/**
 * Os rótulos das opções do formulário de conexão de banco externo chegam ao
 * `t()` como VARIÁVEL (`t(m.rotulo)`), e a varredura de cobertura do espanhol
 * só enxerga literal dentro de `t("...")`. Os cinco rótulos de TLS ficaram em
 * português na tela em espanhol (prova pela tela do #2940) sem nenhum teste
 * vermelho. Este teste lê os literais `rotulo: "..."` do formulário e cobra a
 * entrada no dicionário.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

const ARQUIVO = join(process.cwd(), "app/app/integracao-dados/_components/FormularioDeConexao.tsx");

describe("formulário de conexão: rótulos das opções em espanhol", () => {
  const rotulos = [...readFileSync(ARQUIVO, "utf-8").matchAll(/rotulo:\s*"([^"]+)"/g)].map((m) => m[1]!);

  it("acha os rótulos (controle da sonda)", () => {
    expect(rotulos).toContain("Preferir TLS");
    expect(rotulos.length).toBeGreaterThanOrEqual(8);
  });

  it.each(rotulos)("%s tem entrada em espanhol", (rotulo) => {
    expect(DICIONARIO[rotulo]?.es, rotulo).toBeTruthy();
  });
});
