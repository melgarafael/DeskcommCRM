import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const template = readFileSync(join(RAIZ, ".env.hostgator.example"), "utf8");
const install = readFileSync(join(RAIZ, "hostgator-setup-kit/install.sh"), "utf8");

function linhasAtivasDaChave(texto: string, chave: string): string[] {
  return texto
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith(`${chave}=`));
}

describe("consentimento de telemetria no primeiro install", () => {
  it("o template não decide SENTRY_DSN pela pessoa", () => {
    expect(
      linhasAtivasDaChave(template, "SENTRY_DSN"),
      "SENTRY_DSN ativo no template faz load_env marcar a variável como definida e pula a pergunta de consentimento",
    ).toEqual([]);
    expect(template).toContain("# SENTRY_DSN=");
  });

  it("o instalador distingue primeira execução de uma escolha já gravada", () => {
    expect(install).toContain('if [ -z "${SENTRY_DSN+x}" ]; then');
    expect(install).toContain('SENTRY_DSN="off"');
    expect(install).toContain('SENTRY_DSN=""');
    expect(install).toContain('envq SENTRY_DSN "${SENTRY_DSN:-}"');
  });

  it("a documentação do template explica as três escolhas persistentes", () => {
    expect(template).toContain("O install.sh pergunta na primeira instalação");
    expect(template).toContain("SENTRY_DSN=off");
    expect(template).toContain("SENTRY_DSN=             → aceita o Sentry da comunidade");
    expect(template).toContain("SENTRY_DSN=<seu-dsn>");
  });
});
