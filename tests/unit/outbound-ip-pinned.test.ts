import { describe, expect, it, vi } from "vitest";

import { lookupFixo, resolverDestinosPublicos } from "@/lib/automation/outbound-ip";

describe("destinos HTTP públicos presos ao DNS validado", () => {
  it("devolve os endereços públicos resolvidos para reutilizá-los no socket", async () => {
    const addresses = [{ address: "93.184.216.34", family: 4 as const }];
    const resolve = vi.fn().mockResolvedValue(addresses);
    await expect(resolverDestinosPublicos("example.com", resolve)).resolves.toEqual(addresses);
    expect(resolve).toHaveBeenCalledWith("example.com", { all: true, verbatim: true });
  });

  it("recusa uma resposta privada ou mista antes de conectar", async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);
    await expect(resolverDestinosPublicos("example.com", resolve)).rejects.toThrow("unsafe_url:private_ip");
  });

  it("falha fechada quando o DNS não responde", async () => {
    const resolve = vi.fn().mockRejectedValue(new Error("temporary resolver failure"));
    await expect(resolverDestinosPublicos("example.com", resolve)).rejects.toThrow("unsafe_url:dns_failed");
  });

  it("falha fechada se o resolvedor não retornar endereços", async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    await expect(resolverDestinosPublicos("example.com", resolve)).rejects.toThrow("unsafe_url:dns_empty");
  });

  it("o lookup do socket devolve somente o IP já validado e recusa hostname diferente", async () => {
    const addresses = [{ address: "93.184.216.34", family: 4 as const }];
    const lookup = lookupFixo("example.com", addresses);
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("example.com", { all: false } as never, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(resolved).toEqual(addresses[0]);
    await expect(new Promise((resolve, reject) => {
      lookup("other.example", { all: false } as never, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    })).rejects.toThrow("Destino DNS não validado.");
  });
});
