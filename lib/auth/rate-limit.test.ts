/**
 * Issue #64 — o teto existe e conta as duas coisas.
 *
 * Sem Upstash configurado o `checkRateLimit` cai para o contador em memória do
 * processo, que é exatamente o que este teste quer exercitar: o caminho real,
 * sem mock do limitador. O que se mocka é só o `headers()` do Next, para
 * escolher o IP de cada tentativa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

function comIp(ip: string) {
  vi.mocked(headers).mockResolvedValue({
    get: (k: string) => (k === "x-forwarded-for" ? ip : null),
  } as never);
}

describe("authRateLimited", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("barra ao estourar o teto por IP", async () => {
    const { authRateLimited } = await import("./rate-limit");
    comIp("203.0.113.10");
    const limites = { ip: 3, windowSec: 300 };

    const veredito: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      veredito.push(await authRateLimited("teste_ip", null, limites));
    }

    expect(veredito).toEqual([false, false, false, true]);
  });

  it("barra por identificador mesmo com o IP mudando a cada tentativa", async () => {
    const { authRateLimited } = await import("./rate-limit");
    const limites = { ip: 100, id: 2, windowSec: 300 };
    const alvo = "vitima@example.com";

    const veredito: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      comIp(`198.51.100.${i}`); // IP diferente a cada tentativa: o ataque distribuído
      veredito.push(await authRateLimited("teste_id", alvo, limites));
    }

    // Se só houvesse contagem por IP, os três passariam.
    expect(veredito).toEqual([false, false, true]);
  });

  it("conta identificadores diferentes em baldes separados", async () => {
    const { authRateLimited } = await import("./rate-limit");
    comIp("203.0.113.20");
    const limites = { ip: 100, id: 1, windowSec: 300 };

    expect(await authRateLimited("teste_sep", "a@example.com", limites)).toBe(false);
    expect(await authRateLimited("teste_sep", "b@example.com", limites)).toBe(false);
    expect(await authRateLimited("teste_sep", "a@example.com", limites)).toBe(true);
  });

  it("define limite próprio para recuperação de organização", async () => {
    const { AUTH_LIMITS } = await import("./rate-limit");

    expect(AUTH_LIMITS.org_recovery).toEqual({ ip: 5, id: 3, windowSec: 3600 });
  });

  it("não põe o e-mail em claro na chave do contador", async () => {
    const rl = await import("@/lib/ai/dispatcher/rate-limit");
    const spy = vi.spyOn(rl, "checkRateLimit");
    vi.resetModules();
    const { authRateLimited } = await import("./rate-limit");
    comIp("203.0.113.30");

    await authRateLimited("teste_pii", "cliente@example.com", { ip: 10, id: 10, windowSec: 300 });

    const chaves = spy.mock.calls.map((c) => c[0]).join(" ");
    expect(chaves).not.toContain("cliente@example.com");
    expect(chaves).not.toContain("203.0.113.30");
  });
});

describe("sem IP identificável — o balde global que era um DoS", () => {
  function semNenhumHeaderDeIp() {
    vi.mocked(headers).mockResolvedValue({ get: () => null } as never);
  }

  it("não barra por IP quando não há de onde tirar o IP", async () => {
    // A versão anterior jogava TODA tentativa sem header num único balde
    // (`opaque("sem-ip")`). Como o kit self-host expõe o app sem proxy, esse era o
    // caminho NORMAL: 60 requisições anônimas trancavam o login da instalação
    // inteira, e o atacante dividia o balde com as vítimas em vez de ficar isolado.
    const { authRateLimited } = await import("./rate-limit");
    semNenhumHeaderDeIp();
    const limites = { ip: 3, windowSec: 300 };

    const veredito: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      veredito.push(await authRateLimited("teste_sem_ip", null, limites));
    }

    expect(veredito).toEqual([false, false, false, false, false, false]);
  });

  it("mas o teto por CONTA continua valendo sem IP — é ele que barra força bruta", async () => {
    // O contrapeso que impede a leitura preguiçosa "sem IP não tem limite": a
    // proteção que realmente importa contra adivinhação de senha não depende de IP,
    // e é exatamente a desenhada para o ataque distribuído.
    const { authRateLimited } = await import("./rate-limit");
    semNenhumHeaderDeIp();
    const limites = { ip: 100, id: 2, windowSec: 300 };

    const veredito: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      veredito.push(await authRateLimited("teste_conta", "alvo@example.com", limites));
    }

    expect(veredito).toEqual([false, false, true]);
  });

  it("x-real-ip serve quando x-forwarded-for não vem — Nginx simples só seta esse", async () => {
    const { authRateLimited } = await import("./rate-limit");
    vi.mocked(headers).mockResolvedValue({
      get: (k: string) => (k === "x-real-ip" ? "203.0.113.77" : null),
    } as never);
    const limites = { ip: 2, windowSec: 300 };

    const veredito: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      veredito.push(await authRateLimited("teste_real_ip", null, limites));
    }

    // Barra na terceira: o IP FOI reconhecido, senão nenhuma seria barrada.
    expect(veredito).toEqual([false, false, true]);
  });
});
