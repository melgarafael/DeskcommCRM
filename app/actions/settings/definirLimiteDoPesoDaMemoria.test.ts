/**
 * A gravação do limite do aviso de peso da Memória da IA (settings.memoria_da_ia).
 *
 * O que se prova: a faixa é validada antes de tudo, só admin grava, o org vem
 * da sessão, o merge do jsonb preserva o resto, a troca audita com
 * anterior/novo, e regravar o valor em vigor (o recomendado, quando ausente)
 * não escreve nem audita.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIMITE_MAXIMO_DO_PESO_DA_MEMORIA,
  LIMITE_MINIMO_DO_PESO_DA_MEMORIA,
  LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA,
  limiteDoPesoDaMemoria,
} from "@/lib/schemas/settings";

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

import { definirLimiteDoPesoDaMemoria } from "./definirLimiteDoPesoDaMemoria";

const USER = { id: "00000000-0000-4000-8000-000000000001", support: null };
const ORG = "11111111-1111-4111-8111-111111111111";

const SETTINGS_ATUAL = {
  security: { mfa_required: true },
  crm: { cliente_pela_agenda: true },
  memoria_da_ia: { outra: 1 },
};

function adminQueGrava(settings: Record<string, unknown> = SETTINGS_ATUAL) {
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
      b.maybeSingle = async () => ({ data: { settings: structuredClone(settings) }, error: null });
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

describe("limiteDoPesoDaMemoria — a leitura", () => {
  it("ausente, torto ou fora da faixa é o recomendado (1.500)", () => {
    expect(LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA).toBe(1_500);
    for (const settings of [
      null,
      {},
      { memoria_da_ia: null },
      { memoria_da_ia: { limite_do_aviso_tokens: "3000" } },
      { memoria_da_ia: { limite_do_aviso_tokens: 2.5 } },
      { memoria_da_ia: { limite_do_aviso_tokens: LIMITE_MINIMO_DO_PESO_DA_MEMORIA - 1 } },
      { memoria_da_ia: { limite_do_aviso_tokens: LIMITE_MAXIMO_DO_PESO_DA_MEMORIA + 1 } },
    ]) {
      expect(limiteDoPesoDaMemoria(settings)).toBe(LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA);
    }
  });

  it("o número que a empresa escolheu vale", () => {
    expect(limiteDoPesoDaMemoria({ memoria_da_ia: { limite_do_aviso_tokens: 4_000 } })).toBe(4_000);
  });
});

describe("definirLimiteDoPesoDaMemoria", () => {
  it.each([
    LIMITE_MINIMO_DO_PESO_DA_MEMORIA - 1,
    LIMITE_MAXIMO_DO_PESO_DA_MEMORIA + 1,
    2_000.5,
    Number.NaN,
    "3000",
  ])("%s é recusado sem tocar no banco", async (valor) => {
    expect(await definirLimiteDoPesoDaMemoria(valor as never)).toEqual({ ok: false, erro: "invalido" });
    expect(mocks.loadAuthUser).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it.each(["viewer", "agent", "manager"])("%s é recusado", async (role) => {
    mocks.resolveActiveOrg.mockResolvedValue({ orgId: ORG, role });
    expect(await definirLimiteDoPesoDaMemoria(3_000)).toEqual({ ok: false, erro: "sem_permissao" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("acompanhamento somente leitura é recusado", async () => {
    mocks.supportWriteError.mockReturnValue("somente leitura");
    expect(await definirLimiteDoPesoDaMemoria(3_000)).toEqual({ ok: false, erro: "somente_leitura" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("sem sessão e sem empresa", async () => {
    mocks.loadAuthUser.mockResolvedValueOnce(null);
    expect(await definirLimiteDoPesoDaMemoria(3_000)).toEqual({ ok: false, erro: "sessao" });
    mocks.resolveActiveOrg.mockResolvedValueOnce(null);
    expect(await definirLimiteDoPesoDaMemoria(3_000)).toEqual({ ok: false, erro: "sem_empresa" });
  });

  it("verificação em duas etapas pendente é recusada", async () => {
    mocks.mfaEmDivida.mockResolvedValue(true);
    expect(await definirLimiteDoPesoDaMemoria(3_000)).toEqual({ ok: false, erro: "mfa" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("o recomendado numa empresa que nunca escolheu: sem escrita e sem audit", async () => {
    expect(await definirLimiteDoPesoDaMemoria(LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA)).toEqual({
      ok: true,
      valor: LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA,
      mudou: false,
    });
    expect(fake.gravado.updates).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("valor novo: grava no org da sessão preservando o resto, audita e revalida", async () => {
    expect(await definirLimiteDoPesoDaMemoria(3_000)).toEqual({ ok: true, valor: 3_000, mudou: true });
    expect(fake.gravado.leituras).toEqual([ORG]);
    expect(fake.gravado.updates).toEqual([
      {
        id: ORG,
        payload: {
          settings: {
            security: { mfa_required: true },
            crm: { cliente_pela_agenda: true },
            memoria_da_ia: { outra: 1, limite_do_aviso_tokens: 3_000 },
          },
        },
      },
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.org_memory_weight_limit_updated",
        actorUserId: USER.id,
        organizationId: ORG,
        resourceType: "organization",
        resourceId: ORG,
        metadata: { anterior: LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA, novo: 3_000 },
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/app/ai/memory");
  });

  it("voltar ao recomendado depois de escolher outro grava e audita", async () => {
    fake = adminQueGrava({ memoria_da_ia: { limite_do_aviso_tokens: 3_000 } });
    mocks.createAdminClient.mockReturnValue(fake.admin);
    expect(await definirLimiteDoPesoDaMemoria(LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA)).toEqual({
      ok: true,
      valor: LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA,
      mudou: true,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { anterior: 3_000, novo: LIMITE_RECOMENDADO_DO_PESO_DA_MEMORIA } }),
    );
  });
});
