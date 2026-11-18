/**
 * O limite das portas do OAuth do MCP nunca vira "sem limite": com IP, conta
 * por IP; sem IP, cai num balde comum (ver o cabeçalho de `limites.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ cabecalhos: new Headers(), contagens: new Map<string, number>() }));

vi.mock("next/headers", () => ({ headers: async () => h.cabecalhos }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: async (balde: string, limite: number) => {
    const n = (h.contagens.get(balde) ?? 0) + 1;
    h.contagens.set(balde, n);
    return { allowed: n <= limite };
  },
  peekRateLimit: async () => 0,
}));

import { LIMITES_OAUTH_MCP, oauthMcpLimitado } from "./limites";

async function tentativasAteBarrar(maximo: number): Promise<number> {
  for (let i = 1; i <= maximo; i += 1) {
    if (await oauthMcpLimitado("registro")) return i;
  }
  return -1;
}

beforeEach(() => {
  h.contagens.clear();
  h.cabecalhos = new Headers();
});

describe("oauthMcpLimitado", () => {
  const teto = LIMITES_OAUTH_MCP.registro.ip;

  it("com IP: barra a tentativa seguinte ao teto daquele IP", async () => {
    h.cabecalhos = new Headers({ "x-forwarded-for": "203.0.113.7" });
    expect(await tentativasAteBarrar(teto + 5)).toBe(teto + 1);
    // Outro IP tem o próprio balde.
    h.cabecalhos = new Headers({ "x-forwarded-for": "203.0.113.8" });
    expect(await oauthMcpLimitado("registro")).toBe(false);
  });

  it("sem IP: o limite continua valendo, num balde comum", async () => {
    expect(await tentativasAteBarrar(teto + 5)).toBe(teto + 1);
  });
});
