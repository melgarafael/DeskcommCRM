/**
 * Código de recuperação, ida e volta: o que `regenerateRecoveryCodes` grava é o
 * que `useRecoveryCode` encontra quando a pessoa digita o código.
 *
 * O defeito que este arquivo vigia não está em nenhuma das duas ações sozinha:
 * está no caminho entre elas. A gravação manda o hash no corpo JSON do insert e
 * a busca manda o hash na URL do filtro — e cada uma serializa o valor do seu
 * jeito. Por isso o client aqui é o `@supabase/supabase-js` de verdade (é ele
 * quem serializa) e só a resposta do servidor é dublê: um PostgREST mínimo que
 * converte o valor recebido para `bytea` pela regra de entrada do Postgres
 * (`\x` + hex, ou formato escape) e compara BYTES, como o banco compara.
 */
import { createHash, createHmac } from "node:crypto";

import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";

type Linha = { id: string; user_id: string; code_hash: Buffer; used_at: string | null };

const banco = vi.hoisted(() => ({ linhas: [] as Linha[], proximoId: 1 }));

/** Entrada de `bytea` do Postgres: `\x` + hex, senão formato escape. */
function byteaIn(valor: unknown): Buffer {
  // Um objeto no JSON vira o texto do próprio JSON na coluna (medido na VPS).
  const texto = typeof valor === "string" ? valor : JSON.stringify(valor);
  if (texto.startsWith("\\x")) {
    const hex = texto.slice(2);
    if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error("22P02 invalid hexadecimal");
    return Buffer.from(hex, "hex");
  }
  const partes: Buffer[] = [];
  for (let i = 0; i < texto.length; ) {
    if (texto[i] !== "\\") {
      const cp = texto.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      partes.push(Buffer.from(ch, "utf8"));
      i += ch.length;
    } else if (texto[i + 1] === "\\") {
      partes.push(Buffer.from([0x5c]));
      i += 2;
    } else if (/^[0-3][0-7]{2}$/.test(texto.slice(i + 1, i + 4))) {
      partes.push(Buffer.from([parseInt(texto.slice(i + 1, i + 4), 8)]));
      i += 4;
    } else {
      throw new Error("22P02 invalid input syntax for type bytea");
    }
  }
  return Buffer.concat(partes);
}

/** PostgREST mínimo para `user_recovery_codes`: insert, select filtrado, update, delete. */
async function postgrest(entrada: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(entrada));
  const metodo = (init?.method ?? "GET").toUpperCase();
  // Outras tabelas (ex.: a limpeza de dispositivos confiáveis) não mexem nos códigos.
  if (!url.pathname.endsWith("/user_recovery_codes")) return new Response(null, { status: 204 });
  const filtros = [...url.searchParams.entries()].filter(([k]) => !["select", "limit"].includes(k));
  const casa = (l: Linha) =>
    filtros.every(([col, f]) => {
      if (f === "is.null") return l[col as keyof Linha] === null;
      const v = f.replace(/^eq\./, "");
      if (col === "code_hash") return byteaIn(v).equals(l.code_hash);
      return String(l[col as keyof Linha]) === v;
    });
  try {
    if (metodo === "POST") {
      const corpo = JSON.parse(String(init?.body)) as Array<{ user_id: string; code_hash: unknown }>;
      for (const r of [corpo].flat()) {
        banco.linhas.push({ id: `rc-${banco.proximoId++}`, user_id: r.user_id, code_hash: byteaIn(r.code_hash), used_at: null });
      }
      return new Response(null, { status: 201 });
    }
    if (metodo === "DELETE") {
      banco.linhas = banco.linhas.filter((l) => !casa(l));
      return new Response(null, { status: 204 });
    }
    if (metodo === "PATCH") {
      const mudanca = JSON.parse(String(init?.body)) as { used_at: string };
      for (const l of banco.linhas.filter(casa)) l.used_at = mudanca.used_at;
      return new Response(null, { status: 204 });
    }
    const achadas = banco.linhas.filter(casa).map((l) => ({ id: l.id, used_at: l.used_at }));
    return new Response(JSON.stringify(achadas), { status: 200, headers: { "content-type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ code: "22P02", message: (err as Error).message }), { status: 400 });
  }
}

const cliente = createSupabaseJs("http://banco.teste", "chave-de-servico", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: postgrest as typeof fetch },
});

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => ({ get: () => null })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/auth/server", () => ({ sessionAal: async () => "aal2" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (t: string) => cliente.from(t),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [{ id: "eu", email: "eu@exemplo.com" }] }, error: null }),
        mfa: { listFactors: async () => ({ data: { factors: [] }, error: null }), deleteFactor: async () => ({ error: null }) },
      },
    },
  }),
}));

import { regenerateRecoveryCodes } from "@/app/actions/settings/regenerateRecoveryCodes";
import { useRecoveryCode as consumirCodigo } from "@/app/actions/auth/useRecoveryCode";

const usar = (code: string) => consumirCodigo({ email: "eu@exemplo.com", code });
const entrou = () => vi.mocked(redirect).mock.calls.some(([u]) => String(u).startsWith("/login?recovery_used=1"));

async function emitir(): Promise<string[]> {
  const r = await regenerateRecoveryCodes();
  if (!r.ok) throw new Error(`regenerar recusou: ${r.error}`);
  return r.recovery_codes;
}

beforeEach(() => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-da-instalacao");
  banco.linhas = [];
  vi.mocked(redirect).mockClear();
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: "eu" } }, error: null }),
      mfa: { listFactors: async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null }) },
    },
  } as never);
});

describe("código de recuperação: gerar e usar", () => {
  it.each([
    ["como foi mostrado", (c: string) => c],
    ["em minúsculas", (c: string) => c.toLowerCase()],
    ["com hífen no meio", (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`],
    ["com espaços", (c: string) => ` ${c.slice(0, 4)} ${c.slice(4)} `],
  ])("o código digitado %s entra uma vez, e a segunda vez é recusada", async (_nome, digitar) => {
    const codigos = await emitir();
    expect(banco.linhas).toHaveLength(10);

    expect(await usar(digitar(codigos[3]!))).toBeUndefined();
    expect(entrou()).toBe(true);
    expect(banco.linhas.filter((l) => l.used_at !== null)).toHaveLength(1);

    vi.mocked(redirect).mockClear();
    expect(await usar(digitar(codigos[3]!))).toEqual({ ok: false, error: "invalid_or_used" });
    expect(entrou()).toBe(false);
  });

  it("um código que não foi emitido é recusado", async () => {
    const codigos = await emitir();
    const inventado = codigos[0] === "ABCDEFGH" ? "HGFEDCBA" : "ABCDEFGH";
    expect(await usar(inventado)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(entrou()).toBe(false);
    expect(banco.linhas.every((l) => l.used_at === null)).toBe(true);
  });

  // Linhas gravadas antes desta versão — o texto JSON do Buffer, que era o que
  // a gravação produzia, ou qualquer digest calculável sem o segredo da
  // instalação — não passam a valer.
  it.each([
    ["o texto JSON do Buffer (o que a versão anterior gravava)", (c: string) => Buffer.from(JSON.stringify(createHash("sha256").update(c).digest()), "utf8")],
    ["o sha256 cru do código", (c: string) => createHash("sha256").update(c).digest()],
    ["o sha256 com o prefixo, sem o segredo", (c: string) => createHash("sha256").update(`recovery-code:v2:${c}`).digest()],
    ["o HMAC com outro segredo", (c: string) => createHmac("sha256", "outro-segredo").update(`recovery-code:v2:${c}`).digest()],
  ])("código gravado na forma antiga — %s — continua recusado", async (_nome, formaAntiga) => {
    const codigo = "KQ7MXP3T";
    banco.linhas.push({ id: "antiga", user_id: "eu", code_hash: formaAntiga(codigo), used_at: null });
    expect(await usar(codigo)).toEqual({ ok: false, error: "invalid_or_used" });
    expect(entrou()).toBe(false);
    expect(banco.linhas[0]!.used_at).toBeNull();
  });

  it("sem o segredo da instalação, regenerar recusa sem gravar nada", async () => {
    vi.stubEnv("INTERNAL_SECRET", "");
    await expect(regenerateRecoveryCodes()).rejects.toThrow(/INTERNAL_SECRET/);
    expect(banco.linhas).toHaveLength(0);
  });
});
