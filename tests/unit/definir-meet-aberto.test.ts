/**
 * A ACTION QUE LIGA "GOOGLE MEET COM ACESSO ABERTO" — o que o Postgres não vê
 * (#2063, migration 0579).
 *
 * O corpo de `fn_definir_google_meet_acesso_aberto` é da própria função; aqui
 * ficam as coisas da action que nenhum banco enxerga, espelhando as duas
 * irmãs (`definirAgendaDosColegas`, `definirClientePelaAgenda`):
 *
 *   1. a organização vem da SESSÃO (`resolveActiveOrg`), nunca de argumento;
 *   2. quem não é gerente, ou está em suporte somente leitura, nem chega à RPC;
 *   3. a auditoria sai SÓ quando algo mudou, e o layout é invalidado;
 *   4. um corpo inesperado é erro — nunca sucesso silencioso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "manager";
let suporte: Record<string, unknown> | null = null;
let respostaDaRpc: { data: unknown; error: { code: string; message: string } | null } = {
  data: null,
  error: null,
};
const rpc = vi.fn(async (_nome: string, _args: Record<string, unknown>) => respostaDaRpc);
const auditadas: Array<Record<string, unknown>> = [];
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: Record<string, unknown>) => {
    auditadas.push(e);
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: false, support: suporte })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Clínica", role: papel })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args) }),
}));

const { definirMeetAberto } = await import("@/app/actions/settings/definirMeetAberto");

const LIGOU = { ligado: true, mudou: true };

beforeEach(() => {
  papel = "manager";
  suporte = null;
  respostaDaRpc = { data: LIGOU, error: null };
  rpc.mockClear();
  revalidatePath.mockClear();
  auditadas.length = 0;
});

describe("definirMeetAberto", () => {
  it.each(["agent", "viewer"])("%s → sem_permissao, e a RPC NÃO é chamada", async (p) => {
    papel = p;
    expect(await definirMeetAberto(true)).toEqual({ ok: false, erro: "sem_permissao" });
    expect(rpc).not.toHaveBeenCalled();
    expect(auditadas).toEqual([]);
  });

  it("suporte somente leitura → somente_leitura, e a RPC não é chamada", async () => {
    suporte = {
      id: "s",
      organization_id: ORG,
      actor_user_id: USER,
      granted_user_id: USER,
      mode: "read_only",
      expires_at: null,
      ended_at: null,
    };
    expect(await definirMeetAberto(true)).toEqual({ ok: false, erro: "somente_leitura" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("grava pela SESSÃO, com a organização resolvida, e audita só o que mudou", async () => {
    expect(await definirMeetAberto(true)).toEqual({ ok: true, ligado: true, mudou: true });
    expect(rpc).toHaveBeenCalledWith("fn_definir_google_meet_acesso_aberto", {
      p_org: ORG,
      p_ligado: true,
    });
    expect(auditadas).toHaveLength(1);
    expect(auditadas[0]).toMatchObject({
      action: "agenda.meet_acesso_aberto_alterado",
      organizationId: ORG,
      resourceType: "organization",
      metadata: { ligado: true, mudou: true },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });

  it("nada mudou → SEM auditoria (a action registra mudança, não aperto de botão)", async () => {
    respostaDaRpc = { data: { ligado: true, mudou: false }, error: null };
    expect(await definirMeetAberto(true)).toEqual({ ok: true, ligado: true, mudou: false });
    expect(auditadas).toEqual([]);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("MFA existente mas não comprovado → mfa, com a frase própria", async () => {
    respostaDaRpc = { data: null, error: { code: "42501", message: "mfa_required" } };
    expect(await definirMeetAberto(true)).toEqual({ ok: false, erro: "mfa" });
  });

  it("55P03 (prazo do papel vencido) → tente_de_novo: nada ficou gravado", async () => {
    respostaDaRpc = {
      data: null,
      error: { code: "55P03", message: "could not serialize access due to ..." },
    };
    expect(await definirMeetAberto(true)).toEqual({ ok: false, erro: "tente_de_novo" });
  });

  it("a RPC devolveu corpo inesperado → falha, nunca sucesso", async () => {
    respostaDaRpc = { data: { ligado: "sim" }, error: null };
    expect(await definirMeetAberto(true)).toEqual({ ok: false, erro: "falha" });
    expect(auditadas).toEqual([]);
  });

  it("parâmetro que não é booleano nem chega à RPC", async () => {
    expect(await definirMeetAberto("sim" as never)).toEqual({ ok: false, erro: "falha" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
