/**
 * /api/v1/vendas — registrar e listar vendas.
 *
 *  1. registrar: grava com a organização do COOKIE, a moeda do NEGÓCIO (a da
 *     organização quando o negócio não tem), a
 *     tag normalizada, o contato herdado do negócio, e audita;
 *  2. negócio de outra organização (ou invisível pela RLS) → 404, nada gravado;
 *  3. contato que não é o do negócio → 422; contato de outra organização → 404;
 *  4. corpo inválido (valor zero, data no futuro, sem negócio nem contato) →
 *     422, sem tocar no banco;
 *  5. listar filtra pela organização e pelo negócio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const OUTRO_CONTATO = "44444444-4444-4444-8444-444444444444";
const USUARIO = "55555555-5555-4555-8555-555555555555";
const LEAD_DE_FORA = "66666666-6666-4666-8666-666666666666";
const LEAD_EM_DOLAR = "77777777-7777-4777-8777-777777777777";

type Linha = Record<string, unknown>;

/** PostgREST em memória: aplica `eq`, guarda inserts, devolve o que casa. */
function banco(tabelas: Record<string, Linha[]>) {
  const inserts: Array<{ tabela: string; linha: Linha }> = [];
  const filtrosVistos: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  function from(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    filtrosVistos.push({ tabela, filtros });
    let inserida: Linha | null = null;
    const casa = () => (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
    const q: Record<string, unknown> = {
      select: () => q,
      eq(c: string, v: unknown) {
        filtros.push([c, v]);
        return q;
      },
      order: () => q,
      limit: () => q,
      insert(linha: Linha) {
        inserida = { id: "venda-nova", created_at: "2026-11-21T00:00:00Z", ...linha };
        inserts.push({ tabela, linha });
        return q;
      },
      maybeSingle: async () => ({ data: casa()[0] ?? null, error: null }),
      single: async () => ({ data: inserida, error: null }),
      then(ok: (v: unknown) => unknown) {
        return Promise.resolve({ data: casa(), error: null }).then(ok);
      },
    };
    return q;
  }
  return { cliente: { from: vi.fn(from) }, inserts, filtrosVistos };
}

function auth(role = "agent") {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USUARIO, idioma: "pt-BR" },
    org: { orgId: ORG, role, currency: "brl", timezone: "America/Sao_Paulo" },
  } as never);
}

const LEADS = [
  { id: LEAD, organization_id: ORG, contact_id: CONTATO },
  { id: LEAD_DE_FORA, organization_id: OUTRA_ORG, contact_id: CONTATO },
  { id: LEAD_EM_DOLAR, organization_id: ORG, contact_id: CONTATO, currency: "usd" },
];
const CONTATOS = [
  { id: CONTATO, organization_id: ORG },
  { id: OUTRO_CONTATO, organization_id: OUTRA_ORG },
];

function montar(vendas: Linha[] = []) {
  const sessao = banco({ crm_leads: LEADS, vendas_registradas: vendas });
  const admin = banco({ contacts: CONTATOS, vendas_registradas: vendas });
  vi.mocked(createClient).mockResolvedValue(sessao.cliente as never);
  vi.mocked(createAdminClient).mockReturnValue(admin.cliente as never);
  return { sessao, admin };
}

function postar(corpo: unknown) {
  return POST(
    new NextRequest("http://localhost/api/v1/vendas", { method: "POST", body: JSON.stringify(corpo) }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/v1/vendas", () => {
  it("registra com a organização do cookie, moeda da org, tag normalizada e o contato do negócio", async () => {
    auth();
    const { admin } = montar();

    const res = await postar({ lead_id: LEAD, valor_cents: 18_000, data: "2026-11-20", tags: [" Atacado ", "ATACADO"] });

    expect(res.status).toBe(201);
    expect(admin.inserts).toHaveLength(1);
    expect(admin.inserts[0]!.linha).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      contact_id: CONTATO,
      valor_cents: 18_000,
      currency: "BRL",
      data: "2026-11-20",
      tags: ["atacado"],
      created_by: USUARIO,
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(expect.objectContaining({ action: "venda.registrada", organizationId: ORG }));
  });

  it("negócio em outra moeda: a venda é gravada na moeda do NEGÓCIO, a que a soma do Valor conta", async () => {
    auth();
    const { admin } = montar();

    const res = await postar({ lead_id: LEAD_EM_DOLAR, valor_cents: 5_000, data: "2026-11-20" });

    expect(res.status).toBe(201);
    expect(admin.inserts[0]!.linha.currency).toBe("USD");
  });

  it("ignora organization_id do corpo: a org é sempre a do cookie", async () => {
    auth();
    const { admin } = montar();

    await postar({ lead_id: LEAD, valor_cents: 100, data: "2026-11-20", organization_id: OUTRA_ORG });

    expect(admin.inserts[0]!.linha.organization_id).toBe(ORG);
  });

  it("negócio de outra organização: 404 e nada gravado", async () => {
    auth();
    const { admin } = montar();

    const res = await postar({ lead_id: LEAD_DE_FORA, valor_cents: 100, data: "2026-11-20" });

    expect(res.status).toBe(404);
    expect(admin.inserts).toHaveLength(0);
  });

  it("contato que não é o do negócio: 422", async () => {
    auth();
    const { admin } = montar();

    const res = await postar({ lead_id: LEAD, contact_id: OUTRO_CONTATO, valor_cents: 100, data: "2026-11-20" });

    expect(res.status).toBe(422);
    expect(admin.inserts).toHaveLength(0);
  });

  it("só contato, mas de outra organização: 404", async () => {
    auth();
    const { admin } = montar();

    const res = await postar({ contact_id: OUTRO_CONTATO, valor_cents: 100, data: "2026-11-20" });

    expect(res.status).toBe(404);
    expect(admin.inserts).toHaveLength(0);
  });

  it.each([
    ["valor zero", { lead_id: LEAD, valor_cents: 0, data: "2026-11-20" }],
    ["data no futuro", { lead_id: LEAD, valor_cents: 100, data: "2099-01-01" }],
    ["sem negócio nem contato", { valor_cents: 100, data: "2026-11-20" }],
    ["data inválida", { lead_id: LEAD, valor_cents: 100, data: "20/11/2026" }],
  ])("%s: 422 sem tocar no banco", async (_caso, corpo) => {
    auth();
    const { admin } = montar();

    const res = await postar(corpo);

    expect(res.status).toBe(422);
    expect(admin.inserts).toHaveLength(0);
  });

  it("sem papel, devolve a resposta do portão", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }),
    } as never);
    const { admin } = montar();

    const res = await postar({ lead_id: LEAD, valor_cents: 100, data: "2026-11-20" });

    expect(res.status).toBe(403);
    expect(admin.inserts).toHaveLength(0);
  });
});

describe("GET /api/v1/vendas", () => {
  it("lista pela organização do cookie e pelo negócio", async () => {
    auth("viewer");
    const { sessao } = montar([
      { id: "v1", organization_id: ORG, lead_id: LEAD, valor_cents: 100 },
      { id: "v2", organization_id: OUTRA_ORG, lead_id: LEAD, valor_cents: 999 },
    ]);

    const res = await GET(new NextRequest(`http://localhost/api/v1/vendas?lead_id=${LEAD}`));
    const corpo = (await res.json()) as { data: Array<{ id: string }> };

    expect(res.status).toBe(200);
    expect(corpo.data.map((v) => v.id)).toEqual(["v1"]);
    const filtros = sessao.filtrosVistos.find((f) => f.tabela === "vendas_registradas")!.filtros;
    expect(filtros).toContainEqual(["organization_id", ORG]);
    expect(filtros).toContainEqual(["lead_id", LEAD]);
  });

  it("sem negócio nem contato: 422", async () => {
    auth("viewer");
    montar();

    const res = await GET(new NextRequest("http://localhost/api/v1/vendas"));

    expect(res.status).toBe(422);
  });
});
