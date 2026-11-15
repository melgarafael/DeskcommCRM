import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3876 (fatia 1) — criar a pessoa SEM convite, com a senha definida por quem
 * administra.
 *
 * O que esta suíte prova, e por quê:
 *
 * - a conta nasce com a senha do corpo e `email_confirm: true` (sem e-mail não
 *   há link para confirmar; conta pendente de confirmação recusaria o login);
 * - o VÍNCULO nasce com `senha_provisoria = true` — o sinal que o gate do
 *   servidor lê (`requireRole` recusa /api/v1 e o layout manda para
 *   /trocar-senha);
 * - NENHUM e-mail sai: é o ponto inteiro da fatia, e o convite continua sendo o
 *   único caminho que depende de SMTP;
 * - a régua de senha é a MESMA da recuperação (`resetPasswordSchema`), então
 *   senha fraca morre em 422 antes de qualquer escrita;
 * - e-mail que já tem conta é 409 — esta porta não troca a senha de conta
 *   alheia;
 * - plano cheio e vínculo recusado não deixam conta de auth órfã: a criação é
 *   compensada com `deleteUser`.
 */
/** O evento de auditoria — tipo explícito para `mock.calls[0]![0]` não ser `never`. */
type EventoDeAudit = {
  action: string;
  actorUserId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
};

const h = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(async (_e: EventoDeAudit) => undefined),
  admin: null as unknown,
  sendEmail: vi.fn(),
  lerLimite: vi.fn(async () => null as number | null),
  traduzirLimite: vi.fn(() => null as null | { code: string; message: string; details: unknown }),
  logErro: vi.fn(),
  logWarn: vi.fn(),
  /** Cliente de SESSÃO: a rota não pode encostar nele — criar usuário não é entrar. */
  createSessionClient: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/audit", () => ({
  isServiceRoleConfigured: () => true,
  audit: h.audit,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/email/roteador", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/cobranca/limites", () => ({
  lerLimiteDoPlano: h.lerLimite,
  mensagemDoLimite: (recurso: string, limite: number) => `Limite de ${recurso} (${limite}) atingido.`,
  traduzirLimiteDoPlano: h.traduzirLimite,
}));
vi.mock("@/lib/auth/cache-curto", () => ({ invalidarUsuario: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.createSessionClient }));
vi.mock("@/lib/logger", () => ({
  logger: { error: h.logErro, warn: h.logWarn, info: vi.fn() },
}));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const NOVO_ID = "33333333-3333-4333-8333-333333333333";
const SENHA = "Provisoria#2026";

function sessaoAdmin() {
  h.role.mockResolvedValue({
    ok: true,
    user: { id: ADMIN_ID, email: "admin@empresa.test", idioma: "pt-BR", full_name: "Admin" },
    org: { orgId: ORG, name: "Empresa", role: "admin", org_status: "active" },
  });
}

interface Cenario {
  membros?: Array<{ user_id: string; provisional_until_handover: boolean }>;
  erroMembros?: { message: string } | null;
  erroCria?: { message: string; status?: number; code?: string } | null;
  erroVinculo?: { message: string; code?: string } | null;
}

function adminFake(o: Cenario = {}) {
  const insercao: { payload?: Record<string, unknown> } = {};
  const createUser = vi.fn(async () =>
    o.erroCria
      ? { data: { user: null }, error: o.erroCria }
      : { data: { user: { id: NOVO_ID, email: "novo@empresa.test" } }, error: null },
  );
  const deleteUser = vi.fn(async () => ({ data: null, error: null }));
  const vinculo = {
    data: o.erroVinculo ? null : { id: "vinculo-1" },
    error: o.erroVinculo ?? null,
  };
  const tabelas: string[] = [];
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    is: async () => ({ data: o.membros ?? [], error: o.erroMembros ?? null }),
    insert: (payload: Record<string, unknown>) => {
      insercao.payload = payload;
      return cadeia;
    },
    single: async () => vinculo,
  };
  return {
    from: (tabela: string) => {
      tabelas.push(tabela);
      return cadeia;
    },
    auth: { admin: { createUser, deleteUser } },
    insercao,
    tabelas,
  };
}

const pedido = (corpo: Record<string, unknown> = {}) =>
  new NextRequest("http://localhost/api/v1/team/users", {
    method: "POST",
    body: JSON.stringify({
      full_name: "Pessoa Nova",
      email: "novo@empresa.test",
      role: "agent",
      password: SENHA,
      password_confirm: SENHA,
      ...corpo,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.lerLimite.mockResolvedValue(null);
  h.traduzirLimite.mockReturnValue(null);
  h.admin = adminFake();
  sessaoAdmin();
});

describe("POST /api/v1/team/users — criar sem convite (#3876)", () => {
  it("cria a conta com a senha do corpo, confirmada, e o vínculo com troca obrigatória", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(201);

    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).toHaveBeenCalledWith({
      email: "novo@empresa.test",
      password: SENHA,
      email_confirm: true,
      user_metadata: { full_name: "Pessoa Nova" },
    });

    const corpo = await res.json();
    expect(corpo.data).toMatchObject({
      user_id: NOVO_ID,
      email: "novo@empresa.test",
      role: "agent",
      deve_trocar_senha: true,
    });
    // O sinal do primeiro acesso não é "resposta bonita": é coluna.
    expect(corpo.data.senha_provisoria).toBeUndefined();
  });

  it("não encosta na sessão de ninguém: criar usuário não é entrar", async () => {
    await POST(pedido());
    // Nem para "conferir": o client de sessão (o que carrega cookies) não é
    // usado em lugar nenhum desta rota, então a senha nova não vira login
    // deste navegador nem sessão do admin é trocada.
    expect(h.createSessionClient).not.toHaveBeenCalled();
    const admin = h.admin as ReturnType<typeof adminFake>;
    // Só o vínculo é tocado: nem `team_invites` (convite), nem tabela de sessão.
    expect([...new Set(admin.tabelas)]).toEqual(["user_organizations"]);
  });

  it("NÃO manda e-mail — a fatia inteira existe para não depender de SMTP", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(201);
    expect(h.sendEmail).not.toHaveBeenCalled();
    const corpo = await res.json();
    // Nada de `accept_url`/`email_dispatched`: não há convite, há conta.
    expect(JSON.stringify(corpo)).not.toContain("accept_url");
    expect(JSON.stringify(corpo)).not.toContain("email_dispatched");
  });

  it("audita member.created sem a senha no metadata", async () => {
    await POST(pedido());
    expect(h.audit).toHaveBeenCalledTimes(1);
    const entrada = h.audit.mock.calls[0]![0];
    expect(entrada.action).toBe("member.created");
    expect(entrada.actorUserId).toBe(ADMIN_ID);
    expect(entrada.organizationId).toBe(ORG);
    expect(entrada.metadata).toMatchObject({
      target_user_id: NOVO_ID,
      email: "novo@empresa.test",
      role: "agent",
      senha_provisoria: true,
    });
    // A trilha responde "quem criou quem" — nunca guarda credencial.
    expect(JSON.stringify(entrada.metadata)).not.toContain(SENHA);
  });

  it("senha fraca morre em 422 pela régua da recuperação, sem criar conta", async () => {
    const res = await POST(pedido({ password: "senhafraca", password_confirm: "senhafraca" }));
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_error");
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("senhas que não coincidem morrem em 422", async () => {
    const res = await POST(pedido({ password_confirm: `${SENHA}x` }));
    expect(res.status).toBe(422);
  });

  it("o vínculo nasce marcado, com papel, interface e autoria do admin", async () => {
    const res = await POST(pedido({ interface_settings: { preset: "simplificada" }, role: "manager" }));
    expect(res.status).toBe(201);
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.insercao.payload).toMatchObject({
      organization_id: ORG,
      user_id: NOVO_ID,
      role: "manager",
      interface_settings: { preset: "simplificada" },
      invited_by: ADMIN_ID,
      senha_provisoria: true,
    });
    // `accepted_at` preenchido: a pessoa já é membro — o aceite de convite é
    // que marca isso no outro caminho, e aqui não existe convite.
    expect(admin.insercao.payload?.accepted_at).toEqual(expect.any(String));
  });

  it("recusa quem não é admin (a autorização é do requireRole, não da tela)", async () => {
    h.role.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    });
    const res = await POST(pedido());
    expect(res.status).toBe(403);
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("e-mail que já tem conta é 409 — esta porta não troca a senha de conta alheia", async () => {
    h.admin = adminFake({ erroCria: { message: "User already registered", status: 422 } });
    const res = await POST(pedido());
    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("email_already_registered");
  });

  it("e-mail do próprio admin é 409 antes de qualquer chamada ao GoTrue", async () => {
    const res = await POST(pedido({ email: "admin@empresa.test" }));
    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("email_already_registered");
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("plano cheio recusa ANTES de criar a conta", async () => {
    h.admin = adminFake({
      membros: [
        { user_id: "u1", provisional_until_handover: false },
        { user_id: "u2", provisional_until_handover: false },
      ],
    });
    h.lerLimite.mockResolvedValue(2);
    const res = await POST(pedido());
    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("plan_limit_reached");
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("vínculo recusado apaga a conta criada — sem login órfão", async () => {
    h.admin = adminFake({ erroVinculo: { message: "boom", code: "XX000" } });
    const res = await POST(pedido());
    expect(res.status).toBe(500);
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(NOVO_ID);
    // E a trilha de sucesso NÃO roda para uma criação que não existiu.
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("vínculo recusado pelo teto de assentos (PT402) devolve 409 e compensa", async () => {
    h.admin = adminFake({ erroVinculo: { message: "assentos", code: "PT402" } });
    h.traduzirLimite.mockReturnValue({
      code: "plan_limit_reached",
      message: "Limite de assentos atingido.",
      details: { recurso: "assentos", limite: 3 },
    });
    const res = await POST(pedido());
    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("plan_limit_reached");
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.deleteUser).toHaveBeenCalledWith(NOVO_ID);
  });
});
