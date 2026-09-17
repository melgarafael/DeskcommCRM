/**
 * A porta que faltava para fechar um dia.
 *
 * O que estes casos protegem:
 *
 * 1. **A autorização é da RLS, não da rota.** A rota usa o client de SESSÃO, e
 *    a policy já diz quem escreve (o dono da agenda ou manager+). Se alguém
 *    trocar por `createAdminClient` "para simplificar", a RLS é contornada e
 *    qualquer agent passa a fechar a agenda de qualquer colega — em silêncio.
 * 2. **`user_id` ausente é a própria pessoa**, nunca nulo nem do body sem rede.
 * 3. **23505 e 42501 são recusas com significado**, não 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  criarClientDeSessao: vi.fn(),
  criarClientAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.criarClientDeSessao }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.criarClientAdmin }));

const ORG = "11111111-1111-4111-8111-111111111111";
const EU = "22222222-2222-4222-8222-222222222222";
const COLEGA = "33333333-3333-4333-8333-333333333333";

/** Devolve o client e o que o insert recebeu. */
function clientQueInsere(resultado: { data?: unknown; error?: { code: string; message: string } }) {
  const capturado: { payload?: Record<string, unknown> } = {};
  return {
    capturado,
    client: {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          capturado.payload = payload;
          return {
            select: () => ({
              single: async () => ({
                data: resultado.data ?? null,
                error: resultado.error ?? null,
              }),
            }),
          };
        },
      }),
    },
  };
}

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: EU, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  });
});

describe("POST /api/v1/agenda/excecoes", () => {
  it("usa o client de SESSÃO — a RLS é quem autoriza, e o admin bypassaria", async () => {
    const { client } = clientQueInsere({ data: { id: "e1" } });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const { POST } = await import("./route");
    await POST(req({ exception_date: "2026-12-25" }));

    expect(deps.criarClientDeSessao).toHaveBeenCalled();
    // Se isto falhar, a policy `..._write` deixou de proteger a agenda alheia.
    expect(deps.criarClientAdmin).not.toHaveBeenCalled();
  });

  it("sem user_id, bloqueia a agenda de quem pediu — e o dia inteiro é 0..1440", async () => {
    const { client, capturado } = clientQueInsere({ data: { id: "e1" } });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const { POST } = await import("./route");
    await POST(req({ exception_date: "2026-12-25", reason: "Natal" }));

    expect(capturado.payload).toMatchObject({
      organization_id: ORG,
      user_id: EU,
      exception_date: "2026-12-25",
      is_unavailable: true,
      // `null` aqui colidiria consigo mesmo na UNIQUE e deixaria duplicar.
      start_minute: 0,
      end_minute: 1440,
      reason: "Natal",
    });
  });

  it("com user_id, passa adiante e deixa a RLS decidir", async () => {
    const { client, capturado } = clientQueInsere({ data: { id: "e1" } });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const { POST } = await import("./route");
    await POST(req({ exception_date: "2026-12-25", user_id: COLEGA }));

    expect((capturado.payload as Record<string, unknown>).user_id).toBe(COLEGA);
  });

  it("a RLS recusando vira 403 com frase de gente, não 500", async () => {
    const { client } = clientQueInsere({
      error: { code: "42501", message: "new row violates row-level security policy" },
    });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const { POST } = await import("./route");
    const res = await POST(req({ exception_date: "2026-12-25", user_id: COLEGA }));

    expect(res.status).toBe(403);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("dia já bloqueado vira 409, não 500", async () => {
    const { client } = clientQueInsere({
      error: { code: "23505", message: "duplicate key" },
    });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const { POST } = await import("./route");
    expect((await POST(req({ exception_date: "2026-12-25" }))).status).toBe(409);
  });

  it("faixa invertida não chega ao banco", async () => {
    const { client, capturado } = clientQueInsere({ data: { id: "e1" } });
    deps.criarClientDeSessao.mockResolvedValue(client);

    const { POST } = await import("./route");
    const res = await POST(
      req({ exception_date: "2026-12-25", start_minute: 600, end_minute: 300 }),
    );

    expect(res.status).toBe(422);
    expect(capturado.payload).toBeUndefined();
  });

  it("suporte em modo leitura é barrado antes de qualquer efeito", async () => {
    deps.support.mockResolvedValue(new Response("readonly", { status: 403 }));

    const { POST } = await import("./route");
    expect((await POST(req({ exception_date: "2026-12-25" }))).status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();
    expect(deps.criarClientDeSessao).not.toHaveBeenCalled();
  });
});
