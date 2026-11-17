import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/ai/routers/:id é a rota que o editor rebusca depois de salvar.
 * Se ela não devolve `flow_pointer_id`, o baseline do editor vira "nenhuma
 * intenção tem roteiro": o Salvar fica ligado depois de vincular, e escolher
 * "Nenhum" deixa o draft igual ao baseline — o desvínculo nunca é gravado e a
 * intenção segue disparando o roteiro.
 *
 * #4340 (segunda metade) — PATCH com `channel_session_id` é o gesto de levar o
 * roteador para o número novo. Aqui se prova que a rota ACEITA o campo, que a
 * régua (só sai de número arquivado) é aplicada e que a mudança é auditada.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => undefined) }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ROUTER_ID = "55555555-5555-4555-8555-555555555555";
const NUMERO_ANTIGO = "66666666-6666-4666-8666-666666666666";
const NUMERO_NOVO = "77777777-7777-4777-8777-777777777777";

function autenticado(role: "agent" | "admin" = "admin") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER_ID,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG_ID, organization_name: "Org", role }],
    },
    org: { orgId: ORG_ID, name: "Org", role },
  } as Awaited<ReturnType<typeof requireRole>>);
}

interface Cenario {
  /** `archived_at` do número em que o roteador está hoje. `null` = conectado. */
  antigoArquivadoEm?: string | null;
  /** O número novo já tem roteador? */
  novoOcupado?: boolean;
}

/** PostgREST falso no recorte que o PATCH (e o move) consultam. */
function adminFalso(cenario: Cenario = {}) {
  const canal = (id: string, archived_at: string | null) => ({
    id,
    organization_id: ORG_ID,
    archived_at,
  });
  const canais = [
    canal(
      NUMERO_ANTIGO,
      cenario.antigoArquivadoEm === undefined ? "2026-11-01T00:00:00.000Z" : cenario.antigoArquivadoEm,
    ),
    canal(NUMERO_NOVO, null),
  ];

  const db = {
    from(tabela: string) {
      let colunas = "";
      const filtros: Array<[string, unknown]> = [];
      const resolver = () => {
        if (tabela === "channel_sessions") {
          const id = filtros.find(([c]) => c === "id")?.[1];
          const achado = canais.find((c) => c.id === id) ?? null;
          if (!achado) return { data: null, error: null };
          return { data: colunas.includes("archived_at") ? achado : { id: achado.id }, error: null };
        }
        if (tabela === "ai_routers") {
          // `select("id")` é a checagem de ocupante; o detalhe pede mais colunas.
          if (colunas.trim() === "id") {
            return {
              data: (cenario.novoOcupado ? [{ id: "ocupante" }] : []) as unknown[],
              error: null,
            };
          }
          if (colunas.includes("channel_session_id")) {
            return {
              data: {
                id: ROUTER_ID,
                name: "Roteador",
                channel_session_id: NUMERO_ANTIGO,
              },
              error: null,
            };
          }
          return { data: { id: ROUTER_ID, config: {}, fallback_agent_id: null }, error: null };
        }
        return { data: null, error: null };
      };
      const q = {
        select(c: string) {
          colunas = c;
          return q;
        },
        eq(coluna: string, valor: unknown) {
          filtros.push([coluna, valor]);
          return q;
        },
        is: () => q,
        order: () => q,
        limit: () => Promise.resolve(resolver()),
        maybeSingle: () => Promise.resolve(resolver()),
        update() {
          return {
            eq() {
              return this;
            },
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(resolve),
          };
        },
      };
      return q;
    },
  };

  return db as unknown as ReturnType<typeof createAdminClient>;
}

async function chamarPatch(corpo: unknown) {
  const { PATCH } = await import("./route");
  return PATCH(
    new NextRequest(`http://x/api/v1/ai/routers/${ROUTER_ID}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id: ROUTER_ID }) },
  );
}

describe("GET /api/v1/ai/routers/:id", () => {
  it("devolve flow_pointer_id de cada membro", async () => {
    autenticado("agent");

    const selects: Record<string, string> = {};
    const chain = (table: string, result: unknown) => {
      const q = {
        select(cols: string) {
          selects[table] = cols;
          return q;
        },
        eq() {
          return q;
        },
        maybeSingle: () => Promise.resolve({ data: result, error: null }),
        order: () => Promise.resolve({ data: result, error: null }),
      };
      return q;
    };
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) =>
        table === "ai_routers"
          ? chain(table, { id: ROUTER_ID, name: "R" })
          : chain(table, [{ id: "m1", flow_pointer_id: "77777777-7777-4777-8777-777777777777" }]),
    } as unknown as ReturnType<typeof createAdminClient>);

    const { GET } = await import("./route");
    const res = await GET(new NextRequest(`http://x/api/v1/ai/routers/${ROUTER_ID}`), {
      params: Promise.resolve({ id: ROUTER_ID }),
    });

    expect(res.status).toBe(200);
    expect(selects.ai_router_members).toContain("flow_pointer_id");
  });
});

describe("#4340 — PATCH leva o roteador para o número novo", () => {
  it("número atual arquivado: aceita o channel_session_id e audita 'de X para Y'", async () => {
    autenticado();
    vi.mocked(audit).mockClear();
    vi.mocked(createAdminClient).mockReturnValue(adminFalso());

    const res = await chamarPatch({ channel_session_id: NUMERO_NOVO });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { id: ROUTER_ID, de: NUMERO_ANTIGO, para: NUMERO_NOVO, movido: true },
    });
    expect(audit, "a mudança de número não foi auditada").toHaveBeenCalledTimes(1);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "ai.router_channel_moved",
      resourceId: ROUTER_ID,
      metadata: { de: NUMERO_ANTIGO, para: NUMERO_NOVO },
    });
  });

  it("número atual CONECTADO: 422 e nada é movido — a porta não troca número vivo", async () => {
    autenticado();
    vi.mocked(audit).mockClear();
    vi.mocked(createAdminClient).mockReturnValue(adminFalso({ antigoArquivadoEm: null }));

    const res = await chamarPatch({ channel_session_id: NUMERO_NOVO });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "numero_atual_ainda_ativo" } });
    expect(audit).not.toHaveBeenCalled();
  });

  it("número novo que já tem roteador: 409, sem mover e sem audit", async () => {
    autenticado();
    vi.mocked(audit).mockClear();
    vi.mocked(createAdminClient).mockReturnValue(adminFalso({ novoOcupado: true }));

    const res = await chamarPatch({ channel_session_id: NUMERO_NOVO });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "router_already_exists" } });
    expect(audit).not.toHaveBeenCalled();
  });

  it("channel_session_id que não é uuid: 422 de validação, sem tocar no banco", async () => {
    autenticado();
    vi.mocked(createAdminClient).mockReturnValue(adminFalso());

    const res = await chamarPatch({ channel_session_id: "nao-e-uuid" });

    expect(res.status).toBe(422);
  });
});
