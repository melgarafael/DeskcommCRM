// @vitest-environment node
/**
 * Unit do `scripts/medir-acervo-waha.ts` (#3377). O que ele cobra: medição que falhou
 * NUNCA se passa por medição. WAHA fora do ar, consulta que falha e pasta do store que
 * não existe viram `falhas` (e exit 1 no programa), não contagem zero.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesDoDocker, medirDiretorio, medirWaha, parseArgs, type Registro } from "./medir-acervo-waha";

const novoRegistro = (): Registro => ({ falhas: [], avisos: [] });

// WAHA de mentira: versão e sessão respondem; os chats da sessão "quebrada" dão 500.
let servidor: http.Server;
let base = "";
beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, corpo: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(corpo));
    };
    if (url.pathname === "/api/server/version") return json(200, { version: "2026.7.2" });
    if (url.pathname === "/api/sessions") return json(200, [{ name: "boa" }, { name: "quebrada" }]);
    if (url.pathname === "/api/boa/chats") return json(200, url.searchParams.get("offset") === "0" ? [{ id: "1@c.us" }] : []);
    if (url.pathname === "/api/boa/chats/1%40c.us/messages") return json(200, [{}, {}, {}]);
    return json(500, { erro: "quebrado" });
  });
  await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => servidor.close(() => ok())));

describe("medir-acervo-waha", () => {
  it("WAHA fora do ar é falha, não 'indisponível · 0 mensagens'", async () => {
    const fechada = http.createServer();
    await new Promise<void>((ok) => fechada.listen(0, "127.0.0.1", ok));
    const porta = (fechada.address() as AddressInfo).port;
    await new Promise<void>((ok) => fechada.close(() => ok()));

    const reg = novoRegistro();
    const opts = parseArgs([], { WAHA_API_BASE_URL: `http://127.0.0.1:${porta}`, WAHA_API_KEY: "segredo123" });
    expect(await medirWaha(opts, reg)).toBeNull();
    expect(reg.falhas).toHaveLength(1);
    expect(reg.falhas[0]).toMatch(/WAHA não respondeu em .*nada do WAHA foi medido/);
    expect(reg.falhas.join()).not.toContain("segredo123");
  });

  it("consulta que falha vira falha nomeada, e o que respondeu segue contado", async () => {
    const reg = novoRegistro();
    const medida = await medirWaha(parseArgs([], { WAHA_API_BASE_URL: base }), reg);
    expect(medida?.mensagens).toBe(3);
    expect(medida?.porSessao.map((s) => s.nome)).toEqual(["boa"]);
    expect(reg.falhas).toEqual([`GET /api/quebrada/chats: HTTP 500: {"erro":"quebrado"}`]);
  });

  it("sem URL o modo só-disco é dito, sem falha", async () => {
    const reg = novoRegistro();
    expect(await medirWaha(parseArgs([], {}), reg)).toBeNull();
    expect(reg).toEqual({ falhas: [], avisos: ["sem WAHA_API_BASE_URL: medindo só o disco"] });
  });

  it("pasta do store que não existe é falha, não '0 arquivos'", () => {
    const reg = novoRegistro();
    expect(medirDiretorio(path.join(os.tmpdir(), "nao-existe-acervo-waha-3377"), reg)).toBeNull();
    expect(reg.falhas[0]).toMatch(/a pasta do store não existe/);
  });

  it("mede arquivos e bytes de uma pasta real", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acervo-waha-"));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "a"), "12345");
    fs.writeFileSync(path.join(dir, "sub", "b"), "1234567890");
    const reg = novoRegistro();
    expect(medirDiretorio(dir, reg)).toMatchObject({ arquivos: 2, bytes: 15 });
    expect(reg.falhas).toEqual([]);
    fs.rmSync(dir, { recursive: true });
  });

  it("converte o MemUsage do docker stats em bytes", () => {
    expect(bytesDoDocker("123.4MiB")).toBe(Math.round(123.4 * 1024 ** 2));
    expect(bytesDoDocker(" 1.25GiB")).toBe(Math.round(1.25 * 1024 ** 3));
    expect(bytesDoDocker("0B")).toBe(0);
    expect(bytesDoDocker("lixo")).toBeNull();
  });
});
