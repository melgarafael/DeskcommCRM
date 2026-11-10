// @vitest-environment node
/**
 * LANÇAMENTO PAGO NÃO SE DESFAZ, E UM MÓDULO CONECTADO NÃO O PRODUZ (Spec 33, migration 9316).
 *
 * Marcar como pago (PATCH `pay: true`) e criar já pago (POST `status: "paid"`) são só da pessoa na
 * sessão. Para o ator `module` a rota recusa com 403 antes de qualquer leitura ou escrita; o
 * lançamento pendente segue permitido. A sessão continua aceita nos dois casos.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTA = "a2222222-2222-4222-8222-222222222222";
const LANC = "a4444444-4444-4444-8444-444444444444";

const m = vi.hoisted(() => ({
  authz: null as unknown,
  escritas: [] as string[],
}));

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => m.authz),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/catalogo/moeda-da-org", () => ({ moedaDaOrganizacao: vi.fn(async () => "BRL") }));

/** Cliente falso: toda cadeia devolve o mesmo objeto e registra insert/update. */
function clienteFalso() {
  const linhaAtual = { id: LANC, status: "pending", origin: "manual", amount_cents: 100, direction: "in" };
  const novo = { id: LANC, direction: "in", amount_cents: 100, currency: "BRL", status: "paid", entry_date: "2026-11-10" };
  const cadeia = (resultado: unknown) => {
    const c: Record<string, unknown> = {};
    for (const nome of ["select", "eq", "order", "limit"]) c[nome] = () => c;
    c.maybeSingle = async () => ({ data: linhaAtual, error: null });
    c.single = async () => ({ data: resultado, error: null });
    c.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
    return c;
  };
  return {
    from() {
      return {
        select: () => cadeia(linhaAtual),
        insert: () => {
          m.escritas.push("insert");
          return cadeia(novo);
        },
        update: () => {
          m.escritas.push("update");
          return cadeia(linhaAtual);
        },
      };
    },
  };
}

function autorizacao(tipo: "module" | "user") {
  return {
    ok: true,
    via: tipo === "module" ? "token" : "session",
    actor: { type: tipo, id: "11111111-1111-4111-8111-111111111111" },
    organizationId: ORG,
    apiTokenId: tipo === "module" ? "22222222-2222-4222-8222-222222222222" : null,
    supabase: clienteFalso(),
  };
}

const { PATCH } = await import("./[id]/route");
const { POST } = await import("./route");

const pedido = (corpo: unknown, metodo: string) =>
  new NextRequest("http://localhost/api/v1/financeiro/lancamentos", {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

const lancamento = (status: "pending" | "paid") => ({
  account_id: CONTA,
  direction: "in",
  amount_cents: 100,
  description: "Venda de balcão",
  entry_date: "2026-11-10",
  status,
});

beforeEach(() => {
  m.escritas = [];
});

describe("PATCH financeiro/lancamentos/[id] com pay:true", () => {
  it("módulo conectado é recusado com 403 forbidden, sem escrever", async () => {
    m.authz = autorizacao("module");
    const res = await PATCH(pedido({ pay: true }, "PATCH"), { params: Promise.resolve({ id: LANC }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect(m.escritas).toEqual([]);
  });

  it("a pessoa na sessão marca como pago", async () => {
    m.authz = autorizacao("user");
    const res = await PATCH(pedido({ pay: true }, "PATCH"), { params: Promise.resolve({ id: LANC }) });
    expect(res.status).toBe(200);
    expect(m.escritas).toEqual(["update"]);
  });
});

describe("POST financeiro/lancamentos com status paid", () => {
  it("módulo conectado criando já pago é recusado com 403, sem escrever", async () => {
    m.authz = autorizacao("module");
    const res = await POST(pedido(lancamento("paid"), "POST"));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    expect(m.escritas).toEqual([]);
  });

  it("módulo conectado criando pendente continua permitido", async () => {
    m.authz = autorizacao("module");
    const res = await POST(pedido(lancamento("pending"), "POST"));
    expect(res.status).toBe(200);
    expect(m.escritas).toEqual(["insert"]);
  });

  it("a pessoa na sessão cria já pago", async () => {
    m.authz = autorizacao("user");
    const res = await POST(pedido(lancamento("paid"), "POST"));
    expect(res.status).toBe(200);
    expect(m.escritas).toEqual(["insert"]);
  });
});
