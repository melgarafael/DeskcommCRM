import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerCtx } from "@/lib/api/handlers/types";

const auditSpy = vi.fn(async () => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CONTATO = "c05e7a00-0000-4000-8000-0000000000c1";
const USUARIO = "c05e7a00-0000-4000-8000-0000000000a1";

/** A função da transação única (migration 0488) — a ÚNICA escrita da rota. */
const FUNCAO = "fn_apagar_contato_com_historico";

const chamadas: Array<{ tabela: string; op: string }> = [];
const contagens: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
const rpcs: Array<{ nome: string; args: Record<string, unknown> | undefined }> = [];

interface CadeiaContagem {
  eq: (coluna: string, valor: unknown) => CadeiaContagem;
  maybeSingle: () => Promise<{ data: null; error: null }>;
  then: (resolve: (valor: unknown) => unknown) => unknown;
}

interface OpcoesFake {
  missing?: boolean;
  /** Quantos vínculos RESTRICT a pré-checagem encontra na agenda. */
  vinculos?: number;
  /** A contagem do vínculo falha (tabela/RLS fora do ar). */
  erroContagem?: { message: string };
  /** A função nova devolve erro (23503 de corrida, 42501 residual, 500…). */
  rpcErro?: { code?: string; message: string };
  /** A função devolve false: a ficha não estava acessível para quem chamou. */
  rpcFalse?: boolean;
}

function clienteFalso(opts?: OpcoesFake): unknown {
  return {
    from: (tabela: string) => {
      const del = {
        eq: () => del,
        select: () => del,
        maybeSingle: async () => ({
          data: opts?.missing ? null : { id: CONTATO, organization_id: ORG },
          error: null,
        }),
        then: (r: (v: unknown) => unknown) => r({ error: null }),
      };
      return {
        // `select("id", {count, head})` é a pré-checagem de vínculo: só conta.
        select: (_colunas?: string, opcoes?: { count?: string; head?: boolean }) => {
          if (opcoes?.count) {
            const filtros: Array<[string, unknown]> = [];
            const cadeia: CadeiaContagem = {
              eq: (coluna, valor) => {
                filtros.push([coluna, valor]);
                return cadeia;
              },
              maybeSingle: async () => ({ data: null, error: null }),
              then: (resolve) => {
                contagens.push({ tabela, filtros });
                return resolve(
                  opts?.erroContagem
                    ? { count: null, error: opts.erroContagem }
                    : { count: opts?.vinculos ?? 0, error: null },
                );
              },
            };
            return cadeia;
          }
          return {
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  opts?.missing
                    ? { data: null, error: null }
                    : { data: { id: CONTATO, organization_id: ORG }, error: null },
              }),
            }),
          };
        },
        // A rota NÃO apaga tabela nenhuma por conta própria (issue #1862).
        delete: () => {
          chamadas.push({ tabela, op: "delete" });
          return del;
        },
      };
    },
    rpc: (nome: string, args?: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      if (nome !== FUNCAO) return Promise.resolve({ data: null, error: null });
      if (opts?.rpcErro) return Promise.resolve({ data: null, error: opts.rpcErro });
      return Promise.resolve({ data: opts?.rpcFalse ? false : true, error: null });
    },
  };
}

function ctxFalso(): HandlerCtx {
  return { organization_id: ORG, actor: { type: "user", id: USUARIO }, requestId: "req-1" };
}

function ultimaAuditoria(): Record<string, unknown> | undefined {
  return (auditSpy.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined)?.[0];
}

describe("deleteContactHandler", () => {
  beforeEach(() => {
    auditSpy.mockClear();
    chamadas.length = 0;
    contagens.length = 0;
    rpcs.length = 0;
  });

  it("apaga a ficha inteira com UMA chamada de função — nenhuma tabela apagada pela rota", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    const out = await deleteContactHandler(clienteFalso() as never, ctxFalso(), CONTATO);
    expect(out).toEqual({ id: CONTATO });

    // O conserto da #1862: um só chamado, com a organização explícita. Os três
    // DELETE separados da versão antiga eram o que deixava histórico órfão.
    expect(chamadas).toEqual([]);
    expect(rpcs.filter((r) => r.nome === FUNCAO)).toEqual([
      { nome: FUNCAO, args: { p_contact_id: CONTATO, p_organization_id: ORG } },
    ]);

    // A pré-checagem da #752 continua contando com os DOIS filtros (contato +
    // organização): sem o de organização, contato de outra org bloquearia.
    expect(contagens).toEqual([
      {
        tabela: "calendar_appointments",
        filtros: [
          ["contact_id", CONTATO],
          ["organization_id", ORG],
        ],
      },
    ]);
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.deleted",
      resourceId: CONTATO,
      organizationId: ORG,
    });
  });

  it("contato com compromisso na agenda: 409 e a função nem é chamada (issue #752)", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(clienteFalso({ vinculos: 1 }) as never, ctxFalso(), CONTATO),
    ).rejects.toMatchObject({
      status: 409,
      code: "state_conflict",
      // #1925: o 409 entrega o QUE barrou em `details.vinculos`, para a tela
      // montar a frase e o link para a Agenda em vez do texto genérico fixo.
      details: {
        vinculos: ["1 compromisso(s) na agenda"],
        por_tabela: { calendar_appointments: 1 },
      },
    });
    // O ponto da issue: nada foi apagado antes de saber que a ficha não sai.
    expect(chamadas).toEqual([]);
    expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
    expect(auditSpy).not.toHaveBeenCalledWith(expect.objectContaining({ action: "contact.deleted" }));
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.delete_blocked",
      resourceId: CONTATO,
      organizationId: ORG,
      metadata: { motivo: "vinculo_restrict", vinculos: ["1 compromisso(s) na agenda"], apagados: [] },
    });
  });

  it("a função falha: audita apagados VAZIO e propaga o 409 (nada saiu pela metade)", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(
        clienteFalso({ rpcErro: { code: "23503", message: "fk" } }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({ status: 409, code: "state_conflict" });
    // Uma transação só: a falha da função desfaz tudo, então `apagados` é vazio
    // — e não mais "chegou até messages/conversations" (era o rastro do #1862).
    expect(chamadas).toEqual([]);
    expect(ultimaAuditoria()).toMatchObject({
      action: "contact.delete_blocked",
      resourceId: CONTATO,
      metadata: { motivo: "falha_ao_apagar", vinculos: [], apagados: [] },
    });
  });

  it("erro que não é RESTRICT vira 500, ainda sem tocar em tabela", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(
        clienteFalso({ rpcErro: { code: "42501", message: "followup_job_internal" } }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(chamadas).toEqual([]);
  });

  it("falha ao contar o vínculo não segue apagando o histórico", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(
        clienteFalso({ erroContagem: { message: "contagem fora do ar" } }) as never,
        ctxFalso(),
        CONTATO,
      ),
    ).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(chamadas).toEqual([]);
    expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
  });

  it("a função devolve false (ficha inacessível): 404 sem auditar exclusão", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(clienteFalso({ rpcFalse: true }) as never, ctxFalso(), CONTATO),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(auditSpy).not.toHaveBeenCalledWith(expect.objectContaining({ action: "contact.deleted" }));
  });

  it("404 se o contato não existe na org", async () => {
    const { deleteContactHandler } = await import("@/app/api/v1/contacts/_handler");
    await expect(
      deleteContactHandler(clienteFalso({ missing: true }) as never, ctxFalso(), CONTATO),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(rpcs.some((r) => r.nome === FUNCAO)).toBe(false);
  });
});
