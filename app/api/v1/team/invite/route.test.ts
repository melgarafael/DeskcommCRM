import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONVITE COM O PLANO CHEIO É RECUSADO ANTES DO E-MAIL (spec cobrança §5, D-10;
 * decisão do dono de 30/09). A frase diz a saída: remover alguém ou pedir a
 * troca de plano. A autoridade sobre o que já foi convidado segue no gatilho de
 * assentos, no aceite. Convite pendente não conta; o membro provisório do
 * handover também não — a mesma contagem do gatilho.
 */
const h = vi.hoisted(() => ({
  role: vi.fn(),
  emitir: vi.fn(),
  warn: vi.fn(),
  admin: null as unknown,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/audit", () => ({ isServiceRoleConfigured: () => true, audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/team/convites", () => ({ emitirConvite: h.emitir }));
vi.mock("@/lib/auth/issue-invite", () => ({ issueInvite: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";

function adminCom(o: {
  membros: Array<{ user_id: string; provisional_until_handover: boolean }>;
  limite: number | null;
  erroDoLimite?: boolean;
}) {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    is: async () => ({ data: o.membros, error: null }),
  };
  return {
    from: () => cadeia,
    rpc: vi.fn(async () =>
      o.erroDoLimite
        ? { data: null, error: { code: "42883", message: "function does not exist" } }
        : { data: o.limite, error: null },
    ),
    auth: {
      admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { email: `${id}@x.test` } } })) },
    },
  };
}

const pedido = () =>
  new NextRequest("http://localhost/api/v1/team/invite", {
    method: "POST",
    body: JSON.stringify({ invitations: [{ email: "nova@x.test", role: "agent" }] }),
  });

const DOIS_ATIVOS = [
  { user_id: "u1", provisional_until_handover: false },
  { user_id: "u2", provisional_until_handover: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({
    ok: true,
    user: { id: "admin", email: "admin@x.test", full_name: "Admin", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Empresa" },
  });
  h.emitir.mockResolvedValue({
    convite: { id: "conv-1", expires_at: "2026-10-01T00:00:00Z" },
    accept_url: "http://localhost/team/accept-invite/x",
    email_dispatched: true,
  });
});

describe("convite e o limite de pessoas do plano", () => {
  it("⭐ plano cheio: 409 plan_limit_reached com o número, e nenhum convite sai", async () => {
    h.admin = adminCom({ membros: DOIS_ATIVOS, limite: 2 });
    const res = await POST(pedido());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("plan_limit_reached");
    expect(body.error.message).toContain("Seu plano permite 2 pessoas");
    expect(body.error.details).toEqual({ recurso: "assentos", limite: 2 });
    expect(h.emitir).not.toHaveBeenCalled();
  });

  it("com vaga, o convite sai (controle positivo)", async () => {
    h.admin = adminCom({ membros: DOIS_ATIVOS, limite: 3 });
    expect((await POST(pedido())).status).toBe(201);
    expect(h.emitir).toHaveBeenCalledTimes(1);
  });

  it("sem limite (cobrança desligada ou org isenta), o convite sai", async () => {
    h.admin = adminCom({ membros: DOIS_ATIVOS, limite: null });
    expect((await POST(pedido())).status).toBe(201);
  });

  it("o membro provisório do handover não ocupa vaga — a contagem é a do gatilho", async () => {
    h.admin = adminCom({
      membros: [DOIS_ATIVOS[0]!, { user_id: "prov", provisional_until_handover: true }],
      limite: 2,
    });
    expect((await POST(pedido())).status).toBe(201);
  });

  it("ler o limite falhou: o convite SEGUE e a causa vai ao log (a trava continua no aceite)", async () => {
    h.admin = adminCom({ membros: DOIS_ATIVOS, limite: null, erroDoLimite: true });
    expect((await POST(pedido())).status).toBe(201);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("limite do plano"),
      expect.objectContaining({ causa: expect.stringContaining("42883") }),
    );
  });
});
