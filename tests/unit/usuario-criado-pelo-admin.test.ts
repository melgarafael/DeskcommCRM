/**
 * "ADMIN CRIA A PESSOA COM SENHA" (#3876) — o caminho, a régua e o segredo.
 *
 * O que este arquivo prende, item por item:
 *
 *   1. a conta nasce com a senha que o admin definiu e já CONFIRMADA
 *      (`email_confirm: true`) — é o que faz o login funcionar sem depender de
 *      um e-mail que, em instalação sem SMTP, nunca sai;
 *   2. a membership nasce no MESMO ato, pela função do aceite de convite
 *      (7 parâmetros, `p_issued_at = p_invited_at = agora`, `p_invited_by` =
 *      quem criou) — e NENHUMA linha em `team_invites`: não há convite
 *      pendente para quem já entra;
 *   3. a régua de senha é a do fluxo ATUAL: a recusa tem de trazer a MESMA
 *      frase que `resetPasswordSchema` dá para o mesmo valor, porque é o mesmo
 *      objeto zod (`senhaDoAcesso`) — não uma cópia parecida;
 *   4. a trilha guarda QUEM criou QUEM (`member.created`, ator = admin), e a
 *      SENHA não aparece no audit, no log nem no retorno — nem no da função,
 *      nem no da API;
 *   5. falha depois da conta criada não deixa órfão: a conta é removida, e o
 *      e-mail volta a poder ser usado.
 *
 * NÃO MEDIDO aqui: um login real contra o GoTrue. O dublê prova o CONTRATO
 * (`password` + `email_confirm`), não o serviço de auth — a mesma fronteira que
 * os outros testes de auth deste repositório declaram.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  audit: vi.fn(async (_entrada: Record<string, unknown>) => {}),
  warn: vi.fn(),
  error: vi.fn(),
  role: vi.fn(),
  criarUser: vi.fn(),
  apagarUser: vi.fn(),
  rpc: vi.fn(),
  limite: vi.fn(async (): Promise<number | null> => null),
  admin: null as unknown,
  tabelas: [] as string[],
}));

vi.mock("@/lib/audit", () => ({
  audit: h.audit,
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: h.warn, error: h.error, info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/cobranca/limites", () => ({
  lerLimiteDoPlano: h.limite,
  mensagemDoLimite: (recurso: string, limite: number) =>
    recurso === "assentos" ? `Seu plano permite ${limite} pessoas.` : `Limite de ${recurso}: ${limite}.`,
}));

import { criarMembroComSenha } from "@/lib/auth/criar-membro";
import { resetPasswordSchema } from "@/lib/auth/schemas";
import { POST } from "@/app/api/v1/team/users/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMIN_ATUAL = "admin-1";
const SENHA = "Senha-forte-1";

/** O que o GoTrue devolve num `createUser` que deu certo. */
const CONTA = { user: { id: "user-9", email: "nova@x.test" } };

function adminFake(o: {
  criar?: () => unknown;
  vinculo?: () => unknown;
  membros?: Array<{ user_id: string; provisional_until_handover: boolean }>;
}) {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    is: async () => ({ data: o.membros ?? [], error: null }),
  };
  return {
    from: (tabela: string) => {
      h.tabelas.push(tabela);
      return cadeia;
    },
    rpc: h.rpc,
    auth: {
      admin: {
        createUser: h.criarUser,
        deleteUser: h.apagarUser,
      },
    },
  };
}

const entrada = (extra: Partial<Parameters<typeof criarMembroComSenha>[0]> = {}) => ({
  admin: h.admin as never,
  organizationId: ORG,
  email: "nova@x.test",
  password: SENHA,
  role: "agent" as const,
  fullName: "Nova Pessoa",
  actorId: ADMIN_ATUAL,
  requestId: "req-1",
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.tabelas.length = 0;
  h.limite.mockResolvedValue(null);
  h.criarUser.mockResolvedValue({ data: CONTA, error: null });
  h.apagarUser.mockResolvedValue({ data: {}, error: null });
  h.rpc.mockResolvedValue({ data: { id: "memb-1", changed: true }, error: null });
  h.role.mockResolvedValue({
    ok: true,
    user: { id: ADMIN_ATUAL, email: "admin@x.test", full_name: "Admin", idioma: "pt-BR" },
    org: { orgId: ORG, name: "Empresa" },
  });
  h.admin = adminFake({});
});

describe("criarMembroComSenha — o caminho", () => {
  it("⭐ a conta nasce com a senha do admin, já confirmada, e o vínculo no mesmo ato", async () => {
    const r = await criarMembroComSenha(entrada());

    expect(r).toEqual({ ok: true, user_id: "user-9", membership_id: "memb-1" });

    expect(h.criarUser).toHaveBeenCalledTimes(1);
    expect(h.criarUser.mock.calls[0]![0]).toEqual({
      email: "nova@x.test",
      password: SENHA,
      email_confirm: true,
      user_metadata: { full_name: "Nova Pessoa" },
    });

    // A MESMA função do aceite de convite, com os SETE parâmetros: os de seis
    // descartariam o perfil de interface escolhido.
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = h.rpc.mock.calls[0]! as [string, Record<string, string>];
    expect(fn).toBe("fn_accept_team_invite");
    expect(args).toMatchObject({
      p_user: "user-9",
      p_org: ORG,
      p_role: "agent",
      p_invited_by: ADMIN_ATUAL,
    });
    // `accepted_at` é carimbado pelo banco; os dois carimbos daqui são "agora",
    // e iguais — não há convite esperando aceite.
    expect(args.p_issued_at).toBe(args.p_invited_at);
    expect(Math.abs(Date.parse(args.p_issued_at!) - Date.now())).toBeLessThan(5_000);
  });

  it("nenhum convite pendente é criado — a criação não toca em team_invites", async () => {
    await criarMembroComSenha(entrada());

    expect(h.tabelas).not.toContain("team_invites");
    // E nem um INSERT em tabela nenhuma: o vínculo é do RPC, não desta função.
    expect(h.tabelas).toEqual([]);
  });

  it("audita QUEM criou QUEM, com o caminho pelo qual o acesso nasceu", async () => {
    await criarMembroComSenha(entrada());

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0]![0]).toMatchObject({
      action: "member.created",
      actorUserId: ADMIN_ATUAL,
      organizationId: ORG,
      resourceType: "membership",
      resourceId: "memb-1",
      requestId: "req-1",
      metadata: { email: "nova@x.test", role: "agent", via: "senha_do_administrador" },
    });
  });

  it("⭐ a senha NÃO aparece no audit, no log nem no retorno", async () => {
    const r = await criarMembroComSenha(entrada());

    const rastro = JSON.stringify({
      auditoria: h.audit.mock.calls,
      avisos: h.warn.mock.calls,
      erros: h.error.mock.calls,
      retorno: r,
    });
    expect(rastro).not.toContain(SENHA);
    expect(rastro).not.toContain("password");
  });

  it("sem nome, o metadado do usuário não é inventado", async () => {
    await criarMembroComSenha(entrada({ fullName: null }));

    expect(h.criarUser.mock.calls[0]![0]).not.toHaveProperty("user_metadata");
  });
});

describe("criarMembroComSenha — a régua de senha é a do fluxo atual", () => {
  it.each([
    ["curta", "Ab1!efg"],
    ["sem letra", "12345678!"],
    ["sem número", "abcdefgh!"],
    ["sem símbolo", "Abcdefg12"],
  ])("⭐ senha %s é recusada com a MESMA frase da redefinição de senha", async (_nome, senha) => {
    const r = await criarMembroComSenha(entrada({ password: senha }));

    // A régua do fluxo ATUAL, aplicada ao mesmo valor: a frase tem de coincidir.
    const doFluxoAtual = resetPasswordSchema.safeParse({
      password: senha,
      password_confirm: senha,
    });
    expect(doFluxoAtual.success).toBe(false);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("senha_fraca");
    expect(r.detalhe).toBe(doFluxoAtual.error!.issues[0]!.message);

    // Recusa ANTES de qualquer escrita: sem conta órfã, sem vínculo, sem trilha.
    expect(h.criarUser).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("a senha válida do fluxo atual passa aqui — mesma régua, mesmo veredito", async () => {
    expect(resetPasswordSchema.safeParse({ password: SENHA, password_confirm: SENHA }).success).toBe(true);
    expect((await criarMembroComSenha(entrada())).ok).toBe(true);
  });
});

describe("criarMembroComSenha — falhas não deixam órfão", () => {
  it("e-mail que já tem conta: recusa nomeada, e nada é criado", async () => {
    h.criarUser.mockResolvedValue({
      data: { user: null },
      error: { code: "email_exists", message: "A user with this email address has already been registered" },
    });

    const r = await criarMembroComSenha(entrada());

    expect(r).toEqual({ ok: false, motivo: "email_em_uso" });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("plano cheio (PT402): desfaz a conta e devolve o motivo do teto", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "PT402", message: "teto de assentos" } });

    const r = await criarMembroComSenha(entrada());

    expect(r).toEqual({ ok: false, motivo: "limite_do_plano" });
    expect(h.apagarUser).toHaveBeenCalledWith("user-9");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("vínculo que falha por outro motivo: desfaz a conta e não audita sucesso", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    const r = await criarMembroComSenha(entrada());

    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(h.apagarUser).toHaveBeenCalledWith("user-9");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("RPC sem linha e sem erro não vira sucesso", async () => {
    h.rpc.mockResolvedValue({ data: null, error: null });

    const r = await criarMembroComSenha(entrada());

    expect(r).toEqual({ ok: false, motivo: "internal_error" });
    expect(h.apagarUser).toHaveBeenCalledWith("user-9");
  });
});

describe("POST /api/v1/team/users — a porta", () => {
  const pedido = (corpo: Record<string, unknown> = {}) =>
    new NextRequest("http://localhost/api/v1/team/users", {
      method: "POST",
      body: JSON.stringify({ email: "nova@x.test", password: SENHA, role: "agent", ...corpo }),
    });

  const DOIS_ATIVOS = [
    { user_id: "u1", provisional_until_handover: false },
    { user_id: "u2", provisional_until_handover: false },
  ];

  it("⭐ 201 com os identificadores — e a SENHA não volta no corpo", async () => {
    h.admin = adminFake({});
    const res = await POST(pedido());
    const bruto = await res.text();

    expect(res.status).toBe(201);
    expect(bruto).not.toContain(SENHA);
    expect(bruto).not.toContain("password");
    expect(JSON.parse(bruto)).toEqual({
      data: { user_id: "user-9", membership_id: "memb-1", email: "nova@x.test" },
    });
  });

  it("senha fraca: 422 na PORTA, com a frase do fluxo atual, e nenhuma conta criada", async () => {
    h.admin = adminFake({});
    const senha = "12345678";
    const res = await POST(pedido({ password: senha }));
    const body = await res.json();
    const doFluxoAtual = resetPasswordSchema.safeParse({ password: senha, password_confirm: senha });

    // A recusa acontece na validação do corpo — o MESMO `senhaDoAcesso` do
    // fluxo de redefinição —, e a frase que a tela exibe é a mesma daquele
    // fluxo, letra por letra.
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.fieldErrors.password[0]).toBe(
      doFluxoAtual.error!.issues[0]!.message,
    );
    expect(h.criarUser).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(senha);
  });

  it("plano cheio: 409 plan_limit_reached antes de criar a conta", async () => {
    h.admin = adminFake({ membros: DOIS_ATIVOS });
    h.limite.mockResolvedValue(2);

    const res = await POST(pedido());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("plan_limit_reached");
    expect(body.error.message).toContain("Seu plano permite 2 pessoas");
    expect(h.criarUser).not.toHaveBeenCalled();
  });

  it("com vaga, a pessoa é criada (controle positivo)", async () => {
    h.admin = adminFake({ membros: DOIS_ATIVOS });
    h.limite.mockResolvedValue(3);

    expect((await POST(pedido())).status).toBe(201);
    expect(h.criarUser).toHaveBeenCalledTimes(1);
  });
});
