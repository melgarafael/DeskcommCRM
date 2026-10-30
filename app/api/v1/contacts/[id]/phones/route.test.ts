/**
 * POST /api/v1/contacts/[id]/phones — adicionar telefone (Spec 31, B2).
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Trocar `normalizePhoneBR` por `raw` na rota/handler: o caso "inválido → 422" cai.
 * - Voltar a validar só pela régua brasileira (sem `perfilDaOrganizacao`): o caso "fora do Brasil" cai.
 * - Tirar o `error.code === "23505"` do insert: o caso "409 phone_in_use" cai.
 * - Gravar o número também como extra quando a ficha não tem principal (ou
 *   não gravar o principal): o caso "sem principal" cai.
 * - Mover `requireSupportWrite()` para depois do insert: o caso de ordem cai.
 * - Auditar antes do insert, ou também no erro: o caso "audit só no sucesso" cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";

const { chamadas } = vi.hoisted(() => ({
  chamadas: [] as Array<{
    tabela: string;
    op: string;
    filtros: Array<[string, unknown]>;
    valores?: unknown;
  }>,
}));

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => {
    chamadas.push({ tabela: "support", op: "check", filtros: [] });
    return null;
  }),
}));
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

/**
 * Fake do cliente de sessão. Resposta por `tabela.op` (ex.: `contacts.select`),
 * e a chamada fica registrada com filtros e valores, na ordem em que aconteceu.
 */
function fakeSupabase(resultados: Record<string, Resultado>) {
  return {
    from: (tabela: string) => {
      const chamada = {
        tabela,
        op: "select",
        filtros: [] as Array<[string, unknown]>,
        valores: undefined as unknown,
      };
      chamadas.push(chamada);
      const resolver = () =>
        resultados[`${tabela}.${chamada.op}`] ?? resultados[tabela] ?? { data: null, error: null };
      const q: Record<string, unknown> = {
        select: () => q,
        insert: (v: unknown) => {
          chamada.op = "insert";
          chamada.valores = v;
          return q;
        },
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
        order: () => q,
        single: async () => resolver(),
        maybeSingle: async () => resolver(),
        then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
          Promise.resolve(resolver()).then(ok, ko),
      };
      return q;
    },
  };
}

function reqPost(corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/phones`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const CONTEXTO = { params: Promise.resolve({ id: CONTATO }) };
const FICHA_COM_PRINCIPAL = { id: CONTATO, phone_number: "+5511999998888" };
const FICHA_SEM_PRINCIPAL = { id: CONTATO, phone_number: null };
const EXTRA_CRIADO = {
  id: EXTRA,
  phone_number: "+5511988887777",
  tipo: "celular",
  whatsapp: "sim",
  rotulo: "Trabalho",
  origem: "manual",
  created_at: "2026-10-29T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  chamadas.length = 0;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
});

describe("POST /api/v1/contacts/[id]/phones", () => {
  it("número inválido → 422 invalid_phone, e nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ "contacts.select": { data: FICHA_COM_PRINCIPAL } }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(reqPost({ phone_number: "123" }), CONTEXTO);
    const corpo = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("invalid_phone");
    expect(chamadas.some((c) => c.op === "insert" || c.op === "update")).toBe(false);
  });

  it("organização fora do Brasil: número nacional é recusado (não vira +55) e nada é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        organizations: { data: { country: "PT" } },
        "contacts.select": { data: FICHA_SEM_PRINCIPAL },
      }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(reqPost({ phone_number: "1123456789" }), CONTEXTO);
    const corpo = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("invalid_phone");
    expect(chamadas.some((c) => c.op === "insert" || c.op === "update")).toBe(false);
  });

  it("organização fora do Brasil: número já em E.164 é aceito como veio", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        organizations: { data: { country: "PT" } },
        "contacts.select": { data: FICHA_SEM_PRINCIPAL },
        "contacts.update": { data: null, error: null },
      }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(reqPost({ phone_number: "+351912345678" }), CONTEXTO);

    expect(res.status).toBeLessThan(300);
    const gravacao = chamadas.find((c) => c.tabela === "contacts" && c.op === "update");
    expect((gravacao?.valores as { phone_number?: string })?.phone_number).toBe("+351912345678");
  });

  it("número que já é de outra ficha (23505) → 409 phone_in_use, e sem audit", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA_COM_PRINCIPAL },
        "contact_phones.insert": { data: null, error: { code: "23505", message: "unique" } },
      }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(reqPost({ phone_number: "(11) 98888-7777" }), CONTEXTO);
    const corpo = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(corpo.error.code).toBe("phone_in_use");
    expect(corpo.error.message).toBe("Este número já está em outra ficha.");
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("ficha SEM principal → grava o principal e devolve became_primary: true", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({ "contacts.select": { data: FICHA_SEM_PRINCIPAL } }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(reqPost({ phone_number: "11 99999-8888", type: "celular" }), CONTEXTO);
    const corpo = (await res.json()) as { data: unknown };

    expect(res.status).toBe(200);
    expect(corpo.data).toEqual({ became_primary: true });
    const atualizacao = chamadas.find((c) => c.tabela === "contacts" && c.op === "update");
    expect(atualizacao?.valores).toMatchObject({
      phone_number: "+5511999998888",
      phone_type: "celular",
    });
    expect(chamadas.some((c) => c.tabela === "contact_phones" && c.op === "insert")).toBe(false);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.primary_phone_changed" }),
    );
  });

  it("ficha COM principal → insere extra com origem manual, 201, sem wa_lid na resposta", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA_COM_PRINCIPAL },
        "contact_phones.insert": { data: EXTRA_CRIADO, error: null },
      }) as never,
    );
    const { POST } = await import("./route");

    const res = await POST(
      reqPost({
        phone_number: "+55 11 98888-7777",
        type: "celular",
        whatsapp: "sim",
        label: "Trabalho",
      }),
      CONTEXTO,
    );
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(201);
    const insercao = chamadas.find((c) => c.tabela === "contact_phones" && c.op === "insert");
    expect(insercao?.valores).toMatchObject({
      organization_id: ORG,
      contact_id: CONTATO,
      phone_number: "+5511988887777",
      origem: "manual",
      tipo: "celular",
      whatsapp: "sim",
      rotulo: "Trabalho",
    });
    expect(corpo.data).toEqual({
      id: EXTRA,
      phone_number: "+5511988887777",
      type: "celular",
      whatsapp: "sim",
      label: "Trabalho",
      origin: "manual",
      created_at: "2026-10-29T10:00:00.000Z",
    });
    expect(JSON.stringify(corpo)).not.toContain("wa_lid");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contact.extra_phone_added" }),
    );
  });

  it("papel viewer → 403, e nada é gravado", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "Papel insuficiente.", 403),
    } as never);
    vi.mocked(createClient).mockResolvedValue(fakeSupabase({}) as never);
    const { POST } = await import("./route");

    const res = await POST(reqPost({ phone_number: "11999998888" }), CONTEXTO);

    expect(res.status).toBe(403);
    expect(chamadas.some((c) => c.op === "insert" || c.op === "update")).toBe(false);
  });

  it("requireSupportWrite roda ANTES do efeito (o insert)", async () => {
    vi.mocked(createClient).mockResolvedValue(
      fakeSupabase({
        "contacts.select": { data: FICHA_COM_PRINCIPAL },
        "contact_phones.insert": { data: EXTRA_CRIADO, error: null },
      }) as never,
    );
    const { POST } = await import("./route");

    await POST(reqPost({ phone_number: "11988887777" }), CONTEXTO);

    const suporte = chamadas.findIndex((c) => c.tabela === "support");
    const efeito = chamadas.findIndex((c) => c.op === "insert");
    expect(suporte).toBeGreaterThanOrEqual(0);
    expect(suporte).toBeLessThan(efeito);
  });
});
