// @vitest-environment node
/**
 * O IDIOMA DA CLI DO INSTALADOR: QUEM DECIDE, O QUE PERSISTE, O QUE FICA SEM TRADUÇÃO.
 *
 * `hostgator-setup-kit/_i18n.sh` é o motor: `t()` devolve o espanhol da tabela
 * `_ES` quando `IDIOMA_CLI=es` e, em qualquer outro caso, a própria chave em
 * português. Seis defeitos possíveis que este arquivo vigia:
 *
 *   1. o idioma escolhido NÃO persistia: `perguntar_idioma_cli` rodava antes de
 *      qualquer `load_env` e só olhava o ambiente, então a reexecução perguntava
 *      de novo — e, com `--yes`, sobrescrevia o `es` guardado com pt-BR;
 *   2. `_i18n.sh` lia o ambiente ao ser carregado, e `update.sh` o recarrega
 *      DEPOIS de `load_env`: as mensagens de `_common.sh` saíam em espanhol e as
 *      do próprio `update.sh` em português;
 *   3. a substituição de `{N}` era em cascata: um argumento com "{2}" dentro era
 *      trocado de novo pelo segundo argumento;
 *   4. `t ""` em es abortava com "bad array subscript";
 *   5. toda chave literal de `t` precisa de entrada em `_ES` — havia 7 sem ela
 *      (o menu de provedores de IA e um aviso com "⚠ ") e títulos de fase, e
 *      "… conferindo", "desconhecida" e "anterior" nem passavam por `t()`.
 *   6. em bash < 4.4 (CentOS 7 traz o 4.2) a tabela `_ES` sai furada e com "bad
 *      array subscript", e as aspas internas de `${x//"{1}"/…}` viravam literais:
 *      agora a tabela só existe a partir do 4.4, o espanhol é recusado com aviso
 *      e `t()` continua trocando os `{N}` em português.
 *
 * Não cobre o caminho interativo (a pergunta com leitura de terminal): ele exige
 * um TTY, e o que decide o idioma sem TTY é exatamente o que se mede aqui.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const KIT = path.join(process.cwd(), "hostgator-setup-kit");
const temporarios: string[] = [];

afterEach(() => {
  while (temporarios.length) rmSync(temporarios.pop()!, { recursive: true, force: true });
});

function pasta(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "idioma-cli-"));
  temporarios.push(dir);
  return dir;
}

/** Roda um trecho de bash com `_i18n.sh` carregado; `env` NÃO herda DESKCOMM_IDIOMA_CLI. */
function bash(script: string, opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", KIT, ...opts.env };
  const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource "$KIT/_i18n.sh"\n${script}`], {
    cwd: opts.cwd ?? process.cwd(),
    env,
    encoding: "utf8",
    input: "",
  });
  return { saida: r.stdout, erro: r.stderr, codigo: r.status };
}

describe("t(): tradução, cascata e chave vazia", () => {
  it("em pt-BR devolve a própria chave; em es, a tradução; chave sem tradução volta em português", () => {
    expect(bash(`t "Gerando segredos"`).saida).toBe("Gerando segredos");
    expect(bash(`IDIOMA_CLI=es; t "Gerando segredos"`).saida).toBe("Generando secretos");
    expect(bash(`IDIOMA_CLI=es; t "frase que nenhuma tabela conhece"`).saida).toBe("frase que nenhuma tabela conhece");
  });

  it("um argumento com {2} dentro não é trocado de novo pelo segundo argumento", () => {
    expect(bash(`t "a {1} b {2}" 'x{2}y' 'Z'`).saida).toBe("a x{2}y b Z");
    expect(bash(`IDIOMA_CLI=es; t "Criando o primeiro admin ({1})" 'a{1}b'`).saida).toBe("Creando el primer admin (a{1}b)");
  });

  it("chave vazia devolve vazio, sem abortar, também em es", () => {
    const r = bash(`IDIOMA_CLI=es; t ""; printf 'fim'`);
    expect(r.codigo).toBe(0);
    expect(r.saida).toBe("fim");
  });
});

describe("perguntar_idioma_cli: a ordem de decisão sem terminal", () => {
  const sem = { NONINTERACTIVE: "1" };
  const idioma = (cwd: string, env: Record<string, string> = {}) =>
    bash(`perguntar_idioma_cli; printf '%s' "$IDIOMA_CLI"`, { cwd, env: { ...sem, ...env } }).saida;

  it("sem nada guardado e sem terminal, fica em pt-BR", () => {
    expect(idioma(pasta())).toBe("pt-BR");
  });

  it("lê o .env da pasta atual: a reexecução mantém o espanhol em vez de sobrescrevê-lo", () => {
    const dir = pasta();
    writeFileSync(path.join(dir, ".env"), "OUTRA_CHAVE=1\nDESKCOMM_IDIOMA_CLI=es\n");
    expect(idioma(dir)).toBe("es");
  });

  it("lê o .env de $REPO_DIR quando o script roda fora do repositório", () => {
    const dir = pasta();
    mkdirSync(path.join(dir, "meu-crm"));
    writeFileSync(path.join(dir, "meu-crm", ".env"), "DESKCOMM_IDIOMA_CLI=es\n");
    expect(idioma(dir, { REPO_DIR: "meu-crm" })).toBe("es");
  });

  it("aceita o valor entre aspas e ignora valor inválido", () => {
    const aspas = pasta();
    writeFileSync(path.join(aspas, ".env"), 'DESKCOMM_IDIOMA_CLI="es"\n');
    expect(idioma(aspas)).toBe("es");
    const invalido = pasta();
    writeFileSync(path.join(invalido, ".env"), "DESKCOMM_IDIOMA_CLI=$(touch /tmp/nao-executa)\n");
    expect(idioma(invalido)).toBe("pt-BR");
  });

  it("com a chave repetida vale a ÚLTIMA (como load_env), e um .env com CRLF é lido", () => {
    const repetida = pasta();
    writeFileSync(path.join(repetida, ".env"), "DESKCOMM_IDIOMA_CLI=pt-BR\nDESKCOMM_IDIOMA_CLI=es\n");
    expect(idioma(repetida)).toBe("es");
    const crlf = pasta();
    writeFileSync(path.join(crlf, ".env"), "OUTRA_CHAVE=1\r\nDESKCOMM_IDIOMA_CLI=es\r\n");
    expect(idioma(crlf)).toBe("es");
  });

  it("a variável de ambiente vence o .env, e o .env nunca é executado", () => {
    const dir = pasta();
    writeFileSync(path.join(dir, ".env"), "DESKCOMM_IDIOMA_CLI=es\n");
    expect(idioma(dir, { DESKCOMM_IDIOMA_CLI: "pt-BR" })).toBe("pt-BR");
    expect(idioma(dir, { DESKCOMM_IDIOMA_CLI: "es" })).toBe("es");
  });
});

describe("recarregar _i18n.sh (o que update.sh faz depois de load_env) não muda o idioma", () => {
  it("com DESKCOMM_IDIOMA_CLI=es vindo do .env, sem perguntar_idioma_cli o idioma segue pt-BR", () => {
    const r = bash(`export DESKCOMM_IDIOMA_CLI=es\nsource "$KIT/_i18n.sh"\nprintf '%s|%s' "$IDIOMA_CLI" "$(t "Gerando segredos")"`);
    expect(r.saida).toBe("pt-BR|Gerando segredos");
  });

  it("depois de perguntar_idioma_cli (install.sh), recarregar mantém o es escolhido", () => {
    const dir = pasta();
    writeFileSync(path.join(dir, ".env"), "DESKCOMM_IDIOMA_CLI=es\n");
    const r = bash(`perguntar_idioma_cli\nsource "$KIT/_i18n.sh"\nprintf '%s|%s' "$IDIOMA_CLI" "$(t "Gerando segredos")"`, {
      cwd: dir,
      env: { NONINTERACTIVE: "1" },
    });
    expect(r.saida).toBe("es|Generando secretos");
  });
});

describe("bash antigo (< 4.4): sem tabela, sem espanhol, sem erro", () => {
  // I18N_BASH_MINIMO=999 simula um bash antigo; o mesmo caminho foi medido em bash:4.2 de verdade.
  const antigo = { I18N_BASH_MINIMO: "999" };

  it("não monta a tabela, e t() devolve o português mesmo pedindo es, sem escrever nada no stderr", () => {
    const r = bash(`IDIOMA_CLI=es; printf '%s|%s' "$_I18N_TABELA" "$(t "Gerando segredos")"`, { env: antigo });
    expect(r.saida).toBe("0|Gerando segredos");
    expect(r.erro).toBe("");
  });

  it("os {N} continuam sendo trocados", () => {
    expect(bash(`t "a {1} b {2}" 'x&y' 'Z'`, { env: antigo }).saida).toBe("a x&y b Z");
  });

  it("quem pediu es recebe o aviso bilíngue e a instalação segue em pt-BR", () => {
    const r = bash(`perguntar_idioma_cli; printf '%s' "$IDIOMA_CLI"`, { env: { ...antigo, NONINTERACTIVE: "1", DESKCOMM_IDIOMA_CLI: "es" } });
    expect(r.saida).toBe("pt-BR");
    expect(r.erro).toMatch(/exige bash 4\.4/);
    expect(r.erro).toMatch(/requiere bash 4\.4/);
  });

  it("o es guardado no .env também gera o aviso; quem não pediu nada não vê ruído novo", () => {
    const guardado = pasta();
    writeFileSync(path.join(guardado, ".env"), "DESKCOMM_IDIOMA_CLI=es\n");
    const com = bash(`perguntar_idioma_cli; printf '%s' "$IDIOMA_CLI"`, { cwd: guardado, env: { ...antigo, NONINTERACTIVE: "1" } });
    expect(com.saida).toBe("pt-BR");
    expect(com.erro).toMatch(/requiere bash 4\.4/);
    const sem = bash(`perguntar_idioma_cli; printf '%s' "$IDIOMA_CLI"`, { cwd: pasta(), env: { ...antigo, NONINTERACTIVE: "1" } });
    expect(sem.saida).toBe("pt-BR");
    expect(sem.erro).toBe("");
  });

  it("as atribuições de t() não levam aspas externas (em bash 4.2 elas deixavam aspas literais: (\"1\"))", () => {
    const src = readFileSync(path.join(KIT, "_i18n.sh"), "utf8");
    expect(src).not.toMatch(/texto="\$\{texto\/\//);
    expect(src).toMatch(/texto=\$\{texto\/\//);
  });
});

describe("toda chave literal de t() do instalador tem entrada em _ES", () => {
  const SPLICE = "'\"'\"'"; // o empalme de aspas do shell: '"'"'  ==  '  (só DENTRO de aspas simples)

  function chavesDaTabela(): Set<string> {
    const r = spawnSync("bash", ["-c", `source "$KIT/_i18n.sh"; for k in "\${!_ES[@]}"; do printf '%s\\0' "$k"; done`], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", KIT },
      encoding: "utf8",
    });
    return new Set(r.stdout.split("\0").filter((k) => k !== ""));
  }

  /** As chaves literais de `t "…"` e `t '…'`; deixa de fora as dinâmicas (com $ ou crase) e os comentários. */
  function chavesUsadas(arquivo: string): { linha: number; chave: string }[] {
    const original = readFileSync(path.join(KIT, arquivo), "utf8");
    const src = original;
    const achadas: { linha: number; chave: string }[] = [];
    const naoComentario = (idx: number) => !/^\s*#/.test(src.slice(src.lastIndexOf("\n", idx) + 1, idx));
    const linha = (idx: number) => src.slice(0, idx).split("\n").length;
    for (const m of src.matchAll(/(?<![\w$])t\s+"((?:[^"\\]|\\[\s\S])*)"/g)) {
      const bruto = m[1]!;
      if (!naoComentario(m.index!) || /(?<!\\)\$[\w{(]/.test(bruto) || /(?<!\\)`/.test(bruto)) continue;
      achadas.push({ linha: linha(m.index!), chave: bruto.replace(/\\(["\\$`])/g, "$1") });
    }
    // Entre aspas simples o empalme É a forma correta de escrever um apóstrofo.
    for (const m of src.matchAll(/(?<![\w$])t\s+'((?:[^']|'"'"')*)'/g)) {
      if (!naoComentario(m.index!)) continue;
      achadas.push({ linha: linha(m.index!), chave: m[1]!.split(SPLICE).join("'") });
    }
    return achadas;
  }

  it("leu a tabela e as chamadas de verdade (não é vacuidade)", () => {
    expect(chavesDaTabela().size).toBeGreaterThan(300);
    expect(chavesUsadas("install.sh").length).toBeGreaterThan(250);
  });

  it("nenhum t \"…\" traz o empalme '\"'\"' (dentro de aspas duplas ele parte a palavra e vira pipe)", () => {
    for (const arquivo of ["install.sh", "_common.sh"]) {
      const src = readFileSync(path.join(KIT, arquivo), "utf8");
      const ruins = src.split("\n").map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => /\bt\s+"[^"\n]*'"'"'/.test(l));
      expect(ruins.map(({ n }) => `${arquivo}:${n}`)).toEqual([]);
    }
  });

  it("os títulos das fases e a palavra Fase passam por t(), em vez de sair em português fixo", () => {
    const src = readFileSync(path.join(KIT, "install.sh"), "utf8");
    const chamadas = [...src.matchAll(/^\s*fase\s+\d+\s+(.+)$/gm)].map((m) => m[1]!.trim());
    expect(chamadas.length, "install.sh deixou de chamar fase N \"título\"").toBeGreaterThanOrEqual(4);
    expect(chamadas.filter((c) => !c.startsWith('"$(t "'))).toEqual([]);
    expect(src).toMatch(/^fase\(\) \{.*\$\(t "Fase"\)/m);
  });

  for (const arquivo of ["install.sh", "_common.sh"]) {
    it(`${arquivo}: nenhuma chave literal fica sem tradução`, () => {
      const tabela = chavesDaTabela();
      const sem = chavesUsadas(arquivo)
        .filter((c) => !tabela.has(c.chave))
        .map((c) => `${arquivo}:${c.linha} ${JSON.stringify(c.chave.slice(0, 90))}`);
      expect(sem, `${sem.length} chave(s) sem entrada em _ES (hostgator-setup-kit/_i18n.sh): em espanhol saem em português.`).toEqual([]);
    });
  }
});
