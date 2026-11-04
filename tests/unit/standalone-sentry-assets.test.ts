import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/completar-standalone-sentry.mjs");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "standalone-sentry-fixture-"));
  dirs.push(root);
  const source = join(root, "node_modules/@sentry/server-runtime-injection");
  const target = join(root, ".next/standalone/node_modules/@sentry/server-runtime-injection");
  const put = (p: string, value: string) => {
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, value);
  };
  put(join(root, "package.json"), "{}");
  put(
    join(root, "node_modules/@sentry/nextjs/package.json"),
    '{"name":"@sentry/nextjs","version":"11.0.0"}',
  );
  const manifest = '{"name":"@sentry/server-runtime-injection","version":"11.0.0"}';
  put(join(source, "package.json"), manifest);
  put(join(target, "package.json"), manifest);
  put(join(source, "build/esm/tracing-hooks/hook.js"), "export const hook = true;");
  put(join(source, "build/esm/_virtual/_commonjsHelpers.js"), "export const helper = true;");
  const run = (args: string[] = [], vercel = "") =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH, VERCEL: vercel, NODE_ENV: "test" },
      timeout: 10_000,
    });
  return { root, source, target, put, run };
}
describe("standalone conserva a árvore ESM instalada do Sentry", () => {
  it("copia os módulos omitidos, sela os hashes e reaplica sem mudar arquivos", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    expect(readFileSync(join(f.target, "build/esm/tracing-hooks/hook.js"), "utf8")).toBe(
      "export const hook = true;",
    );
    const receipt = readFileSync(
      join(f.root, ".next/standalone/.sentry-runtime-assets.json"),
      "utf8",
    );
    expect(JSON.parse(receipt).packages[0].files["build/esm/tracing-hooks/hook.js"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(f.run().status).toBe(0);
    expect(readFileSync(join(f.root, ".next/standalone/.sentry-runtime-assets.json"), "utf8")).toBe(
      receipt,
    );
  });
  it("não sobrescreve módulo divergente", () => {
    const f = fixture();
    const p = join(f.target, "build/esm/tracing-hooks/hook.js");
    f.put(p, "different");
    expect(f.run().status).not.toBe(0);
    expect(readFileSync(p, "utf8")).toBe("different");
  });
  it("recusa versão diferente no artefato", () => {
    const f = fixture();
    f.put(
      join(f.target, "package.json"),
      '{"name":"@sentry/server-runtime-injection","version":"12"}',
    );
    expect(f.run().status).not.toBe(0);
  });
  it("recusa origem sem os módulos essenciais", () => {
    const f = fixture();
    rmSync(join(f.source, "build/esm/tracing-hooks/hook.js"));
    expect(f.run().status).not.toBe(0);
  });
  it("recusa symlink que tiraria uma escrita do standalone", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.target, "build"));
    expect(f.run().status).not.toBe(0);
  });
  it("recusa recibo alterado em vez de declarar integridade", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    f.put(join(f.root, ".next/standalone/.sentry-runtime-assets.json"), "{}");
    expect(f.run().status).not.toBe(0);
  });
  it("ausência de standalone só é tolerada no adapter que o desliga", () => {
    const f = fixture();
    rmSync(join(f.root, ".next"), { recursive: true });
    expect(f.run().status).not.toBe(0);
    expect(f.run([], "1").status).toBe(0);
  });
  it("argumento explícito inválido nunca é ignorado pelo adapter", () => {
    const f = fixture();
    expect(f.run(["--invalid"], "1").status).not.toBe(0);
  });
});
