/**
 * O PREPARO DO E2E DESISTE DE UM APT TRAVADO EM MINUTOS E TENTA DE NOVO.
 *
 * Medido em 23/10/2026 (42 runs, 281 partes): "Instalar o browser" e "Instalar
 * o ffmpeg" são bimodais — saudáveis em ≤ 53 s, travados de 653 s a 1.511 s,
 * nada no meio. Travado, o passo comia o teto de 30 min e a parte era
 * cancelada sem rodar caso nenhum. O laço e a medição moram no `e2e.yml`.
 *
 * Este teste RODA o script dos dois passos (extraído do e2e.yml, sem cópia) com
 * `timeout`, `sudo` e `pnpm` falsos no PATH. O `timeout` falso devolve 124
 * (estourou) ou 0 conforme o roteiro, e registra o que lhe pediram para rodar.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const E2E = path.resolve(__dirname, "../../.github/workflows/e2e.yml");

function scriptDoPasso(nome: string): string {
  const linhas = readFileSync(E2E, "utf-8").split("\n");
  const inicio = linhas.findIndex((l) => l.includes(`- name: ${nome}`));
  expect(inicio, `o passo '${nome}' sumiu do e2e.yml`).toBeGreaterThan(-1);
  const run = linhas.findIndex((l, i) => i > inicio && /^\s+run: \|\s*$/.test(l));
  const corpo: string[] = [];
  for (const l of linhas.slice(run + 1)) {
    if (l.trim() !== "" && !l.startsWith(" ".repeat(10))) break;
    corpo.push(l.slice(10));
  }
  return corpo.join("\n");
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `roteiro`: o código de saída de cada chamada ao `timeout`, em ordem. */
function rodar(passo: string, roteiro: number[]) {
  const raiz = mkdtempSync(path.join(tmpdir(), "e2e-preparo-"));
  dirs.push(raiz);
  const bin = path.join(raiz, "bin");
  mkdirSync(bin);
  const log = path.join(raiz, "chamadas.log");
  writeFileSync(path.join(raiz, "roteiro"), roteiro.join("\n") + "\n");
  const falso = (nome: string, corpo: string) => {
    writeFileSync(path.join(bin, nome), `#!/bin/sh\n${corpo}\n`);
    chmodSync(path.join(bin, nome), 0o755);
  };
  // O sucesso "instala" um ffmpeg com os dois encoders, para a sonda do passo passar.
  falso(
    "timeout",
    `echo "timeout $*" >> "${log}"
rc=$(head -1 "${raiz}/roteiro"); sed -i.bak 1d "${raiz}/roteiro"
if [ "$rc" = 0 ]; then printf '#!/bin/sh\\necho " A..... aac   AAC (Advanced Audio Coding)"\\necho " A..... libopus   libopus Opus"\\n' > "${bin}/ffmpeg"; chmod +x "${bin}/ffmpeg"; fi
exit "$rc"`,
  );
  falso("sudo", `echo "sudo $*" >> "${log}"`);
  const r = spawnSync("bash", ["-e", "-c", scriptDoPasso(passo)], {
    // PATH mínimo: um ffmpeg da máquina de quem roda o teste pularia o laço.
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: raiz },
    encoding: "utf-8",
  });
  return {
    status: r.status,
    saida: r.stdout + r.stderr,
    chamadas: readFileSync(log, "utf-8").trim().split("\n"),
    home: raiz,
  };
}

const BROWSER = "Instalar o browser";
const FFMPEG = "Instalar o ffmpeg e sondar os encoders";
const ESTOUROU = 124;

describe("e2e.yml — o preparo não espera o espelho do apt para sempre", () => {
  it("browser: duas tentativas travadas e a terceira passa → verde, com limpeza entre elas", () => {
    const r = rodar(BROWSER, [ESTOUROU, ESTOUROU, 0]);
    expect(r.status, r.saida).toBe(0);
    const tentativas = r.chamadas.filter((c) => c.startsWith("timeout"));
    expect(tentativas).toHaveLength(3);
    expect(tentativas[0]).toMatch(/^timeout -k \d+ \d+ pnpm exec playwright install --with-deps chromium$/);
    expect(r.chamadas.filter((c) => c === "sudo dpkg --configure -a")).toHaveLength(2);
    expect(r.saida).toContain("::warning");
  });

  it("browser: travado nas 3 → vermelho com ::error::, sem quarta tentativa", () => {
    const r = rodar(BROWSER, [ESTOUROU, ESTOUROU, ESTOUROU]);
    expect(r.status, r.saida).toBe(1);
    expect(r.chamadas.filter((c) => c.startsWith("timeout"))).toHaveLength(3);
    expect(r.saida).toContain("::error");
  });

  it("ffmpeg: a 1ª tentativa não roda update; a seguinte roda, e a sonda dos encoders passa", () => {
    const r = rodar(FFMPEG, [ESTOUROU, 0]);
    expect(r.status, r.saida).toBe(0);
    const tentativas = r.chamadas.filter((c) => c.startsWith("timeout"));
    expect(tentativas).toHaveLength(2);
    expect(tentativas[0]).not.toContain("apt-get update");
    // Os .deb vão para a pasta que o cache do passo seguinte guarda — sem isso o cache fica vazio.
    expect(tentativas[0]).toContain(`apt-get install -y -q --no-install-recommends -o Dir::Cache::Archives=${r.home}/.cache/ffmpeg-apt/ ffmpeg`);
    expect(tentativas[1]).toContain("sudo apt-get update -q && sudo apt-get install");
  });

  it("ffmpeg: travado nas 3 → vermelho com ::error::", () => {
    const r = rodar(FFMPEG, [ESTOUROU, ESTOUROU, ESTOUROU]);
    expect(r.status, r.saida).toBe(1);
    expect(r.chamadas.filter((c) => c.startsWith("timeout"))).toHaveLength(3);
    expect(r.saida).toContain("::error");
  });

  it("o cache do ffmpeg guarda a mesma pasta em que o passo instala", () => {
    const yml = readFileSync(E2E, "utf-8");
    const caminhos = [...yml.matchAll(/path: (~\/\.cache\/ffmpeg-apt\/\*\.deb)/g)].map((m) => m[1]);
    expect(caminhos, "restaurar e guardar").toHaveLength(2);
    expect(scriptDoPasso(FFMPEG)).toContain('debs="$HOME/.cache/ffmpeg-apt"');
  });

  it("os dois passos têm cinto próprio de timeout-minutes", () => {
    const yml = readFileSync(E2E, "utf-8");
    for (const nome of [BROWSER, FFMPEG]) {
      const trecho = yml.slice(yml.indexOf(`- name: ${nome}`)).split("run: |")[0];
      expect(trecho, nome).toMatch(/timeout-minutes: \d+/);
    }
  });
});
