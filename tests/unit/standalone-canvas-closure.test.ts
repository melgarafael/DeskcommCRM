import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("a receita Docker conserva o alvo do symlink do canvas e seu binding instalado", () => {
  const root = mkdtempSync(join(tmpdir(), "canvas-closure-")); roots.push(root);
  const put = (name: string, body: string) => { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  const link = (target: string, name: string) => { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); symlinkSync(target, p); };
  const pdf = "pdfjs-dist@5.0.0/node_modules";
  const canvas = "@napi-rs+canvas@0.1.0/node_modules";
  const binding = "@napi-rs+canvas-linux-x64-musl@0.1.0/node_modules/@napi-rs/canvas-linux-x64-musl";
  put(`node_modules/.pnpm/${pdf}/pdfjs-dist/legacy/build/pdf.worker.mjs`, "// fixture");
  put(`node_modules/.pnpm/${canvas}/@napi-rs/canvas/index.js`, 'module.exports = require("@napi-rs/canvas-linux-x64-musl");');
  put(`node_modules/.pnpm/${binding}/index.js`, 'module.exports = "binding-fixture";');
  link(`../../../${binding}`, `node_modules/.pnpm/${canvas}/@napi-rs/canvas-linux-x64-musl`);
  link(`../../../${canvas}/@napi-rs/canvas`, `node_modules/.pnpm/${pdf}/@napi-rs/canvas`);
  link(`.pnpm/${pdf}/pdfjs-dist`, "node_modules/pdfjs-dist");
  mkdirSync(join(root, ".next/standalone/.next/server/chunks"), { recursive: true });
  mkdirSync(join(root, ".next/standalone/node_modules/.pnpm"), { recursive: true });
  // O `RUN` do #4967 copia `.next/static` para dentro do standalone: sem a pasta
  // de origem na fixture, o passo reprovaria por motivo alheio a este caso.
  put(".next/static/marcador-do-static.txt", "static-fixture");
  const docker = readFileSync("Dockerfile", "utf8");
  // A fatia entre o RUN do pdf.js e o estágio `runner` pode ter MAIS DE UM `RUN`
  // — o #4967 acrescentou o `cp -a .next/static`. Rodar a fatia inteira num `sh`
  // só executava o segundo `RUN` como nome de comando (`sh: 18: RUN: not found`)
  // e reprovava a cerca por forma, não por defeito. Aqui cada `RUN` vira um passo
  // próprio, e TODOS rodam, na ordem em que o Docker executa o estágio: nenhum
  // passo da receita deixa de ser medido.
  const steps = docker
    .slice(docker.indexOf("RUN PDFJS_DIR="), docker.indexOf("# ---- runner:"))
    .split(/^RUN /m)
    .slice(1)
    .map((step) => step.replace(/\\\n/g, " "));
  expect(steps.length, "a fatia da receita virou vazia — o leitor cegou").toBeGreaterThan(0);
  for (const [i, step] of steps.entries()) {
    const r = spawnSync("sh", ["-eu", "-c", step], { cwd: root, encoding: "utf8" });
    expect(r.status, `passo ${i + 1} da receita: ${r.stderr}`).toBe(0);
  }
  const loaded = spawnSync(process.execPath, ["-e", `process.stdout.write(require('./node_modules/.pnpm/${pdf}/@napi-rs/canvas'))`], { cwd: join(root, ".next/standalone"), encoding: "utf8" });
  expect(loaded.status, loaded.stderr).toBe(0);
  expect(loaded.stdout).toBe("binding-fixture");
  // E o static tem de continuar caindo DENTRO do standalone (#4967): um `cp` com
  // destino errado passa nos casos acima e não é pego por mais nada.
  expect(readFileSync(join(root, ".next/standalone/.next/static/marcador-do-static.txt"), "utf8")).toBe("static-fixture");
});
