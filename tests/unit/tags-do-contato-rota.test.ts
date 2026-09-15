import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * Tags do CONTATO sem sugestão (#852, item 1 da divisão). O editor de tags da
 * conversa já oferecia as tags em uso; o do contato obrigava a digitar do zero,
 * e cada operador criava a sua variação ("google", "gogle", "google ads").
 *
 * Dois lados, porque um sem o outro não resolve:
 *  - a ROTA precisa devolver as tags que existem, só da organização da sessão;
 *  - o EDITOR precisa oferecê-las e gravar a escolhida.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG = "org-1";
type Linha = Record<string, unknown>;
/** Aplica `eq`, `neq` (com `{}` = lista vazia) e `limit`: um dublê que os ignorasse vazaria a outra organização. */
function bancoFalso(linhas: Linha[], erro: { message: string } | null = null) {
  const from = () => {
    let rows = [...linhas];
    let limite = Infinity;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => ((rows = rows.filter((l) => l[col] === val)), chain),
      neq: (col: string, val: unknown) => {
        rows = rows.filter((l) => (val === "{}" ? (l[col] as unknown[]).length > 0 : l[col] !== val));
        return chain;
      },
      order: () => chain,
      limit: (n: number) => ((limite = n), chain),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: erro ? null : rows.slice(0, limite), error: erro }).then(res),
    };
    return chain;
  };
  return { from } as never;
}

async function chamaRota() {
  const { GET } = await import("@/app/api/v1/contact-tags/route");
  const res = await GET(new NextRequest("http://x/api/v1/contact-tags"));
  return { status: res.status, body: (await res.json()) as { data?: string[] } };
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, org: { orgId: ORG, name: "Org", role: "agent" } } as never);
});

describe("GET /api/v1/contact-tags", () => {
  it("devolve as tags em uso nos contatos da organização, sem repetir e em ordem", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso([
      { organization_id: ORG, tags: ["vip", "google"] },
      { organization_id: ORG, tags: ["google"] },
      { organization_id: ORG, tags: [] },
      { organization_id: "org-2", tags: ["segredo-de-outra-org"] },
    ]));

    const { status, body } = await chamaRota();

    expect(status).toBe(200);
    expect(body.data).toEqual(["google", "vip"]);
  });

  it("falha na leitura vira erro, não lista vazia", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso([], { message: "boom" }));

    const { status } = await chamaRota();

    expect(status).toBe(500);
  });
});
