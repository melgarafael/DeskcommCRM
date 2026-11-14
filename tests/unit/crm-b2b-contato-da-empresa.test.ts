/**
 * Cadastro seguido pela página da empresa: pessoa + contato + vínculos numa
 * chamada só. O que importa provar:
 *   1. caminho feliz: pessoa (já ligada à empresa) → contato → vínculo, nesta ordem;
 *   2. sem telefone nem e-mail só a pessoa é criada (nenhum contato);
 *   3. empresa que não existe → 404 e NADA é criado;
 *   4. contato falha (telefone repetido) → a pessoa é DESFEITA e o erro sobe;
 *   5. vínculo contato↔pessoa falha → contato E pessoa são desfeitos;
 *   6. todo desfazer deixa rastro no audit (`*.deleted` com `reason: "rollback"`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const criarPessoa = vi.fn();
const ligarContato = vi.fn();
const criarContato = vi.fn();
vi.mock("@/lib/crm-b2b/people-handler", () => ({
  createPersonHandler: (...a: unknown[]) => criarPessoa(...a),
  linkContactToPersonHandler: (...a: unknown[]) => ligarContato(...a),
}));
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  createContactHandler: (...a: unknown[]) => criarContato(...a),
}));

// Cliente de serviço do DESFAZER: registra de qual tabela e qual id foi apagado.
const apagados: Array<{ tabela: string; id: string }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      delete: () => ({
        eq: () => ({
          eq: async (_col: string, id: string) => {
            apagados.push({ tabela, id });
            return { error: null };
          },
        }),
      }),
    }),
  }),
}));

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { createCompanyContactHandler } from "@/lib/crm-b2b/company-contact-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const EMPRESA = "22222222-2222-4222-8222-222222222222";
const CTX: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: "u-1", role: "agent" },
  requestId: "req-test",
  idioma: "pt-BR",
};

/** Cliente do usuário: só precisa responder a consulta "a empresa existe?". */
function supabaseComEmpresa(existe: boolean) {
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    maybeSingle: async () => ({ data: existe ? { id: EMPRESA } : null, error: null }),
  };
  return { from: () => consulta } as never;
}

const ENTRADA = { full_name: "Ana Souza", job_title: "Diretora", phone_number: "+5511999998888" };

beforeEach(() => {
  vi.clearAllMocks();
  apagados.length = 0;
  criarPessoa.mockResolvedValue({ id: "p-1", full_name: "Ana Souza" });
  criarContato.mockResolvedValue({ contact: { id: "c-1" }, action: "created" });
  ligarContato.mockResolvedValue({ id: "c-1", person_id: "p-1" });
});

describe("createCompanyContactHandler", () => {
  it("cria a pessoa ligada à empresa, o contato e liga os dois", async () => {
    const r = await createCompanyContactHandler(supabaseComEmpresa(true), CTX, "u-1", EMPRESA, ENTRADA);

    expect(criarPessoa).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      "u-1",
      expect.objectContaining({ full_name: "Ana Souza", company_id: EMPRESA, job_title: "Diretora" }),
    );
    expect(criarContato).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({ name: "Ana Souza", phone_number: "+5511999998888" }),
    );
    expect(ligarContato).toHaveBeenCalledWith(expect.anything(), CTX, "u-1", "c-1", "p-1");
    expect(r).toMatchObject({ company_id: EMPRESA, contact: { id: "c-1" } });
    expect(apagados).toEqual([]);
  });

  it("sem telefone nem e-mail grava só a pessoa", async () => {
    const r = await createCompanyContactHandler(supabaseComEmpresa(true), CTX, "u-1", EMPRESA, {
      full_name: "Ana Souza",
    });
    expect(criarContato).not.toHaveBeenCalled();
    expect(ligarContato).not.toHaveBeenCalled();
    expect(r.contact).toBeNull();
  });

  it("empresa inexistente: 404 e nada é criado", async () => {
    await expect(
      createCompanyContactHandler(supabaseComEmpresa(false), CTX, "u-1", EMPRESA, ENTRADA),
    ).rejects.toMatchObject({ status: 404 });
    expect(criarPessoa).not.toHaveBeenCalled();
    expect(criarContato).not.toHaveBeenCalled();
  });

  it("contato recusado (telefone repetido): desfaz a pessoa e repassa o erro", async () => {
    const conflito = new ApiError(409, "conflict", undefined, "req-test", "Telefone já cadastrado.");
    criarContato.mockRejectedValue(conflito);

    await expect(
      createCompanyContactHandler(supabaseComEmpresa(true), CTX, "u-1", EMPRESA, ENTRADA),
    ).rejects.toBe(conflito);

    expect(apagados).toEqual([{ tabela: "people", id: "p-1" }]);
    expect(ligarContato).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "people.deleted",
        resourceId: "p-1",
        metadata: expect.objectContaining({ reason: "rollback" }),
      }),
    );
  });

  it("vínculo contato↔pessoa falha: desfaz o contato e a pessoa", async () => {
    ligarContato.mockRejectedValue(new ApiError(422, "validation_failed", undefined, "req-test", "falhou"));

    await expect(
      createCompanyContactHandler(supabaseComEmpresa(true), CTX, "u-1", EMPRESA, ENTRADA),
    ).rejects.toMatchObject({ status: 422 });

    expect(apagados).toEqual([
      { tabela: "contacts", id: "c-1" },
      { tabela: "people", id: "p-1" },
    ]);
    const acoes = vi.mocked(audit).mock.calls.map(([e]) => [e.action, e.resourceId, e.metadata?.reason]);
    expect(acoes).toEqual([
      ["contact.deleted", "c-1", "rollback"],
      ["people.deleted", "p-1", "rollback"],
    ]);
  });
});
