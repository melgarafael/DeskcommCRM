// @vitest-environment node
//
// O CONTATO DA LINHA 1 NÃO SOBRA QUANDO A IMPORTAÇÃO CAI (#2297, caminho 3) ──
//
// A ordem da rota é a defeituosa: o contato é criado ANTES do
// `createLeadHandler` da mesma linha, e uma recusa da régua (422) — ou uma
// etapa de outra organização (404) — derruba a importação INTEIRA logo depois.
// Sem desfazimento, a pessoa ficava com um contato órfão no cadastro que
// ninguém pediu e que nenhum negócio aponta.
//
// O que estes casos provam:
//   1. o 422 derruba a importação E o contato criado nesta requisição é
//      devolvido ao banco (o `delete` sai com o id certo);
//   2. a importação que PASSA não apaga nada (controle: o desfazimento é só do
//      caminho fatal);
//   3. contato que JÁ está em `crm_leads` nunca entra no `delete` — o corte por
//      referência protege o card que já nasceu.
//
// Sabotagem esperada: tirar a chamada `desfazContatosCriados` do `catch` deixa
// o caso 1 vermelho (nenhuma remoção) e os controles verdes.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonate/support")>()),
  requireSupportWrite: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUNIL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETAPA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTATO_NOVO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD_NOVO = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const PLANILHA = "nome,telefone\nMaria Silva,11999998888\n";

/**
 * Supabase de mentira cobrindo as três superfícies que a rota toca:
 * busca de contato (nada existe), insert do contato e o par
 * `crm_leads` (quem já tem card) + `delete` (o desfazimento).
 */
function supabaseFake({ contatosComNegocio = [] as string[] } = {}) {
  const inseridos: Record<string, unknown>[] = [];
  const remocoes: { tabela: string; ids: string[] }[] = [];

  const from = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};
    let apagando = false;
    let idsSelecionados: string[] = [];

    cadeia.select = () => cadeia;
    cadeia.eq = () => cadeia;
    cadeia.limit = () => cadeia;
    cadeia.order = () => cadeia;
    cadeia.in = (_coluna: string, ids: string[]) => {
      idsSelecionados = ids;
      return cadeia;
    };
    cadeia.insert = (linha: Record<string, unknown>) => {
      inseridos.push({ tabela, linha });
      return cadeia;
    };
    cadeia.delete = () => {
      apagando = true;
      return cadeia;
    };
    cadeia.maybeSingle = async () => ({ data: null, error: null });
    cadeia.single = async () => ({ data: { id: CONTATO_NOVO }, error: null });
    // A cadeia postgrest é await-ável (o `await` de `.in()` final).
    cadeia.then = (ok: (valor: unknown) => void) => {
      if (apagando && tabela === "contacts") {
        remocoes.push({ tabela, ids: idsSelecionados });
        ok({ error: null });
        return;
      }
      if (tabela === "crm_leads") {
        ok({
          data: contatosComNegocio.map((contact_id) => ({ contact_id })),
          error: null,
        });
        return;
      }
      ok({ data: null, error: null });
    };
    return cadeia;
  };

  return { cliente: { from } as never, inseridos, remocoes };
}

function pedido(): NextRequest {
  const form = new FormData();
  form.append("file", new File([PLANILHA], "leads.csv", { type: "text/csv" }));
  form.append("pipeline_id", FUNIL);
  form.append("stage_id", ETAPA);
  return new NextRequest("http://localhost/api/v1/leads/import", { method: "POST", body: form });
}

async function importar(entrada: {
  recusa?: ApiError;
  contatosComNegocio?: string[];
}) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USER, idioma: "pt-BR" },
  } as never);
  const fake = supabaseFake({ contatosComNegocio: entrada.contatosComNegocio ?? [] });
  vi.mocked(createClient).mockResolvedValue(fake.cliente as never);
  vi.mocked(createLeadHandler).mockImplementation(async () => {
    if (entrada.recusa) throw entrada.recusa;
    return { id: LEAD_NOVO } as never;
  });

  const { POST } = await import("./route");
  const res = await POST(pedido());
  return { status: res.status, corpo: (await res.json()) as Record<string, unknown>, fake };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/leads/import — a recusa não deixa resto (#2297)", () => {
  it("422 da régua derruba a importação e o contato criado na linha 1 é devolvido", async () => {
    const { status, fake } = await importar({
      recusa: new ApiError(
        422,
        "required_fields_missing",
        { faltando: [{ chave: "concorrente", rotulo: "Concorrente" }] },
        "req-1",
        "Preencha os campos obrigatórios antes de continuar: Concorrente.",
      ),
    });

    expect(status).toBe(422);
    // O contato NASCEU (é a ordem defeituosa)…
    expect(fake.inseridos.filter((i) => i.tabela === "contacts")).toHaveLength(1);
    // …e morre junto com a importação: é ele que não pode sobrar.
    expect(fake.remocoes).toEqual([{ tabela: "contacts", ids: [CONTATO_NOVO] }]);
  });

  it("a importação que PASSA não apaga nada (controle)", async () => {
    const { status, corpo, fake } = await importar({});

    expect(status).toBe(200);
    expect((corpo.data as Record<string, unknown>).criados).toBe(1);
    expect(fake.remocoes).toEqual([]);
  });

  it("contato que JÁ está em `crm_leads` não entra no `delete`", async () => {
    const { status, fake } = await importar({
      recusa: new ApiError(404, "not_found", undefined, "req-1", "Stage não encontrado."),
      contatosComNegocio: [CONTATO_NOVO],
    });

    expect(status).toBe(404);
    expect(fake.inseridos.filter((i) => i.tabela === "contacts")).toHaveLength(1);
    expect(fake.remocoes).toEqual([]);
  });
});
