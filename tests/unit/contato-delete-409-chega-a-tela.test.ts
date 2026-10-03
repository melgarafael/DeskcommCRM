/**
 * O 409 DA EXCLUSÃO DE CONTATO CHEGA À TELA COM OS VÍNCULOS (issue #1925).
 *
 * O handler já lançava `details: { vinculos, por_tabela }`, mas a rota DELETE
 * serializava o erro com `fail(code, message, status, { requestId })` — sem
 * `details`. O 409 chegava ao browser sem os vínculos e a tela caía no texto
 * genérico. Um teste só do handler (`contato-delete.test.ts`) fica verde com a
 * feature morta de ponta a ponta; este atravessa a ROTA e a frase da tela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { mensagemDeBloqueioPorVinculo } from "@/hooks/contacts/useDeleteContact";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  deleteContactHandler: vi.fn(async () => {
    throw new ApiError(
      409,
      "state_conflict",
      { vinculos: ["2 compromisso(s) na agenda"], por_tabela: { calendar_appointments: 2 } },
      "req-1925",
      "Não foi possível excluir: o contato ainda tem registros vinculados.",
    );
  }),
  getContactHandler: vi.fn(),
  patchContactHandler: vi.fn(),
}));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: "c05e7a00-0000-4000-8000-0000000000a1",
      email: "ana@clinica.com.br",
      full_name: "Ana",
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "agent" }],
    },
    org: { orgId: ORG, name: "Clínica", role: "agent" },
  } as never);
});

describe("DELETE /api/v1/contacts/[id] — 409 por vínculo", () => {
  it("devolve error.details com os vínculos e a contagem por tabela", async () => {
    const { DELETE } = await import("@/app/api/v1/contacts/[id]/route");
    const res = await DELETE(
      new NextRequest(`https://crm.exemplo/api/v1/contacts/${CONTATO}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: CONTATO }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.details).toEqual({
      vinculos: ["2 compromisso(s) na agenda"],
      por_tabela: { calendar_appointments: 2 },
    });
  });
});

describe("mensagemDeBloqueioPorVinculo", () => {
  const pt = (s: string) => traduzir(s, "pt-BR");
  const es = (s: string) => traduzir(s, "es");

  it("singular com 1 compromisso", () => {
    expect(mensagemDeBloqueioPorVinculo({ por_tabela: { calendar_appointments: 1 } }, pt)).toBe(
      "Este contato tem 1 compromisso na Agenda. Cancele ou apague o compromisso antes de excluir.",
    );
  });

  it("plural com o número, e em espanhol sai em espanhol", () => {
    expect(mensagemDeBloqueioPorVinculo({ por_tabela: { calendar_appointments: 3 } }, pt)).toBe(
      "Este contato tem 3 compromissos na Agenda. Cancele ou apague os compromissos antes de excluir.",
    );
    expect(mensagemDeBloqueioPorVinculo({ por_tabela: { calendar_appointments: 3 } }, es)).toBe(
      "Este contacto tiene 3 citas en la Agenda. Cancela o elimina las citas antes de eliminar el contacto.",
    );
  });

  it("sem contagem da Agenda devolve null (a tela cai no texto genérico)", () => {
    expect(mensagemDeBloqueioPorVinculo(undefined, pt)).toBeNull();
    expect(mensagemDeBloqueioPorVinculo({ vinculos: ["1 x"] }, pt)).toBeNull();
    expect(mensagemDeBloqueioPorVinculo({ por_tabela: { outra_tabela: 2 } }, pt)).toBeNull();
  });
});
