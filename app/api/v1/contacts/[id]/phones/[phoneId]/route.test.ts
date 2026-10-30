/**
 * PATCH e DELETE /api/v1/contacts/[id]/phones/[phoneId] (Spec 31, B2).
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Tirar `.eq("contact_id", …)` das consultas de extra: o caso "extra de outra
 *   ficha → 404" cai (o id existiria, mas não nesta ficha).
 * - Tirar `.eq("organization_id", …)` do DELETE: o caso de filtro de organização cai.
 * - Trocar `telefoneExtraPatchSchema` por um schema sem o `refine`: o caso
 *   "corpo vazio → 422" cai.
 * - Auditar `contact.extra_phone_updated` no DELETE, ou não auditar o DELETE: o
 *   caso "DELETE audita contact.extra_phone_removed" cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

const { chamadas } = vi.hoisted(() => ({
  chamadas: [] as Array<{ tabela: string; op: string; filtros: Array<[string, unknown]>; valores?: unknown }>,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: () => Promise.resolve({ error: null }) }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const EXTRA = "55555555-5555-4555-8555-555555555555";

type Resultado = { data?: unknown; error?: { code?: string; message: string } | null };

/** Fake do cliente de sessão: resposta por `tabela.op`, e cada chamada fica registrada. */
function fakeSupabase(resultados: Record<string, Resultado>) {
  return {
    from: (tabela: string) => {
      const chamada = { tabela, op: "select", filtros: [] as Array<[string, unknown]>, valores: undefined as unknown };
      chamadas.push(chamada);
      const resolver = () => resultados[`${tabela}.${chamada.op}`] ?? resultados[tabela] ?? { data: null, error: null };
      const q: Record<string, unknown> = {
        select: () => q,
        update: (v: unknown) => {
          chamada.op = "update";
          chamada.valores = v;
          return q;
        },
        delete: () => {
          chamada.op = "delete";
          return q;
        },
        eq: (coluna: string, valor: unknown) => {
          chamada.filtros.push([coluna, valor]);
          return q;
        },
        is: (coluna: string, valor: unknown) => {
          chamada.filtros.push([coluna, valor]);
          return q;
        },
        limit: () => q,
        single: async () => resolver(),
        maybeSingle: async () => resolver(),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve(resolver()).then(ok, ko),
      };
      return q;
    },
  };
}

const CONTEXTO = { params: Promise.resolve({ id: CONTATO, phoneId: EXTRA }) };
const FICHA = { id: CONTATO, phone_number: "+5511999998888" };
const EXTRA_DO_BANCO = {
  id: EXTRA,
  phone_number: "+5511988887777",
  tipo: "celular",
  whatsapp: "sim",
  rotulo: "Trabalho",
  origem: "manual",
  created_at: "2026-10-29T10:00:00.000Z",
};

function reqComCorpo(metodo: "PATCH", corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/phones/${EXTRA}`, {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  chamadas.length = 0;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("PATCH /api/v1/contacts/[id]/phones/[phoneId]", () => {
  it("corpo vazio → 422, e nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({ "contacts.select": { data: FICHA } }) as never);
    const { PATCH } = await import("./route");

    const res = await PATCH(reqComCorpo("PATCH", {}), CONTEXTO);

    expect(res.status).toBe(422);
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("extra de OUTRA ficha → 404 (a consulta do extra filtra pela ficha da URL)", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA },
        "contact_phones.update": { data: null, error: null },
      }) as never,
    );
    const { PATCH } = await import("./route");

    const res = await PATCH(reqComCorpo("PATCH", { type: "fixo" }), CONTEXTO);

    expect(res.status).toBe(404);
    const update = chamadas.find((c) => c.tabela === "contact_phones" && c.op === "update");
    expect(update?.filtros).toContainEqual(["contact_id", CONTATO]);
    expect(update?.filtros).toContainEqual(["organization_id", ORG]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("grava tipo/WhatsApp/rótulo e audita contact.extra_phone_updated, sem wa_lid na resposta", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA },
        "contact_phones.update": { data: { ...EXTRA_DO_BANCO, tipo: "fixo" }, error: null },
      }) as never,
    );
    const { PATCH } = await import("./route");

    const res = await PATCH(reqComCorpo("PATCH", { type: "fixo", label: null }), CONTEXTO);
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(corpo.data.type).toBe("fixo");
    expect(JSON.stringify(corpo)).not.toContain("wa_lid");
    const update = chamadas.find((c) => c.tabela === "contact_phones" && c.op === "update");
    expect(update?.valores).toMatchObject({ tipo: "fixo", rotulo: null });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.extra_phone_updated" }),
    );
  });
});

describe("DELETE /api/v1/contacts/[id]/phones/[phoneId]", () => {
  it("remove o extra filtrando organização e ficha, audita contact.extra_phone_removed e devolve 204", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA },
        "contact_phones.delete": { data: { id: EXTRA }, error: null },
      }) as never,
    );
    const { DELETE } = await import("./route");

    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), CONTEXTO);

    expect(res.status).toBe(204);
    const apagar = chamadas.find((c) => c.tabela === "contact_phones" && c.op === "delete");
    expect(apagar?.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["contact_id", CONTATO],
        ["id", EXTRA],
      ]),
    );
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.extra_phone_removed", resourceId: CONTATO }),
    );
  });

  it("extra que não é desta ficha → 404 e sem audit", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA },
        "contact_phones.delete": { data: null, error: null },
      }) as never,
    );
    const { DELETE } = await import("./route");

    const res = await DELETE(new NextRequest("http://localhost/x", { method: "DELETE" }), CONTEXTO);

    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
