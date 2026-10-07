/**
 * A tela de detalhe da empresa finalmente PROMETE o que a issue #1937 pedia:
 * editar e excluir — e os dois caminhos são verificados onde o defeito mora.
 *
 *  1. Editar: o PATCH sai com os campos revisados e com o CNPJ intacto (a issue
 *     relata o CNPJ voltando sem máscara depois de uma falha de enriquecimento;
 *     aqui garantimos que a edição devolve `33.547.054/0001-20`, não dígitos).
 *  2. Exclusão recusada (409, FK dependente): o MOTIVO vem do servidor e nada
 *     navega — a tela não troca o aviso por "excluído".
 *  3. Exclusão aceita: volta pra listagem.
 *
 * Papel: `manager` no AuthProvider falso, que é o piso de DELETE /companies/:id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", email: "dono@acme.com", is_platform_admin: false },
    activeOrg: { orgId: "11111111-1111-4111-8111-111111111111", name: "ACME", role: "manager" },
    isAuthenticated: true,
    refreshing: false,
    signOut: async () => undefined,
  }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, prefetch: vi.fn(), replace: vi.fn() }),
}));

import { CompanyDetailClient } from "@/app/app/companies/[id]/_client";

const EMPRESA = "22222222-2222-4222-8222-222222222222";
const CNPJ_FORMATADO = "33.547.054/0001-20";

const empresa = {
  id: EMPRESA,
  legal_name: "ACME LTDA",
  trade_name: "Acme",
  cnpj: CNPJ_FORMATADO,
  normalized_cnpj: "33547054000120",
  registration_status: "ATIVA",
  company_size: "ME",
  street: "Rua Beira Mar",
  number: "1000",
  complement: null,
  district: "Meireles",
  city: "Fortaleza",
  state: "CE",
  zip_code: "60000-000",
  email: null,
  phone: null,
  enrichment_status: "failed",
  enrichment_error: "upstream_error: BrasilAPI respondeu 403.",
};

function resposta(ok: boolean, payload: unknown) {
  return { ok, json: async () => payload } as Response;
}

/** O que a rota DELETE deve devolver em cada teste. */
let deleteResposta: { ok: boolean; payload: unknown } = {
  ok: true,
  payload: { data: { deleted: true, id: EMPRESA } },
};
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "PATCH")
    return resposta(true, { data: { ...empresa, ...JSON.parse(init!.body as string) } });
  if (method === "DELETE") return resposta(deleteResposta.ok, deleteResposta.payload);
  return resposta(true, { data: { company: empresa, people: [], contacts: [] } });
});

beforeEach(() => {
  vi.clearAllMocks();
  deleteResposta = { ok: true, payload: { data: { deleted: true, id: EMPRESA } } };
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderTela() {
  render(<CompanyDetailClient id={EMPRESA} />);
  await screen.findByText("ACME LTDA");
}

describe("editar empresa (#1937)", () => {
  it("abre a edição já preenchida e manda o PATCH com o CNPJ COM máscara", async () => {
    await renderTela();

    fireEvent.click(screen.getByRole("button", { name: "Editar empresa" }));
    const razao = await screen.findByDisplayValue("ACME LTDA");
    fireEvent.change(razao, { target: { value: "ACME COMERCIO LTDA" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => (c[1]?.method ?? "GET") === "PATCH");
      expect(patch).toBeTruthy();
      expect(patch![0]).toBe(`/api/v1/companies/${EMPRESA}`);
      const body = JSON.parse(patch![1]!.body as string);
      expect(body.legal_name).toBe("ACME COMERCIO LTDA");
      // os campos não tocados seguem junto, e o CNPJ volta formatado
      expect(body.cnpj).toBe(CNPJ_FORMATADO);
      expect(body.city).toBe("Fortaleza");
      // campo vazio vira null, não "" (o schema rejeita string vazia)
      expect(body.email).toBeNull();
    });

    // o diálogo fecha e a tela recarrega
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    });
  });
});

describe("excluir empresa (#1937)", () => {
  it("recusa do servidor (409) mostra o motivo e NÃO navega", async () => {
    deleteResposta = {
      ok: false,
      payload: {
        error: {
          code: "conflict",
          message: "Não é possível excluir: há vínculos ativos com esta empresa.",
        },
      },
    };
    await renderTela();

    fireEvent.click(screen.getByRole("button", { name: "Excluir empresa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Excluir" }));

    await screen.findByText(/há vínculos ativos com esta empresa/);
    expect(push).not.toHaveBeenCalled();
    // o diálogo continua aberto: nada foi prometido como feito
    expect(screen.getByRole("button", { name: "Excluir" })).toBeEnabled();
  });

  it("exclusão aceita volta para a listagem", async () => {
    await renderTela();

    fireEvent.click(screen.getByRole("button", { name: "Excluir empresa" }));
    fireEvent.click(await screen.findByRole("button", { name: "Excluir" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/companies"));
    const deletions = fetchMock.mock.calls.filter((c) => c[1]?.method === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(deletions[0]![0]).toBe(`/api/v1/companies/${EMPRESA}`);
  });
});
