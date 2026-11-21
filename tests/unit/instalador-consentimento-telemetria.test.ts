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
const i18n = readFileSync(join(RAIZ, "hostgator-setup-kit/_i18n.sh"), "utf8");

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
function migrar(conteudo: string, chamada = 'migrar_consentimento_de_telemetria "$1"'): string {
  const dir = mkdtempSync(join(tmpdir(), "telemetria-4936-"));
  const env = join(dir, ".env");
  writeFileSync(env, conteudo);
  try {
    execFileSync(
      "bash",
      [
        "-c",
        `source hostgator-setup-kit/_common.sh; ${chamada}`,
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

  it("gravar_imagens converte, porque é ela que o update.sh ANTIGO chama", () => {
    // Quem atualiza roda o corpo do update.sh da versão que já tem: ele relê o
    // kit e chama `gravar_imagens`, mas não conhece a chamada nova do corpo.
    // A conversão precisa estar dentro dela para valer já nesta atualização.
    const env = 'VAPID_PUBLIC_KEY="pub"\nVAPID_PRIVATE_KEY="priv"\nSENTRY_DSN=""\n';
    const saida = migrar(env, 'gravar_imagens "$1" 9.9.9');
    expect(valorDeSentryDsn(saida)).toBe("comunidade");
    expect(saida).toMatch(/^APP_IMAGE=.*:9\.9\.9$/m);
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

/**
 * Roda a conversão VÁRIAS vezes na MESMA pasta, como atualizações seguidas da
 * mesma instalação. Entre uma passada e outra, `editar` faz o que a pessoa
 * faria à mão no `.env`.
 */
function migrarEmSequencia(
  inicial: string,
  passos: Array<(atual: string) => string>,
  marcaAntes = false,
): string[] {
  const dir = mkdtempSync(join(tmpdir(), "telemetria-4948-"));
  const env = join(dir, ".env");
  writeFileSync(env, inicial);
  if (marcaAntes) writeFileSync(join(dir, ".env.consentimento-de-telemetria"), "# marca\n");
  const rodar = () =>
    execFileSync(
      "bash",
      ["-c", 'source hostgator-setup-kit/_common.sh; migrar_consentimento_de_telemetria "$1"', "_", env],
      { cwd: RAIZ, stdio: "pipe", timeout: 60_000 },
    );
  try {
    const saidas: string[] = [];
    rodar();
    saidas.push(readFileSync(env, "utf8"));
    for (const editar of passos) {
      writeFileSync(env, editar(readFileSync(env, "utf8")));
      rodar();
      saidas.push(readFileSync(env, "utf8"));
    }
    return saidas;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const esvaziar = (t: string) => t.replace(/^SENTRY_DSN=.*$/m, "SENTRY_DSN=");

describe("a conversão acontece uma vez só por instalação (#4948)", () => {
  it("quem esvazia a chave DEPOIS da conversão continua desligado na atualização seguinte", () => {
    const [primeira, segunda] = migrarEmSequencia('SENTRY_DSN=""\n', [esvaziar]);
    expect(valorDeSentryDsn(primeira ?? "")).toBe("comunidade");
    // Vazio agora é "desligado": religar aqui seria consentir pela pessoa.
    expect(valorDeSentryDsn(segunda ?? "")).toBe("");
  });

  it("a primeira passada marca mesmo sem converter: quem estava em off e esvazia depois não é religado", () => {
    const [primeira, segunda] = migrarEmSequencia("SENTRY_DSN=off\n", [esvaziar]);
    expect(valorDeSentryDsn(primeira ?? "")).toBe("off");
    expect(valorDeSentryDsn(segunda ?? "")).toBe("");
  });

  it("instalação feita pelo install.sh novo (com a marca) e chave vazia nunca é convertida", () => {
    const [unica] = migrarEmSequencia("SENTRY_DSN=\n", [], true);
    expect(valorDeSentryDsn(unica ?? "")).toBe("");
  });

  it("o install.sh cria a marca logo depois de escrever o .env", () => {
    const linhas = install.split("\n");
    const fecho = linhas.findIndex((l) => l.trim() === "} > .env");
    const marca = linhas.findIndex((l) => l.trim() === "marcar_consentimento_de_telemetria .env.consentimento-de-telemetria");
    expect(fecho).toBeGreaterThan(-1);
    expect(marca).toBeGreaterThan(fecho);
    expect(marca - fecho).toBeLessThan(8);
  });
});

describe("as traduções mantêm o token do aceite", () => {
  it("toda mensagem que manda escrever SENTRY_DSN=comunidade diz o mesmo token em espanhol", () => {
    // O token é lido por lib/sentry/dsn.ts: traduzido, ele vira um DSN inválido
    // e quem seguir a mensagem fica sem telemetria achando que aceitou.
    const entradas = [...i18n.matchAll(/^\s*\["(.*)"\]="(.*)"\s*$/gm)].filter(([, pt]) =>
      (pt ?? "").includes("SENTRY_DSN=comunidade"),
    );
    expect(entradas.length).toBeGreaterThan(0);
    const traduzidas = entradas.map(([, pt, es]) => ({
      pt,
      tokens: (es ?? "").match(/SENTRY_DSN=[\w-]+/g) ?? [],
    }));
    for (const { pt, tokens } of traduzidas) {
      expect(tokens, pt).toContain("SENTRY_DSN=comunidade");
      expect(tokens.filter((t) => t !== "SENTRY_DSN=comunidade"), pt).toEqual([]);
    }
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
