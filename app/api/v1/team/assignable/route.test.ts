// @vitest-environment node
/**
 * GET /api/v1/team/assignable — só membro ATIVO é destino válido.
 *
 * Convite pendente (`accepted_at` nulo) e vínculo revogado não aparecem: quem ainda não
 * entrou não pode receber conversa, tarefa nem a carteira de uma importação. O banco já
 * recusa o dono sem convite aceito; a lista não pode oferecê-lo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  filtros: [] as Array<[string, ...unknown[]]>,
  cliente: (() => ({})) as () => unknown,
}));

function cliente() {
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ["from", "select", "eq", "is", "not", "neq"]) {
    cadeia[metodo] = (...args: unknown[]) => {
      h.filtros.push([metodo, ...args]);
      return cadeia;
    };
  }
  cadeia.order = async () => ({ data: [{ user_id: "u1", role: "agent" }], error: null });
  return cadeia;
}

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({ ok: true, organizationId: "org-1", supabase: h.cliente() })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.cliente() }));

import { GET } from "./route";

beforeEach(() => {
  h.filtros = [];
  h.cliente = cliente;
});

describe("GET /api/v1/team/assignable", () => {
  it("filtra revogado, convite não aceito e viewer", async () => {
    const res = await GET(new Request("https://crm.exemplo/api/v1/team/assignable") as never);
    expect(res.status).toBe(200);
    expect(h.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", "org-1"],
        ["is", "revoked_at", null],
        ["not", "accepted_at", "is", null],
        ["neq", "role", "viewer"],
      ]),
    );
  });
});
