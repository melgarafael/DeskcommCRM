import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ipDoCliente, ipDoClienteParaInet } from "@/lib/http/ip-do-cliente";

const PRIMEIRO_SALTO = "6.6.6.6";
const REAL = "203.0.113.7";

/** O que chega ao app atrás do túnel: a borda ACRESCENTA ao XFF do cliente. */
const atrasDoTunel = (cf: string | null) =>
  new Headers({
    "x-forwarded-for": `${PRIMEIRO_SALTO}, ${REAL}`,
    ...(cf === null ? {} : { "cf-connecting-ip": cf }),
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ipDoCliente — topologia declarada pela borda", () => {
  it("com IP_DO_CLIENTE_HEADER, devolve o endereço que a borda escreveu, não o 1º salto do x-forwarded-for", () => {
    vi.stubEnv("IP_DO_CLIENTE_HEADER", "cf-connecting-ip");
    expect(ipDoCliente(atrasDoTunel(REAL))).toBe(REAL);
    expect(ipDoClienteParaInet(atrasDoTunel(REAL))).toBe(REAL);
  });

  it("com a variável, cabeçalho ausente ou que não é IP cai na régua de sempre", () => {
    vi.stubEnv("IP_DO_CLIENTE_HEADER", "cf-connecting-ip");
    expect(ipDoCliente(atrasDoTunel(null))).toBe(PRIMEIRO_SALTO);
    expect(ipDoCliente(atrasDoTunel("nao-e-ip"))).toBe(PRIMEIRO_SALTO);
    expect(ipDoCliente(atrasDoTunel(`${REAL}, 1.1.1.1`))).toBe(PRIMEIRO_SALTO);
  });

  it("sem a variável, o cf-connecting-ip é ignorado — no modo Caddy quem o escreve é o cliente", () => {
    vi.stubEnv("IP_DO_CLIENTE_HEADER", "");
    expect(ipDoCliente(atrasDoTunel(REAL))).toBe(PRIMEIRO_SALTO);
    expect(ipDoCliente(new Headers({ "cf-connecting-ip": REAL }))).toBeNull();
  });

  it("sem a variável, a régua de hoje: 1º salto do XFF, depois x-real-ip, depois null", () => {
    vi.stubEnv("IP_DO_CLIENTE_HEADER", "");
    expect(ipDoCliente(new Headers({ "x-forwarded-for": ` ${REAL} , 10.0.0.1` }))).toBe(REAL);
    expect(ipDoCliente(new Headers({ "x-real-ip": REAL }))).toBe(REAL);
    expect(ipDoCliente(new Headers())).toBeNull();
  });
});

describe("cerca — uma régua só para o IP de quem acessa", () => {
  it("ninguém lê x-forwarded-for por conta própria fora de lib/http/ip-do-cliente.ts", () => {
    // Leitura inline ignora a topologia declarada (IP_DO_CLIENTE_HEADER) e,
    // atrás do túnel, registra o 1º salto do x-forwarded-for, que atrás do túnel não é o endereço de quem acessa.
    const arquivos = execFileSync("git", ["ls-files", "app", "lib", "workers", "components", "hooks"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => f !== "lib/http/ip-do-cliente.ts");
    const leitura = /\.get\(\s*["'`]x-forwarded-for["'`]\s*\)/i;
    const infratores = arquivos.filter((f) => leitura.test(readFileSync(f, "utf8")));
    expect(arquivos.length, "a varredura não achou arquivo nenhum").toBeGreaterThan(100);
    expect(infratores, "use ipDoCliente(headers) de @/lib/http/ip-do-cliente").toEqual([]);
  });
});
