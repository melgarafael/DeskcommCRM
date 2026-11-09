/**
 * Vínculos B2B pela tela (issue #3198, fatia 1).
 *
 * O servidor já ligava pessoa ↔ empresa (POST company-people) e contato ↔
 * pessoa (PATCH contacts/:id/person); faltavam DESFAZER o primeiro e LER o
 * segundo a partir do contato. Cobrimos:
 *
 *   1. `unlinkCompanyPersonHandler` apaga só a linha da junção, filtrada pela
 *      organização ATIVA e pelo id, audita `company_people.unlinked` com os dois
 *      ids — e responde 404 quando a linha não é desta organização.
 *   2. `getContactPersonHandler` devolve `person: null` para o contato que
 *      chegou pelo WhatsApp (person_id nulo) sem consultar `people`, e a pessoa
 *      com as empresas quando há vínculo; 404 para contato de outra organização.
 *   3. A porta do módulo: com "Empresas e pessoas" DESLIGADO, o DELETE e o GET
 *      novos respondem 404 antes de olhar papel ou banco — o mesmo contrato das
 *      rotas B2B que já existiam.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ modulo: true }));

vi.mock("@/lib/instalacao/modulos", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  moduloLigado: vi.fn(async () => estado.modulo),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NextRequest } from "next/server";

import { DELETE as deleteVinculo } from "@/app/api/v1/company-people/[id]/route";
import { GET as getPessoaDoContato } from "@/app/api/v1/contacts/[id]/person/route";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import {
  getContactPersonHandler,
  unlinkCompanyPersonHandler,
} from "@/lib/crm-b2b/people-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const VINCULO = "22222222-2222-4222-8222-222222222222";
const EMPRESA = "33333333-3333-4333-8333-333333333333";
const PESSOA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";

const CTX: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "u-1", role: "manager" },
  requestId: "req-test",
  idioma: "pt-BR",
};

type Resposta = { data: unknown; error: unknown };

/**
 * Banco falso: cada tabela devolve a resposta configurada e registra a
 * operação e os filtros `eq` que recebeu.
 */
function bancoFalso(respostas: Record<string, Resposta | Resposta[]>) {
  const chamadas: Array<{
    tabela: string;
    op: string;
    eq: Array<[string, unknown]>;
    is?: Array<[string, unknown]>;
    order?: string[];
  }> = [];
  const filas = Object.fromEntries(
    Object.entries(respostas).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  const from = (tabela: string) => {
    const registro: (typeof chamadas)[number] = { tabela, op: "select", eq: [] };
    chamadas.push(registro);
    const proxima = (): Resposta => {
      const fila = filas[tabela];
      if (!fila || fila.length === 0) throw new Error(`tabela inesperada: ${tabela}`);
      return fila.length > 1 ? fila.shift()! : fila[0]!;
    };
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.delete = () => {
      registro.op = "delete";
      return q;
    };
    q.eq = (col: string, val: unknown) => {
      registro.eq.push([col, val]);
      return q;
    };
    q.is = (col: string, val: unknown) => {
      (registro.is ??= []).push([col, val]);
      return q;
    };
    q.order = (col: string) => {
      (registro.order ??= []).push(col);
      return q;
    };
    q.maybeSingle = async () => proxima();
    // `await q` direto (lista de vínculos) usa o `then`.
    q.then = (resolve: (r: Resposta) => unknown) => resolve(proxima());
    return q;
  };
  return { cliente: { from } as never, chamadas };
}

async function codigoDoErro(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e.status;
    throw e;
  }
  throw new Error("esperava ApiError");
}

beforeEach(() => {
  estado.modulo = true;
  vi.mocked(audit).mockClear();
  vi.mocked(requireRole).mockReset();
  vi.mocked(logger.error).mockClear();
});

describe("unlinkCompanyPersonHandler — desfazer pessoa ↔ empresa", () => {
  it("⭐ apaga a linha da junção desta organização e audita com os dois ids", async () => {
    const { cliente, chamadas } = bancoFalso({
      company_people: { data: { id: VINCULO, company_id: EMPRESA, person_id: PESSOA }, error: null },
    });

    const r = await unlinkCompanyPersonHandler(cliente, CTX, "u-1", VINCULO);

    expect(r).toEqual({ id: VINCULO, company_id: EMPRESA, person_id: PESSOA });
    expect(chamadas).toEqual([
      {
        tabela: "company_people",
        op: "delete",
        eq: [
          ["organization_id", ORG],
          ["id", VINCULO],
        ],
      },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "company_people.unlinked",
        resourceId: VINCULO,
        metadata: { company_id: EMPRESA, person_id: PESSOA },
      }),
    );
  });

  it("404 quando o vínculo não é desta organização (nada apagado, nada auditado)", async () => {
    const { cliente } = bancoFalso({ company_people: { data: null, error: null } });
    expect(await codigoDoErro(unlinkCompanyPersonHandler(cliente, CTX, "u-1", VINCULO))).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("500 quando o banco recusa", async () => {
    const { cliente } = bancoFalso({
      company_people: { data: null, error: { message: "boom" } },
    });
    expect(await codigoDoErro(unlinkCompanyPersonHandler(cliente, CTX, "u-1", VINCULO))).toBe(500);
  });
});

describe("getContactPersonHandler — de quem é este telefone", () => {
  it("⭐ contato sem pessoa (o lead do WhatsApp) devolve null sem consultar people", async () => {
    const { cliente, chamadas } = bancoFalso({
      contacts: { data: { id: CONTATO, person_id: null }, error: null },
    });
    const r = await getContactPersonHandler(cliente, CTX, CONTATO);
    expect(r).toEqual({ person: null, companies: [] });
    expect(chamadas.map((c) => c.tabela)).toEqual(["contacts"]);
    expect(chamadas[0]!.eq).toContainEqual(["organization_id", ORG]);
  });

  it("contato ligado devolve a pessoa e as empresas dela", async () => {
    const pessoa = { id: PESSOA, full_name: "Ana Diretora", email: null };
    const vinculos = [
      {
        id: VINCULO,
        job_title: "Diretora financeira",
        is_decision_maker: true,
        companies: { id: EMPRESA, trade_name: "Família S.A.", legal_name: null },
      },
    ];
    const { cliente } = bancoFalso({
      contacts: { data: { id: CONTATO, person_id: PESSOA }, error: null },
      people: { data: pessoa, error: null },
      company_people: { data: vinculos, error: null },
    });
    const r = await getContactPersonHandler(cliente, CTX, CONTATO);
    expect(r).toEqual({ person: pessoa, companies: vinculos });
  });

  it("⭐ lê só contato vivo: a lápide de fusão não mostra a pessoa do perdedor", async () => {
    const { cliente, chamadas } = bancoFalso({ contacts: { data: null, error: null } });
    expect(await codigoDoErro(getContactPersonHandler(cliente, CTX, CONTATO))).toBe(404);
    expect(chamadas[0]!.is).toContainEqual(["is_merged_into", null]);
  });

  it("⭐ as empresas do cartão vêm em ordem estável (criação, depois id)", async () => {
    const { cliente, chamadas } = bancoFalso({
      contacts: { data: { id: CONTATO, person_id: PESSOA }, error: null },
      people: { data: { id: PESSOA, full_name: "Ana", email: null }, error: null },
      company_people: { data: [], error: null },
    });
    await getContactPersonHandler(cliente, CTX, CONTATO);
    const vinculos = chamadas.find((c) => c.tabela === "company_people")!;
    expect(vinculos.order).toEqual(["created_at", "id"]);
  });

  it("404 quando o contato não é desta organização", async () => {
    const { cliente } = bancoFalso({ contacts: { data: null, error: null } });
    expect(await codigoDoErro(getContactPersonHandler(cliente, CTX, CONTATO))).toBe(404);
  });
});

describe("porta do módulo nas rotas novas", () => {
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("⭐ módulo desligado: DELETE company-people/:id responde 404 sem checar papel", async () => {
    estado.modulo = false;
    const res = await deleteVinculo(
      new NextRequest(`http://localhost/api/v1/company-people/${VINCULO}`, { method: "DELETE" }),
      params(VINCULO),
    );
    expect(res.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("⭐ módulo desligado: GET contacts/:id/person responde 404 sem checar papel", async () => {
    estado.modulo = false;
    const res = await getPessoaDoContato(
      new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/person`),
      params(CONTATO),
    );
    expect(res.status).toBe(404);
    expect(requireRole).not.toHaveBeenCalled();
  });

  it("módulo ligado: o DELETE pede `manager`, o mesmo piso do POST e da RLS", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await deleteVinculo(
      new NextRequest(`http://localhost/api/v1/company-people/${VINCULO}`, { method: "DELETE" }),
      params(VINCULO),
    );
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "company_people" }));
  });
});

describe("createPersonHandler — pessoa criada já ligada à empresa", () => {
  it("⭐ vínculo recusado desfaz a pessoa: o 'tentar de novo' não duplica", async () => {
    const { createPersonHandler } = await import("@/lib/crm-b2b/people-handler");
    const operacoes: string[] = [];
    const cliente = {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {};
        q.insert = () => {
          operacoes.push(`${tabela}.insert`);
          if (tabela === "company_people") {
            return Promise.resolve({ error: { code: "P0001", message: "empresa de outra organização" } });
          }
          return q;
        };
        q.select = () => q;
        q.single = async () => ({ data: { id: PESSOA }, error: null });
        q.delete = () => {
          operacoes.push(`${tabela}.delete`);
          return q;
        };
        q.eq = () => q;
        q.then = (resolve: (r: Resposta) => unknown) => resolve({ data: null, error: null });
        return q;
      },
    } as never;

    expect(
      await codigoDoErro(
        createPersonHandler(cliente, CTX, "u-1", { full_name: "Ana", company_id: EMPRESA }),
      ),
    ).toBe(422);
    expect(operacoes).toEqual(["people.insert", "company_people.insert", "people.delete"]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("⭐ se o desfazer também falha, o log registra o id da pessoa que sobrou", async () => {
    const { createPersonHandler } = await import("@/lib/crm-b2b/people-handler");
    const cliente = {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {};
        q.insert = () =>
          tabela === "company_people"
            ? Promise.resolve({ error: { code: "P0001", message: "empresa de outra organização" } })
            : q;
        q.select = () => q;
        q.single = async () => ({ data: { id: PESSOA }, error: null });
        q.delete = () => q;
        q.eq = () => q;
        q.then = (resolve: (r: Resposta) => unknown) =>
          resolve({ data: null, error: { code: "57014", message: "timeout" } });
        return q;
      },
    } as never;

    expect(
      await codigoDoErro(
        createPersonHandler(cliente, CTX, "u-1", { full_name: "Ana", company_id: EMPRESA }),
      ),
    ).toBe(422);
    expect(logger.error).toHaveBeenCalledWith(
      "people.create_rollback_failed",
      expect.objectContaining({ organization_id: ORG, person_id: PESSOA, code: "57014" }),
    );
  });
});

describe("listPeopleHandler — a lista mostra os e-mails dos contatos", () => {
  it("⭐ junta o e-mail da ficha com os dos contatos ligados, sem repetir", async () => {
    const { listPeopleHandler } = await import("@/lib/crm-b2b/people-handler");
    const filtrosDeContatos: Array<[string, ...unknown[]]> = [];
    const cliente = {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "order", "limit"]) q[m] = () => q;
        for (const m of ["eq", "in", "not", "is"]) {
          q[m] = (...args: unknown[]) => {
            if (tabela === "contacts") filtrosDeContatos.push([m, ...args]);
            return q;
          };
        }
        q.then = (resolve: (r: Resposta) => unknown) =>
          resolve(
            tabela === "people"
              ? {
                  data: [
                    { id: "p-w", email: null },
                    { id: "p-a", email: "Ana@Familia.test" },
                  ],
                  error: null,
                }
              : {
                  data: [
                    { person_id: "p-w", email: "william@a.test" },
                    { person_id: "p-w", email: "william@b.test" },
                    { person_id: "p-a", email: "ana@familia.test" },
                  ],
                  error: null,
                },
          );
        return q;
      },
    } as never;

    const r = await listPeopleHandler(cliente, CTX);
    expect(r.people.map((p) => (p as { emails: string[] }).emails)).toEqual([
      ["william@a.test", "william@b.test"],
      ["Ana@Familia.test"],
    ]);
    // Só desta organização, só dos listados, sem os mesclados.
    expect(filtrosDeContatos).toContainEqual(["eq", "organization_id", ORG]);
    expect(filtrosDeContatos).toContainEqual(["in", "person_id", ["p-w", "p-a"]]);
    expect(filtrosDeContatos).toContainEqual(["is", "is_merged_into", null]);
  });
});
