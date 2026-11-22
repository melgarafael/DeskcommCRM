// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const kit = resolve("hostgator-setup-kit");
const install = readFileSync(resolve(kit, "install.sh"), "utf8");
const singleServer = readFileSync(resolve(kit, "install-single-server.sh"), "utf8");
const senhaDeTeste = "senha-ficticia-4993";

function trecho(fonte: string, inicio: string, fim: string) {
  const de = fonte.indexOf(inicio);
  const ate = fonte.indexOf(fim, de);
  expect(de, inicio).toBeGreaterThanOrEqual(0);
  expect(ate, fim).toBeGreaterThan(de);
  return fonte.slice(de, ate + fim.length);
}

function bash(script: string, variaveis: Record<string, string> = {}) {
  const resultado = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", KIT_DIR: kit, ...variaveis },
  });
  expect(resultado.status, resultado.error?.message ?? resultado.stderr).toBe(0);
  return resultado.stdout;
}

function banner(sameServer: boolean) {
  // Executa o banner real, isolado das operações de instalação e de rede.
  return bash(
    `set -euo pipefail
    source "$KIT_DIR/_i18n.sh"
    c_grn() { printf '%s' "$1"; }
    pendencia_dos_emails() { :; }
    pendencia_do_email() { :; }
    pendencia_da_ia() { :; }
    dc_files() { printf '%s' '-f docker-compose.prod.yml'; }
    ${trecho(install, "telemetria_no_banner() {", "\nDONE\n")}`,
    {
      DOMAIN: "crm.exemplo.com",
      COMUNIDADE_URL: "https://comunidade.exemplo.com",
      OWNER_EMAIL: "admin@crm.exemplo.com",
      OWNER_PASSWORD: senhaDeTeste,
      SENTRY_DSN: "off",
      ...(sameServer ? { SINGLE_SERVER: "1" } : {}),
    },
  );
}

describe("senha na conclusão da instalação", () => {
  it("indica o arquivo e a chave da senha inicial no single-server", () => {
    const saida = banner(true);
    expect(saida).toContain("Instalação concluída!");
    const linhaDaSenha = saida.split("\n").find((linha) => linha.trim().startsWith("senha:"));
    expect(linhaDaSenha).toContain("OWNER_PASSWORD");
    expect(linhaDaSenha).toContain(".env");
    expect(linhaDaSenha).toContain("pasta do CRM");
    expect(saida).not.toContain(senhaDeTeste);
  });

  it("mantém a mensagem original para quem escolheu a senha no instalador comum", () => {
    const saida = banner(false);
    expect(saida).toContain("senha:  (a que você definiu)\n");
    expect(saida).not.toContain(senhaDeTeste);
  });

  it("mostra só o local da senha no resumo final do próprio single-server", () => {
    const saida = bash(
      trecho(singleServer, "cat <<EOF\n\nCredenciais iniciais", "\nEOF\n"),
      {
        CREDENTIALS_FILE: "/crm/.runtime/admin-credentials",
        owner_email: "admin@crm.exemplo.com",
        owner_password: senhaDeTeste,
        aviso_email: "",
      },
    );
    expect(saida).toContain("/crm/.runtime/admin-credentials");
    expect(saida).not.toContain(senhaDeTeste);
  });
});
