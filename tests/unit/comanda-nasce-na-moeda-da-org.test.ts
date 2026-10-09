/**
 * A COMANDA NASCE NA MOEDA DA ORGANIZAÇÃO (#2160).
 *
 * As duas portas de escrita de comanda — `POST /api/v1/financeiro/comandas` e
 * `POST /api/v1/financeiro/comandas/faturar-lote` — gravavam em `sales` SEM
 * `currency`, e a coluna tem `default 'BRL'`. Numa organização em euro isso
 * fazia a comanda nascer em R$ e aparecer errada na tela
 * (`app/app/comandas/_client.tsx` lê `comanda?.currency ?? "BRL"`), enquanto a
 * mesma tela mostrava € no topo: dois números diferentes para o mesmo
 * atendimento, e a venda ainda caía no bloco BRL do relatório.
 *
 * ─── Por que o instrumento é o PAYLOAD do insert ────────────────────────────
 *
 * O teste espia a linha que a rota manda para o banco, não a resposta HTTP: a
 * resposta devolve `id, number, status` e não menciona moeda nenhuma. Gravar
 * ou não gravar `currency` é exatamente o defeito, então é isso que se mede.
 *
 * ─── Por que a MOEDA vem do banco e não do corpo ────────────────────────────
 *
 * Mesma regra do cadastro de produto (`app/api/v1/products/route.ts`): o Zod
 * dos dois corpos nem declara `currency`, então ele descarta o campo antes de
 * qualquer escrita — quem escolhe a unidade é a organização, resolvida de
 * fonte confiável (`authz.org.orgId`), nunca de quem chama a rota.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { abrirComandaSchema } from "@/lib/financeiro/comanda";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// Isola o handler do gate de suporte (autoridade própria testada em
// lib/impersonate/support.test.ts) — nenhum teste aqui exercita acompanhamento.
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ORG_DE_FORA = "99999999-9999-4999-8999-999999999999";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTACT = "55555555-5555-4555-8555-555555555555";
const APPOINTMENT = "44444444-4444-4444-8444-444444444444";
const PAYMENT = "66666666-6666-4666-8666-666666666666";
const NUMERO = 42;

interface MundoOpts {
  /** `organizations.currency` lido por `moedaDaOrganizacao`. Default: "BRL". */
  moedaDaOrganizacao?: string;
}

/**
 * A pilha de inserts que as rotas deste teste mandaram pro banco, por tabela.
 *
 * `insercoes` é o instrumento do teste: a asserção é sobre a linha que saiu da
 * rota, não sobre o que eu espero que ela faça. Uma rota que pare de gravar
 * `currency` deixa a pilha vazia e a asserção reprova, em vez de passar.
 */
let insercoes: Record<string, Array<Record<string, unknown>>> = {};

/**
 * Dublê do PostgREST que ANOTA o que foi inserido.
 *
 * Cadeia auto-referente (eq/in/neq sempre devolvem a mesma cadeia, como o
 * builder real do supabase-js) e `then` próprio, porque o PostgREST resolve a
 * query ao ser `await`ada — é assim que a rota lê `calendar_appointments`.
 */
function montarMundo(opts: MundoOpts = {}) {
  const moedaDaOrg = opts.moedaDaOrganizacao ?? "BRL";
  insercoes = {};

  vi.mocked(requireRole).mockImplementation(
    async () =>
      ({
        ok: true,
        user: { id: USER, idioma: "pt-BR" },
        org: { orgId: ORG, name: "Org", role: "agent" },
      }) as never,
  );

  const AGENDAMENTOS = [
    {
      id: APPOINTMENT,
      title: "Corte",
      contact_id: CONTACT,
      event_type_id: "77777777-7777-4777-8777-777777777777",
      status: "completed",
      calendar_event_types: { name: "Corte", default_price_cents: 5000 },
    },
  ];

  const from = (tabela: string) => {
    const cadeia: Record<string, unknown> = {};

    cadeia.select = () => cadeia;
    cadeia.order = () => cadeia;
    cadeia.limit = () => cadeia;
    cadeia.eq = () => cadeia;
    cadeia.in = () => cadeia;
    cadeia.neq = () => cadeia;

    cadeia.insert = (linha: Record<string, unknown>) => {
      (insercoes[tabela] ??= []).push(linha);
      const inserido = { id: `venda-${insercoes[tabela]!.length}`, number: NUMERO, status: "open" };
      const elo: Record<string, unknown> = {
        select: () => elo,
        single: async () => ({ data: inserido, error: null }),
        maybeSingle: async () => ({ data: inserido, error: null }),
      };
      // O insert também resolve ao ser `await`ado: o faturar-lote espera
      // `sale_items` direto, sem `.single()`.
      elo.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: inserido, error: null }).then(resolve, reject);
      return elo;
    };
    cadeia.maybeSingle = async () =>
      tabela === "organizations"
        ? // D11 — `moedaDaOrganizacao` lê `currency` com `maybeSingle`.
          { data: { currency: moedaDaOrg }, error: null }
        : { data: null, error: null };
    cadeia.single = async () => ({ data: null, error: null });
    cadeia.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: tabela === "calendar_appointments" ? AGENDAMENTOS : [], error: null }).then(
        resolve,
        reject,
      );
    return cadeia;
  };

  const rpc = async (fn: string) =>
    fn === "fn_finalizar_comanda" ? { data: null, error: null } : { data: NUMERO, error: null };

  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never);
}

function pedido(url: string, corpo: Record<string, unknown>): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const CORPO_COMANDA = "http://localhost/api/v1/financeiro/comandas";
const CORPO_LOTE = "http://localhost/api/v1/financeiro/comandas/faturar-lote";
const LOTE = { appointment_ids: [APPOINTMENT], payment_method_id: PAYMENT };

/** A última linha de `sales` que saiu da rota sob teste. */
function comandaGravada(): Record<string, unknown> {
  const linhas = insercoes["sales"] ?? [];
  expect(linhas.length, "a rota não inseriu nenhuma linha em sales").toBeGreaterThan(0);
  return linhas[linhas.length - 1]!;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/financeiro/comandas", () => {
  it("a comanda nasce em EUR quando a organização é em euro", async () => {
    montarMundo({ moedaDaOrganizacao: "EUR" });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");

    const res = await POST(pedido(CORPO_COMANDA, { contact_id: CONTACT }));

    expect(res.status).toBe(200);
    expect(comandaGravada().currency).toBe("EUR");
  });

  it("organização em BRL continua nascendo em BRL — nada muda", async () => {
    montarMundo({ moedaDaOrganizacao: "BRL" });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");

    const res = await POST(pedido(CORPO_COMANDA, { contact_id: CONTACT }));

    expect(res.status).toBe(200);
    expect(comandaGravada().currency).toBe("BRL");
  });

  it("currency e organization_id vindos do corpo são descartados", async () => {
    montarMundo({ moedaDaOrganizacao: "EUR" });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/route");

    const res = await POST(
      pedido(CORPO_COMANDA, { contact_id: CONTACT, currency: "USD", organization_id: ORG_DE_FORA }),
    );

    expect(res.status).toBe(200);
    const linha = comandaGravada();
    expect(linha.currency).toBe("EUR");
    expect(linha.organization_id).toBe(ORG);
    // O padrão das rotas vizinhas (products, proposals): o schema NEM declara o
    // campo, então o Zod o descarta antes de qualquer escrita.
    const { success, data } = abrirComandaSchema.safeParse({
      contact_id: CONTACT,
      currency: "USD",
    });
    expect(success).toBe(true);
    expect(data).not.toHaveProperty("currency");
  });
});

describe("POST /api/v1/financeiro/comandas/faturar-lote", () => {
  it("a comanda do lote nasce em EUR quando a organização é em euro", async () => {
    montarMundo({ moedaDaOrganizacao: "EUR" });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(CORPO_LOTE, LOTE));

    expect(res.status).toBe(200);
    expect(comandaGravada().currency).toBe("EUR");
  });

  it("organização em BRL continua nascendo em BRL — nada muda", async () => {
    montarMundo({ moedaDaOrganizacao: "BRL" });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(CORPO_LOTE, LOTE));

    expect(res.status).toBe(200);
    expect(comandaGravada().currency).toBe("BRL");
  });

  it("currency e organization_id vindos do corpo são descartados", async () => {
    montarMundo({ moedaDaOrganizacao: "EUR" });
    const { POST } = await import("@/app/api/v1/financeiro/comandas/faturar-lote/route");

    const res = await POST(pedido(CORPO_LOTE, { ...LOTE, currency: "USD", organization_id: ORG_DE_FORA }));

    expect(res.status).toBe(200);
    const linha = comandaGravada();
    expect(linha.currency).toBe("EUR");
    expect(linha.organization_id).toBe(ORG);
  });
});
