import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3876 — criar a pessoa SEM convite, com senha provisória gerada pelo
 * servidor (doc 310, alternativa A).
 *
 * O que esta suíte prova, e por quê:
 *
 * - só o dono da instalação, ou o admin numa instalação de UMA empresa, cria;
 * - a senha é gerada aqui (o corpo não carrega senha) e volta UMA vez, com
 *   `no-store`; a conta nasce com `email_confirm: true`;
 * - o VÍNCULO nasce com `senha_provisoria = true` — o sinal que o gate do
 *   servidor lê (`requireRole` recusa /api/v1 e o layout manda para
 *   /trocar-senha);
 * - NENHUM e-mail sai: é o ponto inteiro da fatia, e o convite continua sendo o
 *   único caminho que depende de SMTP;
 * - toda recusa da criação tem a MESMA resposta, qualquer que seja o motivo;
 * - há limite de tentativas por organização;
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
  rate: vi.fn(async () => ({ allowed: true, count: 1, limit: 10 })),
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
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: h.rate }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.createSessionClient }));
vi.mock("@/lib/logger", () => ({
  logger: { error: h.logErro, warn: h.logWarn, info: vi.fn() },
}));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const NOVO_ID = "33333333-3333-4333-8333-333333333333";
/** A forma da senha que o servidor gera: três grupos de 4, sem 0/O/1/l/I. */
const FORMA_DA_SENHA = /^[A-HJ-NP-Za-hj-km-np-z2-9]{4}-[A-HJ-NP-Za-hj-km-np-z2-9]{4}-[A-HJ-NP-Za-hj-km-np-z2-9]{4}$/;

function sessaoAdmin(extra: Record<string, unknown> = {}) {
  h.role.mockResolvedValue({
    ok: true,
    user: { id: ADMIN_ID, email: "admin@empresa.test", idioma: "pt-BR", full_name: "Admin", ...extra },
    org: { orgId: ORG, name: "Empresa", role: "admin", org_status: "active" },
  });
}

interface Cenario {
  /** Quantas empresas a instalação tem (default 1). */
  empresas?: number;
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
  const contagem = {
    select: async () => ({ count: o.empresas ?? 1, error: null }),
  };
  return {
    from: (tabela: string) => {
      tabelas.push(tabela);
      return tabela === "organizations" ? contagem : cadeia;
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
  it("cria a conta com a senha GERADA, confirmada, e devolve a senha uma vez sem cache", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).toHaveBeenCalledWith({
      email: "novo@empresa.test",
      password: expect.stringMatching(FORMA_DA_SENHA),
      email_confirm: true,
      user_metadata: { full_name: "Pessoa Nova" },
    });
    const senhaCriada = (admin.auth.admin.createUser.mock.calls[0] as unknown as [{ password: string }])[0]
      .password;

    const corpo = await res.json();
    expect(corpo.data).toMatchObject({
      user_id: NOVO_ID,
      email: "novo@empresa.test",
      role: "agent",
      deve_trocar_senha: true,
      senha_provisoria: senhaCriada,
    });
  });

  it("duas criações não repetem a senha", async () => {
    await POST(pedido());
    await POST(pedido());
    const admin = h.admin as ReturnType<typeof adminFake>;
    const senhas = (admin.auth.admin.createUser.mock.calls as unknown as Array<[{ password: string }]>).map(
      (c) => c[0].password,
    );
    expect(senhas).toHaveLength(2);
    expect(senhas[0]).not.toBe(senhas[1]);
  });

  it("não encosta na sessão de ninguém: criar usuário não é entrar", async () => {
    await POST(pedido());
    // Nem para "conferir": o client de sessão (o que carrega cookies) não é
    // usado em lugar nenhum desta rota, então a senha nova não vira login
    // deste navegador nem sessão do admin é trocada.
    expect(h.createSessionClient).not.toHaveBeenCalled();
    const admin = h.admin as ReturnType<typeof adminFake>;
    // Só a contagem de empresas e o vínculo: nem `team_invites` (convite), nem
    // tabela de sessão.
    expect([...new Set(admin.tabelas)].sort()).toEqual(["organizations", "user_organizations"]);
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
    const admin = h.admin as ReturnType<typeof adminFake>;
    const senhaCriada = (admin.auth.admin.createUser.mock.calls[0] as unknown as [{ password: string }])[0]
      .password;
    expect(JSON.stringify(entrada.metadata)).not.toContain(senhaCriada);
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain(senhaCriada);
    expect(JSON.stringify(h.logErro.mock.calls)).not.toContain(senhaCriada);
  });

  it("senha no corpo é recusada (422), não aproveitada: quem administra não escolhe a senha", async () => {
    const res = await POST(pedido({ password: "Escolhida#2026", password_confirm: "Escolhida#2026" }));
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_error");
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  describe("alcance (doc 310 A)", () => {
    it("admin de empresa numa instalação com VÁRIAS empresas é recusado — o caminho é o convite", async () => {
      h.admin = adminFake({ empresas: 2 });
      const res = await POST(pedido());
      expect(res.status).toBe(403);
      const corpo = await res.json();
      expect(corpo.error.code).toBe("invite_required");
      const admin = h.admin as ReturnType<typeof adminFake>;
      expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
      // A recusa de alcance não gasta tentativa do limite.
      expect(h.rate).not.toHaveBeenCalled();
    });

    it("o dono da instalação (platform admin full) cria mesmo com várias empresas", async () => {
      sessaoAdmin({ is_platform_admin: true, platform_admin_scope: "full" });
      h.admin = adminFake({ empresas: 5 });
      const res = await POST(pedido());
      expect(res.status).toBe(201);
    });

    it("platform admin só-leitura NÃO conta como dono da instalação", async () => {
      sessaoAdmin({ is_platform_admin: true, platform_admin_scope: "support_readonly" });
      h.admin = adminFake({ empresas: 2 });
      const res = await POST(pedido());
      expect(res.status).toBe(403);
    });

    it("contagem de empresas que falha fecha a porta", async () => {
      const admin = adminFake();
      const from = admin.from;
      admin.from = (tabela: string) =>
        tabela === "organizations"
          ? ({ select: async () => ({ count: null, error: { code: "XX000" } }) } as never)
          : from(tabela);
      h.admin = admin;
      const res = await POST(pedido());
      expect(res.status).toBe(403);
      expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
    });
  });

  it("limite de tentativas: 429 com Retry-After, sem criar conta", async () => {
    h.rate.mockResolvedValueOnce({ allowed: false, count: 11, limit: 10 });
    const res = await POST(pedido());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    const corpo = await res.json();
    expect(corpo.error.code).toBe("rate_limited");
    expect(h.rate).toHaveBeenCalledWith(`equipe:criar-com-senha:${ORG}`, 10, 3600);
    const admin = h.admin as ReturnType<typeof adminFake>;
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
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

  it("recusa da criação: a resposta é a mesma qualquer que seja o motivo", async () => {
    h.admin = adminFake({ erroCria: { message: "A user with this email address has already been registered", status: 422 } });
    const existe = await POST(pedido());
    const corpoExiste = await existe.json();

    h.admin = adminFake({ erroCria: { message: "Database error creating new user", status: 500 } });
    const falha = await POST(pedido());
    const corpoFalha = await falha.json();

    expect(existe.status).toBe(falha.status);
    expect(corpoExiste.error).toEqual(corpoFalha.error);
    expect(corpoExiste.error.code).toBe("user_not_created");
    expect(JSON.stringify(corpoExiste)).not.toMatch(/existe|registered|already/i);

    // O motivo real fica no log e na auditoria do dono da instalação.
    const recusas = h.audit.mock.calls.map((c) => c[0]).filter((e) => e.action === "member.create_refused");
    expect(recusas).toHaveLength(2);
    expect(recusas[0]).toMatchObject({ organizationId: null, metadata: { motivo: "email_ja_tem_conta" } });
    expect(recusas[1]).toMatchObject({ organizationId: null, metadata: { motivo: "gotrue_recusou" } });
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
