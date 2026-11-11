/**
 * RUNNER SEM DNS REPETE O PREPARO, EM VEZ DE REPROVAR NA PRIMEIRA TENTATIVA.
 *
 * Medido em 11/11/2026 (runs 43014074395, 43023280678, 43027136525): o apt
 * devolvia `Temporary failure resolving` e fechava com `W: Some index files
 * failed to download`, que `recuperar_apt_e2e` lia como download do browser
 * e recusava repetir. O log abaixo é o do run 43014074395, parte 1, encurtado.
 *
 * Chama a função direto, com `sudo` e `sleep` falsos no PATH hermético: nada
 * dorme de verdade e nenhum processo da máquina de teste é alcançado.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { binariosDoSistema } from "../helpers/path-hermetico-do-preparo";

const RAIZ = path.resolve(__dirname, "../..");

const SEM_DNS = `Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist [144 B]
Ign:2 http://azure.archive.ubuntu.com/ubuntu resolute InRelease
Ign:2 https://archive.ubuntu.com/ubuntu resolute InRelease
Err:2 https://security.ubuntu.com/ubuntu resolute InRelease
  Temporary failure resolving 'azure.archive.ubuntu.com'
  Temporary failure resolving 'archive.ubuntu.com'
  Temporary failure resolving 'security.ubuntu.com'
Fetched 299 kB in 3min 20s (1498 B/s)
W: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/dists/resolute/InRelease  Temporary failure resolving 'security.ubuntu.com'
W: Some index files failed to download. They have been ignored, or old ones used instead.
`;
const BROWSER = "Downloading Chromium 140.0 from https://cdn.playwright.dev/chromium.zip\n";

const temporarios: string[] = [];
afterEach(() => {
  for (const dir of temporarios.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function recuperar(log: string, tentativa = 1, ambiente = "github-hosted") {
  const raiz = mkdtempSync(path.join(tmpdir(), "e2e-apt-dns-"));
  temporarios.push(raiz);
  const bin = path.join(raiz, "bin");
  mkdirSync(bin);
  const chamadas = path.join(raiz, "chamadas.log");
  writeFileSync(chamadas, "");
  writeFileSync(path.join(raiz, "apt.log"), log);
  for (const nome of ["sudo", "sleep"]) {
    writeFileSync(path.join(bin, nome), `#!/bin/sh\necho "${nome} $*" >> "$TEST_LOG"\n`);
    chmodSync(path.join(bin, nome), 0o755);
  }
  const r = spawnSync(
    "bash",
    ["-e", "-c", `source scripts/ci/apt-e2e-failover.sh; recuperar_apt_e2e 124 "${raiz}/apt.log" ${tentativa}`],
    {
      cwd: RAIZ,
      env: {
        PATH: `${bin}:${binariosDoSistema(path.join(raiz, "sistema"))}`,
        GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: ambiente, TEST_LOG: chamadas,
      },
      encoding: "utf-8",
      timeout: 10_000,
    },
  );
  return {
    status: r.status,
    saida: r.stdout + r.stderr,
    chamadas: readFileSync(chamadas, "utf-8").split("\n").filter(Boolean),
  };
}

describe("preparo do E2E com o runner sem DNS", () => {
  it("o log medido repete: limpa o apt, espera e não troca o espelho", () => {
    const r = recuperar(SEM_DNS);
    expect(r.status, r.saida).toBe(0);
    expect(r.saida).toContain("resolução de nome (DNS)");
    expect(r.chamadas).toEqual(["sudo pkill -KILL -x apt-get", "sudo dpkg --configure -a", "sleep 20"]);
  });

  it("repete também quando o browser chegou a tentar o download, esperando mais na 2ª", () => {
    const r = recuperar(SEM_DNS + BROWSER, 2);
    expect(r.status, r.saida).toBe(0);
    expect(r.chamadas).toEqual(["sudo pkill -KILL -x apt-get", "sudo dpkg --configure -a", "sleep 40"]);
  });

  it("na 3ª tentativa devolve 0 sem trabalho novo: o erro final é do laço", () => {
    const r = recuperar(SEM_DNS, 3);
    expect(r.status, r.saida).toBe(0);
    expect(r.chamadas).toEqual([]);
  });

  it("fora do runner descartável recusa antes de pkill, dpkg ou espera", () => {
    const r = recuperar(SEM_DNS + BROWSER, 1, "self-hosted");
    expect(r.status, r.saida).not.toBe(0);
    expect(r.saida).toContain("Recuperação APT recusada");
    expect(r.chamadas).toEqual([]);
  });

  it("hash recusado continua fatal mesmo com falha de DNS no mesmo log", () => {
    const r = recuperar(`${SEM_DNS}E: Hash Sum mismatch\n`);
    expect(r.status, r.saida).not.toBe(0);
    expect(r.saida).toContain("Falha fatal no preparo APT");
    expect(r.chamadas).toEqual([]);
  });

  it("falha de download sem erro de DNS continua fora do transporte APT", () => {
    const r = recuperar(`Get:1 http://azure.archive.ubuntu.com/ubuntu resolute InRelease\n${BROWSER}Error: Failed to download Chromium\n`);
    expect(r.status, r.saida).not.toBe(0);
    expect(r.saida).toContain("Preparo falhou fora do transporte APT");
    expect(r.chamadas).toEqual([]);
  });
});
