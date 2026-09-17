/**
 * A ACTION QUE LIGA "CLIENTES PELA AGENDA" — o que o Postgres não vê.
 *
 * Quem decide é o corpo de `fn_definir_cliente_pela_agenda`, provado em
 * `tests/invariants/cliente-nasce-do-agendamento.test.ts`. Aqui ficam as três
 * coisas da action que nenhum banco enxerga:
 *
 *   1. a organização vem da SESSÃO (`resolveActiveOrg`), nunca de argumento;
 *   2. quem não é admin, ou está em suporte somente leitura, nem chega à RPC;
 *   3. a auditoria sai só quando algo mudou, com as contagens, e o layout é
 *      invalidado — é por ele que selo, data e funil de clientes enxergam a
 *      regra nova.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";

let papel = "admin";
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
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: USER, is_platform_admin: false, support: suporte })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Clínica", role: papel })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: (nome: string, args: Record<string, unknown>) => rpc(nome, args) }),
}));

const { definirClientePelaAgenda } = await import("@/app/actions/settings/definirClientePelaAgenda");

const LIGOU = {
  ligado: true,
  mudou: true,
  ganharam_etiqueta: 3,
  perderam_etiqueta: 0,
  clientes: 3,
  com_agendamento_que_nao_conta: 0,
};

beforeEach(() => {
  papel = "admin";
  suporte = null;
  respostaDaRpc = { data: LIGOU, error: null };
  rpc.mockClear();
  revalidatePath.mockClear();
  auditadas.length = 0;
});

describe("definirClientePelaAgenda", () => {
  it.each(["manager", "agent", "viewer"])("%s → sem_permissao, e a RPC NÃO é chamada", async (p) => {
    papel = p;
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "sem_permissao" });
    expect(rpc).not.toHaveBeenCalled();
    expect(auditadas).toEqual([]);
  });

  it("suporte somente leitura → somente_leitura, e a RPC não é chamada", async () => {
    suporte = {
      id: "s",
      organization_id: ORG,
      actor_user_id: USER,
      auth_session_id: "a",
      previous_organization_id: null,
      expires_at: "2099-01-01",
      name: "Clínica",
      locale: null,
      access_mode: "support_readonly",
      status: "active",
    };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "somente_leitura" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("admin → a RPC recebe a organização DA SESSÃO", async () => {
    await definirClientePelaAgenda(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_definir_cliente_pela_agenda", { p_org: ORG, p_ligado: true });
  });

  it("entrada que não é booleano (a action é endpoint público) não chega à RPC", async () => {
    const qualquer: unknown = "true";
    expect(await definirClientePelaAgenda(qualquer as boolean)).toEqual({ ok: false, erro: "falha" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("42501 com mfa_required → mfa; 42501 sem → sem_permissao; 55P03/40P01 → tente_de_novo", async () => {
    respostaDaRpc = { data: null, error: { code: "42501", message: "cliente_pela_agenda_mfa_required" } };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "mfa" });
    respostaDaRpc = { data: null, error: { code: "42501", message: "cliente_pela_agenda_forbidden" } };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "sem_permissao" });
    // O prazo de trava do papel `authenticated` (4s, migration 0243) vencido
    // esperando uma junção ou um agendamento em voo.
    respostaDaRpc = { data: null, error: { code: "55P03", message: "canceling statement due to lock timeout" } };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "tente_de_novo" });
    respostaDaRpc = { data: null, error: { code: "40P01", message: "deadlock detected" } };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "tente_de_novo" });
    expect(auditadas).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("mudou → auditoria com as contagens e o layout invalidado; devolve o corpo da RPC", async () => {
    const r = await definirClientePelaAgenda(true);
    expect(r).toEqual({ ok: true, ...LIGOU });
    expect(auditadas).toEqual([
      expect.objectContaining({
        action: "crm.cliente_pela_agenda_alterado",
        actorUserId: USER,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
        metadata: LIGOU,
      }),
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
  });

  it("mudou=false (já estava ligada) → sem auditoria", async () => {
    respostaDaRpc = { data: { ...LIGOU, mudou: false, ganharam_etiqueta: 0 }, error: null };
    const r = await definirClientePelaAgenda(true);
    expect(r).toMatchObject({ ok: true, mudou: false });
    expect(auditadas).toEqual([]);
  });

  it("corpo SEM o quarto número (banco que ainda não aplicou o apêndice) → 0, e a action não falha", async () => {
    // `com_agendamento_que_nao_conta` é novo no corpo da RPC. Exigi-lo
    // transformaria a versão antiga da função — que existe, no clone que ainda
    // não rodou o `update.sh` — em "Não consegui salvar essa mudança agora", com
    // a regra JÁ ligada no banco: o pior desfecho, porque a tela mente sobre um
    // efeito que aconteceu. O campo tem default, e a tela cai na frase antiga.
    const { com_agendamento_que_nao_conta: _, ...antigo } = LIGOU;
    respostaDaRpc = { data: antigo, error: null };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: true, ...LIGOU });
  });

  it("corpo inesperado da RPC → falha, sem auditoria", async () => {
    respostaDaRpc = { data: { ligado: "sim" }, error: null };
    expect(await definirClientePelaAgenda(true)).toEqual({ ok: false, erro: "falha" });
    expect(auditadas).toEqual([]);
  });
});
