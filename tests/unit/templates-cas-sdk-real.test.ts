// @vitest-environment node
/** Rotas reais + SDK instalado; somente o transporte HTTP/Storage é sintético. */
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as unknown,
  linha: {} as Record<string, unknown>,
  chamadas: [] as { metodo: string; snapshot: string | null; timestamp: string | null }[],
  concorrer: false,
  perderConfirmacao: false as false | "rejeicao" | "sem_corpo",
  objetos: new Map<string, Uint8Array>(),
  upload: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => ({
  ok: true, user: { id: "55555555-5555-4555-8555-555555555555", idioma: "pt" },
  org: { orgId: "11111111-1111-4111-8111-111111111111", role: "manager" },
}) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  storage: { from: () => ({ upload: h.upload, remove: h.remove }) },
}) }));

import { PATCH } from "@/app/api/v1/message-templates/[id]/route";
import { POST } from "@/app/api/v1/message-templates/[id]/midias/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const TPL = "22222222-2222-4222-8222-222222222222";
const original = {
  storage_path: `${ORG}/templates/${TPL}/33333333-3333-4333-8333-333333333333.jpg`,
  media_mime: "image/jpeg", media_size_bytes: 42,
  // Metadado do snapshot, nunca caminho do upload. O JSONB aceita campos extras.
  nome_original: 'Áudio "apresentação" + 10% \\ reserva.jpg',
};
const instanteBruto = "2026-10-27T11:00:00.123456+00:00";
const params = { params: Promise.resolve({ id: TPL }) };
const resposta = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json",
    "Content-Range": Array.isArray(data) && data.length === 0 ? "*/0" : "0-0/1" },
});

function cliente() {
  return createClient("http://127.0.0.1:54321", "chave-sintetica", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      expect(url.pathname).toBe("/rest/v1/message_templates");
      expect(url.searchParams.get("id")).toBe(`eq.${TPL}`);
      h.chamadas.push({ metodo: req.method, snapshot: url.searchParams.get("midias"),
        timestamp: url.searchParams.get("updated_at") });
      if (req.method === "PATCH") {
        if (h.concorrer) { h.linha.midias = []; h.concorrer = false; }
        const filtro = url.searchParams.get("midias");
        let esperado: unknown;
        try { esperado = JSON.parse((filtro ?? "").slice(3)) as unknown; }
        catch { return resposta({ code: "22P02", message: "snapshot inválido" }, 400); }
        if (!isDeepStrictEqual(h.linha.midias, esperado)) return resposta([]);
        Object.assign(h.linha, await req.json());
        if (h.perderConfirmacao === "rejeicao") throw new TypeError("confirmação perdida após commit");
        if (h.perderConfirmacao === "sem_corpo") return new Response(null, { status: 204 });
      }
      // maybeSingle2.118 recebe lista e confere a cardinalidade no cliente.
      return resposta([h.linha]);
    } },
  });
}

function upload(snapshot: unknown) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], "Áudio +10%.ogg", { type: "audio/ogg" }));
  form.append("midias_esperadas", JSON.stringify(snapshot));
  return POST(new NextRequest(`http://localhost/api/v1/message-templates/${TPL}/midias`, {
    method: "POST", body: form,
  }), params);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.linha = { id: TPL, organization_id: ORG, owner_user_id: "55555555-5555-4555-8555-555555555555",
    midias: [{ ...original }], updated_at: instanteBruto };
  h.chamadas = [];
  h.concorrer = false;
  h.perderConfirmacao = false;
  h.objetos.clear();
  h.upload.mockImplementation(async (caminho: string, bytes: Uint8Array) => {
    h.objetos.set(caminho, new Uint8Array(bytes));
    return { error: null };
  });
  h.remove.mockImplementation(async (caminhos: string[]) => {
    caminhos.forEach((caminho) => h.objetos.delete(caminho));
    return { error: null };
  });
  h.client = cliente();
});

describe("snapshot JSONB no transporte real do SDK", () => {
  it("PATCH conserva caracteres e campos extras e transmite JSON explícito", async () => {
    const esperado = h.linha.midias;
    const r = await PATCH(new NextRequest(`http://localhost/api/v1/message-templates/${TPL}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Título novo", midias: [original], midias_esperadas: esperado }),
    }), params);
    expect(r.status).toBe(200);
    expect(h.chamadas[1]!.snapshot).toBe(`eq.${JSON.stringify(esperado)}`);
    expect(h.linha.midias).toEqual([original]);
  });

  it("POST usa o mesmo filtro, conserva o snapshot anterior e gera caminho próprio", async () => {
    const esperado = h.linha.midias;
    const r = await upload(esperado);
    expect(r.status).toBe(200);
    expect(h.chamadas[1]!.snapshot).toBe(`eq.${JSON.stringify(esperado)}`);
    expect((h.linha.midias as unknown[])[0]).toEqual(original);
    expect(h.upload.mock.calls[0]![0]).not.toContain("Áudio");
  });

  it("snapshot[] funciona; null é recusado antes do upload", async () => {
    h.linha.midias = [];
    expect((await upload(null)).status).toBe(422);
    expect(h.upload).not.toHaveBeenCalled();
    expect((await upload([])).status).toBe(200);
    expect(h.chamadas.at(-1)!.snapshot).toBe("eq.[]");
  });

  it("zero linhas no CAS vira409 e limpa somente o arquivo novo", async () => {
    h.concorrer = true;
    const r = await upload(h.linha.midias);
    expect(r.status).toBe(409);
    expect(h.linha.midias).toEqual([]);
    expect(h.remove).toHaveBeenCalledExactlyOnceWith([h.upload.mock.calls[0]![0]]);
  });

  it("controle negativo: o SDK não converte objeto implícito em JSONB", async () => {
    const r = await cliente().from("message_templates").update({ title: "Não deve gravar" })
      .eq("id", TPL).eq("midias", h.linha.midias as never).select("id").maybeSingle();
    expect(r.error).not.toBeNull();
    expect(h.chamadas[0]!.snapshot).toBe("eq.[object Object]");
    expect(h.linha.title).toBeUndefined();
  });

  it.each(["rejeicao", "sem_corpo"] as const)("confirmação perdida após commit (%s) conserva o objeto referenciado", async (modo) => {
    h.perderConfirmacao = modo;
    const r = await upload(h.linha.midias);
    expect(r.status).toBe(500);
    expect(h.chamadas.filter((c) => c.metodo === "PATCH")).toHaveLength(1);
    const novo = (h.linha.midias as Array<{ storage_path: string }>).at(-1)!;
    expect(h.objetos.get(novo.storage_path)).toEqual(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("timestamp com microssegundos permanece string bruta", async () => {
    const r = await cliente().from("message_templates").select("updated_at")
      .eq("id", TPL).eq("updated_at", instanteBruto).maybeSingle();
    expect(r.error).toBeNull();
    expect(h.chamadas[0]!.timestamp).toBe(`eq.${instanteBruto}`);
    expect(r.data?.updated_at).toBe(instanteBruto);
  });
});
