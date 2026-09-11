import { describe, expect, it } from "vitest";

import { ipDeBancoProibido, validarHostDeBanco } from "./guardas";

describe("ipDeBancoProibido", () => {
  it.each([
    "169.254.169.254", // metadata de nuvem
    "127.0.0.1",
    "127.10.20.30",
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "192.0.2.10", // TEST-NET
    "198.18.0.5", // benchmark
    "203.0.113.9", // TEST-NET
    "224.0.0.1", // multicast
    "240.0.0.1", // reservada
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // IPv4-mapeado em hex — MESMO loopback que 127.0.0.1
    "::127.0.0.1", // IPv4-compatível (legado)
    "0:0:0:0:0:0:0:1", // loopback expandido
    "0000:0000:0000:0000:0000:0000:0000:0001", // loopback expandido
    "0:0:0:0:0:0:0:0", // :: expandido
    "64:ff9b::192.168.1.1", // NAT64 apontando para LAN
  ])("bloqueia %s", (ip) => {
    expect(ipDeBancoProibido(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "10.1.2.3", // RFC1918 — LAN é caso legítimo do self-host
    "172.16.5.5",
    "192.168.0.10",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8", // IPv4-mapeado público não é bloqueado por tabela
  ])("permite %s", (ip) => {
    expect(ipDeBancoProibido(ip)).toBe(false);
  });

  it("recusa o que não se sabe julgar", () => {
    expect(ipDeBancoProibido("nao-e-ip")).toBe(true);
    expect(ipDeBancoProibido("999.1.1.1")).toBe(true);
  });
});

describe("validarHostDeBanco", () => {
  it("recusa host vazio, com barra ou com espaço", async () => {
    await expect(validarHostDeBanco("")).resolves.toEqual({ ok: false, motivo: "host_invalido" });
    await expect(validarHostDeBanco("db.local/path")).resolves.toEqual({
      ok: false,
      motivo: "host_invalido",
    });
    await expect(validarHostDeBanco("db local")).resolves.toEqual({
      ok: false,
      motivo: "host_invalido",
    });
  });

  it("recusa literal de IP proibido", async () => {
    await expect(validarHostDeBanco("169.254.169.254")).resolves.toEqual({
      ok: false,
      motivo: "ip_especial",
    });
  });

  it("aceita literal de IP público e IP de LAN", async () => {
    await expect(validarHostDeBanco("8.8.8.8")).resolves.toEqual({ ok: true, enderecos: ["8.8.8.8"] });
    await expect(validarHostDeBanco("10.0.0.7")).resolves.toEqual({ ok: true, enderecos: ["10.0.0.7"] });
  });

  it("aceita IPv6 literal entre colchetes", async () => {
    await expect(validarHostDeBanco("[2606:4700::1111]")).resolves.toEqual({
      ok: true,
      enderecos: ["2606:4700::1111"],
    });
  });

  it("resolve hostname e recusa quando cai em IP proibido (localhost)", async () => {
    const r = await validarHostDeBanco("localhost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("ip_especial");
  });

  it("falha fechado quando o DNS não resolve", async () => {
    // `.invalid` é reservado por RFC 2606 e nunca resolve — sem rede no teste.
    await expect(validarHostDeBanco("db.invalid")).resolves.toEqual({
      ok: false,
      motivo: "dns_falhou",
    });
  });
});
