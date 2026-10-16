// @vitest-environment node
/**
 * A agenda do aparelho no cliente do WAHA (`GET /api/contacts/all`) — #2736.
 *
 * O servidor falso abaixo mede as coisas que o contrato ESCREVE e que só a
 * chamada real cobre: os parâmetros da paginação (inclusive a ordenação fixa
 * que impede o offset de pular/repetir), o cabeçalho de auth, e o formato
 * tolerante da lista — o doc do WAHA mostra `pushname` minúsculo, mas builds
 * antigos devolvem `pushName`, e perder o nome inteiro por causa da caixa seria
 * um defeito que nenhum teste de unidade veria.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { WahaClient } from "./client";

let server: Server;
let base = "";
/** Resposta da próxima chamada — objeto ou status de erro. */
let resposta: { status: number; corpo: unknown };
/** As URLs recebidas, na ordem, para conferir a paginação. */
let urls: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    urls.push(req.url ?? "");
    res.statusCode = resposta.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(resposta.corpo));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  urls = [];
  resposta = { status: 200, corpo: [] };
});
afterEach(() => {
  resposta = { status: 200, corpo: [] };
});

const cliente = () => new WahaClient(base, "chave-teste");

/** O formato do doc do WAHA ("Get all contacts"), com os extras que ele traz. */
function contato(overrides: Record<string, unknown> = {}) {
  return {
    id: "5511999990001@c.us",
    number: "5511999990001",
    name: "Maria da Agenda",
    pushname: "maria.perfil",
    shortName: "Maria",
    isMe: false,
    isGroup: false,
    isWAContact: true,
    isMyContact: true,
    isBlocked: false,
    ...overrides,
  };
}

describe("listarAgendaDoAparelho", () => {
  it("monta a URL com sessão, paginação e ordenação FIXA por id", async () => {
    resposta = { status: 200, corpo: [contato()] };
    const page = await cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 200 });
    expect(page).toHaveLength(1);
    const url = new URL(urls[0]!, "http://x");
    expect(url.pathname).toBe("/api/contacts/all");
    expect(url.searchParams.get("session")).toBe("s1");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("200");
    // Sem ordenação estável o offset salta ou repete contato entre chamadas —
    // é a parte da paginação que não dá para deixar ao acaso do WAHA.
    expect(url.searchParams.get("sortBy")).toBe("id");
    expect(url.searchParams.get("sortOrder")).toBe("asc");
  });

  it("normaliza os campos e aceita as duas grafias de pushname", async () => {
    resposta = {
      status: 200,
      corpo: [
        contato({ name: "  Maria  ", pushname: "  maria.perfil  " }),
        // Build antigo: `pushName` camelCase. Mesma pessoa, outra caixa.
        contato({ id: "5511999990002@c.us", name: null, pushname: undefined, pushName: "jose.perfil" }),
        // Sem nome nenhum: dois null, não string vazia colada na tela.
        contato({ id: "5511999990003@c.us", name: null, pushname: undefined }),
      ],
    };
    const page = await cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 });
    expect(page.map((c) => ({ name: c.name, pushname: c.pushname }))).toEqual([
      { name: "Maria", pushname: "maria.perfil" },
      { name: null, pushname: "jose.perfil" },
      { name: null, pushname: null },
    ]);
  });

  it("marca os marcadores como null quando o WAHA não os traz (nunca como false)", async () => {
    resposta = { status: 200, corpo: [{ id: "5511999990004@c.us" }] };
    const [c] = await cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 });
    // "Não sei" não pode virar "não é": quem chama filtra por `=== true` e por
    // `=== false`, e um false inventado descartaria ou importaria errado.
    expect(c).toEqual({
      id: "5511999990004@c.us",
      name: null,
      pushname: null,
      isMyContact: null,
      isWAContact: null,
      isMe: null,
    });
  });

  it("pula entradas malformadas sem derrubar a página inteira", async () => {
    resposta = { status: 200, corpo: [null, "lixo", { nome: "sem id" }, contato()] };
    const page = await cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 });
    expect(page.map((c) => c.id)).toEqual(["5511999990001@c.us"]);
  });

  it("resposta que não é lista devolve vazio (não lança)", async () => {
    resposta = { status: 200, corpo: { message: "Session not started" } };
    await expect(cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 })).resolves.toEqual([]);
  });

  it("HTTP de erro vira exceção com o status no nome — nunca com o corpo", async () => {
    resposta = { status: 503, corpo: { message: "segredo do provedor" } };
    await expect(cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 })).rejects.toThrow(
      "waha_contacts_all_503",
    );
    // O corpo do terceiro não pode atravessar — mesma doutrina do resto do client.
    await expect(
      cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 }).catch((e: Error) => e.message),
    ).resolves.not.toContain("segredo");
  });

  it("anda página a página sem repetir o offset", async () => {
    resposta = { status: 200, corpo: [contato()] };
    await cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 0 });
    resposta = { status: 200, corpo: [contato({ id: "5511999990100@c.us" })] };
    await cliente().listarAgendaDoAparelho("s1", { limit: 100, offset: 100 });
    const offsets = urls.map((u) => new URL(u, "http://x").searchParams.get("offset"));
    expect(offsets).toEqual(["0", "100"]);
  });
});
