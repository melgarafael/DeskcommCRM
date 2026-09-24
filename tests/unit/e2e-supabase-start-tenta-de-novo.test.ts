/**
 * O `supabase start` DO E2E TENTA DE NOVO QUANDO O REGISTRO RECUSA O PULL — E SÓ AÍ.
 *
 * Medido em 23/09/2026, run 35908153939: com ~10 PRs disparando CI juntos, as
 * cinco partes do e2e morreram no passo "Subir Supabase local" com
 * `toomanyrequests: … allowed: 44000/minute` do ghcr.io. O CLI tenta 3 vezes
 * por imagem com 4s e 8s de espera — dentro do mesmo minuto do limite — e o
 * PR ficava vermelho sem culpa.
 *
 * Este teste RODA o script do passo (extraído do e2e.yml, sem cópia) com um
 * `supabase` e um `sleep` falsos no PATH, e mede o comportamento:
 *   - pull recusado duas vezes e depois aceito → verde, com `stop` entre elas
 *     e alternando ghcr.io ↔ public.ecr.aws (a espera sozinha não bastou:
 *     o ghcr.io recusou por 4,5 min seguidos no run 35910532729);
 *   - falha que não é de registro → vermelho NA HORA, sem esperar;
 *   - registro recusando sempre → vermelho depois da 4ª tentativa, com `::error::`.
 *
 * O caso 2 é o que vigia o `pipefail`: sem ele, `supabase start | tee` tem o
 * status do `tee` e o passo sai verde com o Supabase fora do ar.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const E2E = path.resolve(__dirname, "../../.github/workflows/e2e.yml");

function scriptDoPasso(): string {
  const linhas = readFileSync(E2E, "utf-8").split("\n");
  const inicio = linhas.findIndex((l) => l.includes("- name: Subir Supabase local"));
  expect(inicio, "o passo 'Subir Supabase local' sumiu do e2e.yml").toBeGreaterThan(-1);
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

/** `saidas`: o que cada chamada de `supabase start` imprime e se falha; a última se repete. */
function rodar(saidas: Array<{ texto: string; falha: boolean }>) {
  const raiz = mkdtempSync(path.join(tmpdir(), "sb-start-"));
  dirs.push(raiz);
  const bin = path.join(raiz, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(raiz, "repo/supabase/migrations"), { recursive: true });
  writeFileSync(path.join(raiz, "saidas.json"), JSON.stringify(saidas));

  const supabase = path.join(bin, "supabase");
  writeFileSync(
    supabase,
    `#!/usr/bin/env node
const fs = require("fs");
const raiz = ${JSON.stringify(raiz)};
const registro = process.argv[2] === "start" ? "@" + process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY + " " : "";
fs.appendFileSync(raiz + "/chamadas.log", registro + process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] !== "start") process.exit(0);
const n = fs.readFileSync(raiz + "/chamadas.log", "utf-8").split("\\n").filter((l) => l.startsWith("@")).length;
const saidas = JSON.parse(fs.readFileSync(raiz + "/saidas.json", "utf-8"));
const s = saidas[Math.min(n, saidas.length) - 1];
process.stderr.write(s.texto + "\\n");
process.exit(s.falha ? 1 : 0);
`,
  );
  const sleep = path.join(bin, "sleep");
  writeFileSync(sleep, `#!/bin/sh\necho "sleep $1" >> "${raiz}/chamadas.log"\n`);
  chmodSync(supabase, 0o755);
  chmodSync(sleep, 0o755);

  // O passo escreve em /tmp; aqui cada rodada tem o seu.
  const script = scriptDoPasso().replaceAll("/tmp/", `${raiz}/`);
  // `bash -e`, o mesmo shell que o GitHub dá a um `run:` sem `shell:`.
  const r = spawnSync("bash", ["-e", "-c", script], {
    cwd: path.join(raiz, "repo"),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf-8",
  });
  const chamadas = readFileSync(path.join(raiz, "chamadas.log"), "utf-8").trim().split("\n");
  return { status: r.status, saida: r.stdout + r.stderr, chamadas };
}

const LIMITE = {
  texto: "Error response from daemon: toomanyrequests: retry-after: 913.381µs, allowed: 44000/minute",
  falha: true,
};

describe("e2e.yml — supabase start resiste ao limite do registro", () => {
  it("tenta de novo, alternando o registro, com stop e espera crescente, e fica verde quando o pull passa", () => {
    const r = rodar([LIMITE, LIMITE, { texto: "Started supabase local development setup.", falha: false }]);
    expect(r.status, r.saida).toBe(0);
    expect(r.chamadas).toEqual([
      "@ghcr.io start -x studio,postgres-meta",
      "stop --no-backup",
      "sleep 20",
      "@public.ecr.aws start -x studio,postgres-meta",
      "stop --no-backup",
      "sleep 60",
      "@ghcr.io start -x studio,postgres-meta",
    ]);
    expect(r.saida).toContain("::warning");
  });

  it("falha que não é de registro fica vermelha na hora, sem esperar", () => {
    const r = rodar([
      { texto: "failed to bind host port for 0.0.0.0:54322: address already in use", falha: true },
    ]);
    expect(r.status, r.saida).toBe(1);
    expect(r.chamadas).toEqual(["@ghcr.io start -x studio,postgres-meta"]);
    expect(r.saida).toContain("::error");
  });

  it("registro recusando sempre: vermelho depois da 4ª tentativa, com ::error::", () => {
    const r = rodar([LIMITE]);
    expect(r.status, r.saida).toBe(1);
    expect(r.chamadas.filter((c) => c.startsWith("@")).map((c) => c.split(" ")[0])).toEqual([
      "@ghcr.io",
      "@public.ecr.aws",
      "@ghcr.io",
      "@public.ecr.aws",
    ]);
    expect(r.chamadas.filter((c) => c.startsWith("sleep"))).toEqual(["sleep 20", "sleep 60", "sleep 120"]);
    expect(r.saida).toContain("::error title=supabase start falhou 4 vezes");
  });
});
