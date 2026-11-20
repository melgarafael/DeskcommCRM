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
  const docker = readFileSync("Dockerfile", "utf8");
  const recipe = docker.slice(docker.indexOf("RUN PDFJS_DIR="), docker.indexOf("# ---- runner:"))
    .replace(/^RUN /, "").replace(/\\\n/g, " ");
  const copied = spawnSync("sh", ["-eu", "-c", recipe], { cwd: root, encoding: "utf8" });
  expect(copied.status, copied.stderr).toBe(0);
  const loaded = spawnSync(process.execPath, ["-e", `process.stdout.write(require('./node_modules/.pnpm/${pdf}/@napi-rs/canvas'))`], { cwd: join(root, ".next/standalone"), encoding: "utf8" });
  expect(loaded.status, loaded.stderr).toBe(0);
  expect(loaded.stdout).toBe("binding-fixture");
});
