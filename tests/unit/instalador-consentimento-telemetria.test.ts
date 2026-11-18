import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const template = readFileSync(join(RAIZ, ".env.hostgator.example"), "utf8");
const install = readFileSync(join(RAIZ, "hostgator-setup-kit/install.sh"), "utf8");
const update = readFileSync(join(RAIZ, "hostgator-setup-kit/update.sh"), "utf8");
const local = readFileSync(join(RAIZ, "ubuntu-local-installer.sh"), "utf8");

function linhasAtivasDaChave(texto: string, chave: string): string[] {
  return texto
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith(`${chave}=`));
}

/**
 * Roda a conversão de VERDADE, num `.env` de mentira, com a função real de
 * `_common.sh`. Ler o fonte e procurar uma string provaria que a linha existe,
 * não que ela converte — e converter SÓ o caso que interessa é o trabalho todo
 * desta função: chave ausente, `off`, DSN próprio e chave vazia não se
 * distinguem por grep.
 */
function migrar(conteudo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "telemetria-4936-"));
  const env = join(dir, ".env");
  writeFileSync(env, conteudo);
  try {
    execFileSync(
      "bash",
      [
        "-c",
        'source hostgator-setup-kit/_common.sh; migrar_consentimento_de_telemetria "$1"',
        "_",
        env,
      ],
      { cwd: RAIZ, stdio: "pipe", timeout: 60_000 },
    );
    return readFileSync(env, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function valorDeSentryDsn(conteudo: string): string {
  const linhas = conteudo
    .split("\n")
    .filter((linha) => /^[ \t]*(export[ \t]+)?SENTRY_DSN=/.test(linha));
  if (linhas.length === 0) return "(ausente)";
  const ultima = linhas[linhas.length - 1] ?? "";
  return ultima
    .replace(/^[ \t]*(export[ \t]+)?SENTRY_DSN=/, "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

describe("consentimento de telemetria no primeiro install", () => {
  it("o template não decide SENTRY_DSN pela pessoa", () => {
    expect(
      linhasAtivasDaChave(template, "SENTRY_DSN"),
      "SENTRY_DSN ativo no template faz load_env marcar a variável como definida e pula a pergunta de consentimento",
    ).toEqual([]);
    expect(template).toContain("# SENTRY_DSN=");
  });

  it("o instalador grava o token do 'sim' e nunca a chave vazia", () => {
    expect(install).toContain('if [ -z "${SENTRY_DSN+x}" ]; then');
    expect(install).toContain('SENTRY_DSN="off"');
    // O token do "sim" é `comunidade`, não a chave vazia: desde a #4936 o vazio
    // significa DESLIGADO (lib/sentry/dsn.ts), então gravar "" transformaria o
    // consentimento em silêncio — e a chave do ingest não vai pro .env de quem
    // instala.
    expect(install).toContain('SENTRY_DSN="comunidade"');
    expect(install).not.toContain('SENTRY_DSN=""');
    expect(install).toContain('envq SENTRY_DSN "${SENTRY_DSN:-}"');
  });

  it("a documentação do template explica as três escolhas persistentes", () => {
    expect(template).toContain("O install.sh pergunta na primeira instalação");
    expect(template).toContain("SENTRY_DSN=off");
    expect(template).toContain("SENTRY_DSN=comunidade   → aceita o Sentry do projeto");
    expect(template).toContain("SENTRY_DSN=<seu-dsn>");
  });
});

describe("a atualização preserva o consentimento de quem já havia aceitado", () => {
  it("o update.sh chama a conversão antes de qualquer saída de 'nada a atualizar'", () => {
    const linhas = update.split("\n");
    const chamada = linhas.findIndex(
      (linha) => linha.trim() === "migrar_consentimento_de_telemetria .env",
    );
    // As saídas de "já está na versão mais recente" morrem num `exit 0` sem
    // passar pelo `up -d`: se a chamada ficar depois delas, quem está em dia —
    // o caso mais comum de quem atualiza — nunca é convertido.
    const primeiroExit = linhas.findIndex((linha) => linha.trim() === "exit 0");
    expect(chamada).toBeGreaterThan(0);
    expect(primeiroExit).toBeGreaterThan(chamada);
  });

  it("converte SENTRY_DSN vazio (o 'sim' da versão anterior) para o token", () => {
    expect(valorDeSentryDsn(migrar('APP_NAME="Loja"\nSENTRY_DSN=""\n'))).toBe("comunidade");
    // Sem aspas: foi assim que o template antigo documentava o aceite.
    expect(valorDeSentryDsn(migrar("SENTRY_DSN=\n"))).toBe("comunidade");
    // `export` e aspas simples são as formas que o Compose também lê.
    expect(valorDeSentryDsn(migrar('export SENTRY_DSN=""\n'))).toBe("comunidade");
    expect(valorDeSentryDsn(migrar("SENTRY_DSN=''\n"))).toBe("comunidade");
  });

  it("não toca em quem desligou, em quem apontou o próprio Sentry nem em quem nunca decidiu", () => {
    expect(valorDeSentryDsn(migrar("SENTRY_DSN=off\n"))).toBe("off");
    expect(valorDeSentryDsn(migrar('SENTRY_DSN="off"\n'))).toBe("off");
    const proprio = "https://abc123@o0.ingest.sentry.io/42";
    expect(valorDeSentryDsn(migrar(`SENTRY_DSN=${proprio}\n`))).toBe(proprio);
    // Chave ausente = nunca decidiu. Gravá-la seria consentir por alguém.
    const semChave = 'APP_NAME="Loja"\nOWNER_EMAIL=a@b.c\n';
    expect(migrar(semChave)).toBe(semChave);
  });

  it("não deixa a chave duplicada nem mexe no resto do .env", () => {
    const saida = migrar('APP_NAME="Loja"\nSENTRY_DSN=""\nINTERNAL_SECRET=abc\n');
    expect(saida.match(/^SENTRY_DSN=/gm)).toHaveLength(1);
    expect(saida).toContain('APP_NAME="Loja"');
    expect(saida).toContain("INTERNAL_SECRET=abc");
  });

  it("a linha comentada do template não é a chave declarada", () => {
    const comentada = '# SENTRY_DSN=\nAPP_NAME="Loja"\n';
    expect(migrar(comentada)).toBe(comentada);
  });
});

describe("o instalador da VM local pergunta, em vez de gravar vazio", () => {
  it("faz a pergunta e grava a resposta", () => {
    expect(local).toContain("Enviar relatórios de erro anonimizados?");
    expect(local).toContain("SENTRY_DSN=$SENTRY_ESCOLHIDO");
    // O defeito que a #4936 mede: a chave gravada VAZIA no .env.local, que
    // parecia consentimento e (com o padrão novo) desliga a telemetria.
    expect(
      linhasAtivasDaChave(local, "SENTRY_DSN").filter(
        (linha) => linha.replace(/\s/g, "") === "SENTRY_DSN=",
      ),
    ).toEqual([]);
  });

  it("sem terminal não consente por ninguém: desliga dito por extenso", () => {
    expect(local).toContain('SENTRY_ESCOLHIDO="off"');
    expect(local).toContain('SENTRY_ESCOLHIDO="comunidade"');
  });
});
