/**
 * Grupos no cliente do WAHA — a Task 0 mediu o WAHA real e o formato NÃO bate
 * com o que o brief original assumia:
 *
 *   - `GET /api/{session}/groups` devolve um OBJETO chaveado por id de grupo
 *     (`{ "<id>@g.us": GroupObject, ... }`), não um array. A fixture guarda os
 *     grupos como array (`fixture.groups`) só porque é mais fácil de escrever
 *     à mão; o servidor falso abaixo os re-chaveia por `id` antes de responder,
 *     para exercitar a MESMA forma que o WAHA real devolve.
 *   - `group.id` é string simples (nunca `{ _serialized }`), formato moderno
 *     `<18 dígitos>@g.us` OU legado `<telefone>-<timestamp>@g.us` — os dois
 *     terminam em `@g.us` e são o que `listarGrupos` precisa aceitar.
 *
 * Ver .superpowers/sdd/2026-09-23-grupos-na-inbox/task-0-report.md.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WahaClient } from "./client";

const fixture = JSON.parse(
  readFileSync("lib/waha/__fixtures__/grupos-noweb-2026.7.2.json", "utf8"),
) as { groups: Array<{ id: string; subject: string }> };

/** O WAHA real devolve objeto chaveado por id (Task 0) — não o array cru da fixture. */
const gruposComoOWahaDevolve = Object.fromEntries(fixture.groups.map((g) => [g.id, g]));

let server: Server;
let base = "";
let sessao: {
  name: string;
  status: string;
  engine: { engine: string };
  config: { ignore: Record<string, boolean>; webhooks: unknown[] };
};
let putsRecebidos: unknown[] = [];
/** Controla o caso "PUT responde 200 mas não aplica" sem depender de timing (regra do controlador). */
let ignorarProximoPut = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/groups")) return res.end(JSON.stringify(gruposComoOWahaDevolve));
      if (req.url === "/api/sessions/s1" && req.method === "GET") return res.end(JSON.stringify(sessao));
      if (req.url === "/api/sessions/s1" && req.method === "PUT") {
        const j = JSON.parse(body);
        putsRecebidos.push(j);
        if (!ignorarProximoPut) sessao = { ...sessao, config: j.config };
        ignorarProximoPut = false;
        return res.end(JSON.stringify(sessao));
      }
      if (req.url === "/api/server/version") return res.end(JSON.stringify({ engine: "NOWEB" }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  putsRecebidos = [];
  ignorarProximoPut = false;
  sessao = {
    name: "s1",
    status: "WORKING",
    engine: { engine: "NOWEB" },
    config: { ignore: { status: true, broadcast: true, channels: true, groups: true }, webhooks: [] },
  };
});

const cliente = () => new WahaClient(base, "chave-teste");

describe("grupos no cliente do WAHA", () => {
  it("lista grupos como { chatId, subject } a partir do formato real medido", async () => {
    const grupos = await cliente().listarGrupos("s1");
    expect(grupos.length).toBeGreaterThan(0);
    expect(grupos.length).toBe(fixture.groups.length);
    for (const g of grupos) {
      expect(g.chatId).toMatch(/@g\.us$/);
      expect(typeof g.subject === "string" || g.subject === null).toBe(true);
    }
  });

  it("ligar grupos grava ignore.groups=false preservando o resto do config, e confirma relendo", async () => {
    await expect(cliente().definirRecebimentoDeGrupos("s1", true)).resolves.toBe(true);
    expect(putsRecebidos).toHaveLength(1);
    expect(
      (putsRecebidos[0] as { config: { ignore: Record<string, boolean>; webhooks: unknown } }).config,
    ).toMatchObject({
      ignore: { status: true, broadcast: true, channels: true, groups: false },
      webhooks: [],
    });
  });

  it("I1: pedir o valor que a sessão JÁ tem confirma sem PUT (sem reinício de sessão)", async () => {
    sessao.config.ignore.groups = false;
    await expect(cliente().definirRecebimentoDeGrupos("s1", true)).resolves.toBe(true);
    sessao.config.ignore.groups = true;
    await expect(cliente().definirRecebimentoDeGrupos("s1", false)).resolves.toBe(true);
    expect(putsRecebidos).toHaveLength(0);
  });

  it("devolve false quando o WAHA responde 200 mas o GET não reflete a troca", async () => {
    ignorarProximoPut = true;
    await expect(cliente().definirRecebimentoDeGrupos("s1", true)).resolves.toBe(false);
    // o PUT foi de fato tentado — o caso mede "200 sem efeito", não "PUT nunca aconteceu"
    expect(putsRecebidos).toHaveLength(1);
  });

  it("sessão com groups=false continua compatível e a convergência NÃO a reverte", async () => {
    sessao.config.ignore.groups = false;
    await cliente().convergirConfigDaSessao("s1");
    expect(putsRecebidos).toHaveLength(0);
  });

  it("a convergência ainda corrige as outras chaves e preserva groups", async () => {
    sessao.config.ignore = { status: false, broadcast: true, channels: true, groups: false };
    await cliente().convergirConfigDaSessao("s1");
    expect((putsRecebidos[0] as { config: { ignore: Record<string, boolean> } }).config.ignore).toEqual({
      status: true,
      broadcast: true,
      channels: true,
      groups: false,
    });
  });
});
