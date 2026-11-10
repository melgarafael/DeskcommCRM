/**
 * `resolvePhoneForLid` com `falhaLanca`: quem decide algo de segurança pela
 * resposta separa "o canal não sabe" (`null`) de "não consegui perguntar"
 * (lança). Sem a opção, o contrato antigo: tudo vira `null`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WahaClient } from "@/lib/waha/client";

let server: Server;
let base = "";
let status = 200;
let corpo = "{}";

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(corpo);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const comLanca = { falhaLanca: true };

describe("resolvePhoneForLid", () => {
  it("telefone conhecido volta igual com ou sem a opção", async () => {
    status = 200;
    corpo = JSON.stringify({ pn: "5511900000009@c.us" });
    const c = new WahaClient(base, "k");
    expect(await c.resolvePhoneForLid("s", "111", comLanca)).toBe("+5511900000009");
    expect(await c.resolvePhoneForLid("s", "111")).toBe("+5511900000009");
  });

  it("o canal não sabe (pn vazio, 4xx): null mesmo com a opção", async () => {
    const c = new WahaClient(base, "k");
    status = 200;
    corpo = JSON.stringify({ pn: null });
    expect(await c.resolvePhoneForLid("s", "111", comLanca)).toBeNull();
    status = 404;
    corpo = "{}";
    expect(await c.resolvePhoneForLid("s", "111", comLanca)).toBeNull();
  });

  it("5xx e canal fora do ar lançam com a opção e viram null sem ela", async () => {
    status = 502;
    corpo = "{}";
    const c = new WahaClient(base, "k");
    await expect(c.resolvePhoneForLid("s", "111", comLanca)).rejects.toThrow("waha_lid_502");
    expect(await c.resolvePhoneForLid("s", "111")).toBeNull();
    const fora = new WahaClient("http://127.0.0.1:1", "k");
    await expect(fora.resolvePhoneForLid("s", "111", comLanca)).rejects.toThrow();
    expect(await fora.resolvePhoneForLid("s", "111")).toBeNull();
  });
});
