/**
 * TODA ESCRITA FINANCEIRA NASCE NA MOEDA DA ORGANIZAÇÃO (#3379).
 *
 * Depois do #3378 o NÚMERO digitado passou a ser lido pela moeda da
 * organização, mas a LINHA continuava nascendo em BRL: quatro portas de escrita
 * não mandavam `currency` e as quatro colunas têm `default 'BRL'` no
 * `baseline.sql` — `financial_entries`, `recurring_entries`,
 * `financial_accounts` e `honorarios_parcelas` (esta última nem tinha a coluna).
 * Numa organização em USD, `1,300` gravava 130000 centavos e a lista mostrava
 * `R$ 1.300,00` — o valor certo com o rótulo de outra moeda, que é o pior dos
 * dois mundos: parece certo.
 *
 * ─── Por que o instrumento é o PAYLOAD do insert ────────────────────────────
 *
 * Mesma régua de `comanda-nasce-na-moeda-da-org.test.ts` (#2160): a resposta
 * HTTP não é o que a tela mostra. Quem mostra é a linha gravada. Então o dublê
 * do PostgREST ANOTA o que a rota mandou e a asserção é sobre essa linha — uma
 * rota que volte a omitir `currency` deixa a asserção vermelha em vez de passar.
 *
 * ─── Por que a moeda vem do banco e nunca do corpo ──────────────────────────
 *
 * A moeda é unidade, não dado de quem chama: o corpo não decide unidade pela
 * mesma razão que não decide escopo (`organization_id`). Os schemas nem
 * declaram `currency`, então o Zod a descarta antes de qualquer escrita — e é
 * isso que o caso "moeda do corpo é ignorada" mede.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_POR_ENTIDADE, contaSchema, recorrenciaSchema } from "@/lib/financeiro/catalogo";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ORG_DE_FORA = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTA = "33333333-3333-4333-8333-333333333333";
const CONTRATO = "55555555-5555-4555-8555-555555555555";
const PLANO = "77777777-7777-4777-8777-777777777777";

/** A pilha de inserts que as rotas deste teste mandaram pro banco, por tabela. */
let insercoes: Record<string, Array<Record<string, unknown>>> = {};

/**
 * Dublê do PostgREST que ANOTA o que foi inserido.
 *
 * `maybeSingle` responde `organizations.currency` — é por ali que
 * `moedaDaOrganizacao` (o único leitor da moeda, `lib/catalogo/moeda-da-org.ts`)
 * resolve a unidade no servidor. As demais tabelas devolvem `null`.
 */
function montarMundo(moedaDaOrganizacao: string) {
  insercoes = {};

  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Org", role: "manager" },
      }) as never,
  );

  const from = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};

    cadeia.select = () => cadeia;
    cadeia.order = () => cadeia;
    cadeia.limit = () => cadeia;
    cadeia.eq = () => cadeia;

    cadeia.insert = (linha: Record<string, unknown>) => {
      (insercoes[tabela] ??= []).push(linha);
      const inserido = { id: `linha-${insercoes[tabela]!.length}` };
      const elo: Record<string, unknown> = {
        select: () => elo,
        single: async () => ({ data: inserido, error: null }),
        maybeSingle: async () => ({ data: inserido, error: null }),
      };
      elo.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: inserido, error: null }).then(resolve, reject);
      return elo;
    };

    cadeia.maybeSingle = async () =>
      tabela === "organizations" ? { data: { currency: moedaDaOrganizacao }, error: null } : { data: null, error: null };
    cadeia.single = async () => ({ data: null, error: null });
    cadeia.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve, reject);

    return cadeia;
  };

  vi.mocked(createClient).mockResolvedValue({ from } as never);
}

function pedido(url: string, corpo: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

/** A última linha que a rota sob teste mandou para `tabela`. */
function gravada(tabela: string): Record<string, unknown> {
  const linhas = insercoes[tabela] ?? [];
  expect(linhas.length, `a rota não inseriu nenhuma linha em ${tabela}`).toBeGreaterThan(0);
  return linhas[linhas.length - 1]!;
}

const VENCIMENTO = "2026-11-10";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/financeiro/lancamentos — o lançamento manual", () => {
  async function lancar(corpo: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/financeiro/lancamentos/route");
    return POST(pedido("http://localhost/api/v1/financeiro/lancamentos", corpo));
  }

  const CORPO = {
    account_id: CONTA,
    direction: "in",
    amount_cents: 130000,
    description: "Consultoria",
    entry_date: "2026-11-01",
  };

  it("nasce em USD quando a organização é em dólar", async () => {
    montarMundo("USD");
    const res = await lancar(CORPO);

    expect(res.status).toBe(200);
    expect(gravada("financial_entries").currency).toBe("USD");
  });

  it("organização em BRL continua nascendo em BRL — nada muda", async () => {
    montarMundo("BRL");
    const res = await lancar(CORPO);

    expect(res.status).toBe(200);
    expect(gravada("financial_entries").currency).toBe("BRL");
  });

  it("a moeda e a organização do corpo são ignoradas", async () => {
    montarMundo("USD");
    const res = await lancar({ ...CORPO, currency: "EUR", organization_id: ORG_DE_FORA });

    expect(res.status).toBe(200);
    const linha = gravada("financial_entries");
    expect(linha.currency).toBe("USD");
    expect(linha.organization_id).toBe(ORG);
  });
});

describe("POST /api/v1/financeiro/catalogo/contas — a conta do catálogo", () => {
  async function criarConta(corpo: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/financeiro/catalogo/[tipo]/route");
    return POST(
      pedido("http://localhost/api/v1/financeiro/catalogo/contas", corpo),
      { params: Promise.resolve({ tipo: "contas" }) },
    );
  }

  it("nasce em USD quando a organização é em dólar", async () => {
    montarMundo("USD");
    const res = await criarConta({ name: "Conta corrente", kind: "bank" });

    expect(res.status).toBe(201);
    expect(gravada("financial_accounts").currency).toBe("USD");
  });

  it("organização em BRL continua nascendo em BRL — nada muda", async () => {
    montarMundo("BRL");
    const res = await criarConta({ name: "Caixa", kind: "cash" });

    expect(res.status).toBe(201);
    expect(gravada("financial_accounts").currency).toBe("BRL");
  });

  it("a moeda do corpo é ignorada — quem escolhe a unidade é a organização", async () => {
    montarMundo("USD");
    const res = await criarConta({ name: "Caixa", kind: "cash", currency: "EUR" });

    expect(res.status).toBe(201);
    expect(gravada("financial_accounts").currency).toBe("USD");
  });
});

describe("POST /api/v1/financeiro/catalogo/recorrencias — o molde que se repete", () => {
  async function criarRecorrencia(corpo: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/financeiro/catalogo/[tipo]/route");
    return POST(
      pedido("http://localhost/api/v1/financeiro/catalogo/recorrencias", corpo),
      { params: Promise.resolve({ tipo: "recorrencias" }) },
    );
  }

  const CORPO = {
    name: "Aluguel",
    account_id: CONTA,
    direction: "out",
    amount_cents: 130000,
    day_of_month: 5,
  };

  it("nasce em USD quando a organização é em dólar", async () => {
    montarMundo("USD");
    const res = await criarRecorrencia(CORPO);

    expect(res.status).toBe(201);
    expect(gravada("recurring_entries").currency).toBe("USD");
  });

  it("organização em BRL continua nascendo em BRL — nada muda", async () => {
    montarMundo("BRL");
    const res = await criarRecorrencia(CORPO);

    expect(res.status).toBe(201);
    expect(gravada("recurring_entries").currency).toBe("BRL");
  });

  it("a moeda do corpo é ignorada", async () => {
    montarMundo("USD");
    const res = await criarRecorrencia({ ...CORPO, currency: "EUR" });

    expect(res.status).toBe(201);
    expect(gravada("recurring_entries").currency).toBe("USD");
  });
});

describe("POST /api/v1/honorarios/contratos/[id]/parcelas — a parcela de honorários", () => {
  const params = { params: Promise.resolve({ id: CONTRATO }) };

  async function criarParcela(corpo: Record<string, unknown>) {
    const { POST } = await import("@/app/api/v1/honorarios/contratos/[id]/parcelas/route");
    return POST(
      pedido(`http://localhost/api/v1/honorarios/contratos/${CONTRATO}/parcelas`, corpo),
      params,
    );
  }

  it("nasce em USD quando a organização é em dólar", async () => {
    montarMundo("USD");
    const res = await criarParcela({ numero: 1, vencimento: VENCIMENTO, valor_cents: 130000 });

    expect(res.status).toBe(200);
    expect(gravada("honorarios_parcelas").currency).toBe("USD");
  });

  it("organização em BRL continua nascendo em BRL — nada muda", async () => {
    montarMundo("BRL");
    const res = await criarParcela({ numero: 1, vencimento: VENCIMENTO, valor_cents: 130000 });

    expect(res.status).toBe(200);
    expect(gravada("honorarios_parcelas").currency).toBe("BRL");
  });

  it("a moeda do corpo é ignorada", async () => {
    montarMundo("USD");
    const res = await criarParcela({
      numero: 1,
      vencimento: VENCIMENTO,
      valor_cents: 130000,
      currency: "EUR",
    });

    expect(res.status).toBe(200);
    expect(gravada("honorarios_parcelas").currency).toBe("USD");
  });
});

describe("os schemas do catálogo não aceitam moeda de quem chama", () => {
  it("a conta nasce SEM moeda no corpo — o servidor injeta a da organização", () => {
    const lido = contaSchema.parse({ name: "Caixa", kind: "cash", currency: "EUR" });

    // O Zod descarta o campo em vez de propagá-lo: corpo não decide unidade.
    expect(lido).not.toHaveProperty("currency");
  });

  it("a recorrência nasce SEM moeda no corpo", () => {
    const lido = recorrenciaSchema.parse({
      name: "Aluguel",
      account_id: CONTA,
      account_plan_id: PLANO,
      direction: "out",
      amount_cents: 130000,
      day_of_month: 5,
      currency: "EUR",
    });

    expect(lido).not.toHaveProperty("currency");
  });

  it("as duas entidades com coluna de moeda continuam devolvendo a coluna nas listagens", () => {
    // A tela lê `currency` da RESPOSTA do catálogo: sem a coluna no select, a
    // lista mostraria tudo em BRL mesmo com a linha gravada certa.
    for (const tipo of ["contas", "recorrencias"] as const) {
      expect(COLUNAS_POR_ENTIDADE[tipo].split(", ")).toContain("currency");
    }
  });
});
