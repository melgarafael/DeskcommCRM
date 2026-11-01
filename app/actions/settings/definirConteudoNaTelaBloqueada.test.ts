/**
 * A gravação do que aparece com a tela bloqueada (settings.notificacoes).
 *
 * O que se prova: só admin grava, o org vem da sessão, o merge do jsonb
 * preserva o resto, a troca audita com anterior/novo, e regravar o mesmo valor
 * não escreve nem audita.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
  supportWriteError: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: mocks.loadAuthUser,
  resolveActiveOrg: mocks.resolveActiveOrg,
  mfaEmDivida: mocks.mfaEmDivida,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: mocks.supportWriteError }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { definirConteudoNaTelaBloqueada } from "./definirConteudoNaTelaBloqueada";

const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
const ORG = "11111111-1111-4111-8111-111111111111";

const SETTINGS_ATUAL = {
  security: { mfa_required: true },
  routing: { mode: "round_robin" },
  notificacoes: { outra: 1 },
};

function adminQueGrava() {
  const gravado = { updates: [] as Array<{ payload: unknown; id: unknown }>, leituras: [] as unknown[] };
  const admin = {
    from(table: string) {
      expect(table).toBe("organizations");
      let payload: unknown = null;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (p: unknown) => {
        payload = p;
        return b;
      };
      b.eq = (_col: string, id: unknown) => {
        if (payload !== null) {
          gravado.updates.push({ payload, id });
          return Promise.resolve({ error: null });
        }
        gravado.leituras.push(id);
        return b;
      };
      b.maybeSingle = async () => ({ data: { settings: structuredClone(SETTINGS_ATUAL) }, error: null });
      return b;
    },
  };
  return { admin, gravado };
}

let fake: ReturnType<typeof adminQueGrava>;

beforeEach(() => {
  vi.clearAllMocks();
  fake = adminQueGrava();
  mocks.createAdminClient.mockReturnValue(fake.admin);
  mocks.loadAuthUser.mockResolvedValue(USER);
  mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role: "admin" });
  mocks.mfaEmDivida.mockResolvedValue(false);
  mocks.supportWriteError.mockReturnValue(null);
});

describe("definirConteudoNaTelaBloqueada", () => {
  it("valor fora do enum é recusado sem tocar no banco", async () => {
    expect(await definirConteudoNaTelaBloqueada("tudo" as never)).toEqual({ ok: false, erro: "invalido" });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it.each(["viewer", "agent", "manager"])("%s é recusado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role });
    expect(await definirConteudoNaTelaBloqueada("oculto")).toEqual({ ok: false, erro: "sem_permissao" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("acompanhamento somente leitura é recusado", async () => {
    mocks.supportWriteError.mockReturnValue("somente leitura");
    expect(await definirConteudoNaTelaBloqueada("oculto")).toEqual({ ok: false, erro: "somente_leitura" });
  });

  it("sem sessão e sem empresa", async () => {
    mocks.loadAuthUser.mockResolvedValueOnce(null);
    expect(await definirConteudoNaTelaBloqueada("oculto")).toEqual({ ok: false, erro: "sessao" });
    mocks.resolveActiveOrg.mockResolvedValueOnce(null);
    expect(await definirConteudoNaTelaBloqueada("oculto")).toEqual({ ok: false, erro: "sem_empresa" });
  });

  it("verificação em duas etapas pendente é recusada", async () => {
    mocks.mfaEmDivida.mockResolvedValue(true);
    expect(await definirConteudoNaTelaBloqueada("oculto")).toEqual({ ok: false, erro: "mfa" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("mesmo valor do vigente (o padrão 'nome'): sem escrita e sem audit", async () => {
    expect(await definirConteudoNaTelaBloqueada("nome")).toEqual({ ok: true, valor: "nome", mudou: false });
    expect(fake.gravado.updates).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("valor novo: grava no org da sessão preservando o resto, audita e revalida", async () => {
    expect(await definirConteudoNaTelaBloqueada("oculto")).toEqual({ ok: true, valor: "oculto", mudou: true });
    expect(fake.gravado.leituras).toEqual([ORG]);
    expect(fake.gravado.updates).toEqual([
      {
        id: ORG,
        payload: {
          settings: {
            security: { mfa_required: true },
            routing: { mode: "round_robin" },
            notificacoes: { outra: 1, conteudo_na_tela_bloqueada: "oculto" },
          },
        },
      },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notificacoes.tela_bloqueada_alterada",
        actorUserId: USER.id,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
        metadata: { anterior: "nome", novo: "oculto" },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/settings/notifications");
  });
});
