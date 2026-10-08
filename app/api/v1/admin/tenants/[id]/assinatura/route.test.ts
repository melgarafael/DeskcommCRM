import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, operacao, valorDoFiltro, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  ator: "aaaaaaaa-0000-4000-8000-000000000001",
  escrita: vi.fn(),
  audit: vi.fn(),
  ligada: true,
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: async () => false, loadAuthUser: async () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformAdminEscrita: h.escrita,
}));
vi.mock("@/lib/instalacao/modulos", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instalacao/modulos")>()),
  moduloLigado: async (_db: unknown, modulo: string) => modulo === "cobranca" && h.ligada,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

import { EscritaDePlatformAdminNegada } from "@/lib/auth/requirePlatformAdmin";

import { DELETE, PATCH, POST } from "./route";

const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const DIA = 86_400_000;
const plano = (id: string, extra: Record<string, unknown> = {}) => ({
  id, intervalo: "mes", trial_dias: 14, max_assentos: 3, max_canais: 1, arquivado_em: null, ...extra,
});
const BASICO = plano("cccccccc-0000-4000-8000-000000000001");
const PRO = plano("cccccccc-0000-4000-8000-000000000002", { max_assentos: 10, max_canais: 5 });
const ANUAL = plano("cccccccc-0000-4000-8000-000000000003", { intervalo: "ano" });
const VELHO = plano("cccccccc-0000-4000-8000-000000000004", { arquivado_em: "2026-09-01T00:00:00Z" });
const PLANOS = [BASICO, PRO, ANUAL, VELHO];

interface Mundo {
  org: Record<string, unknown> | null;
  assinatura: Record<string, unknown> | null;
  assentos: number;
  canais: number;
  escrita: Resposta | null;
  rpc: Resposta;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: m.org };
  if (c.tabela === "cobranca_planos") return { data: PLANOS.find((p) => p.id === valorDoFiltro(c, "eq", "id")) ?? null };
  if (c.tabela === "user_organizations") return { count: m.assentos };
  if (c.tabela === "channel_sessions") return { count: m.canais };
  const op = operacao(c);
  if (op === "select") return { data: m.assinatura };
  if (m.escrita) return m.escrita;
  if (op === "insert") return { data: argumentos(c, "insert")?.[0] };
  if (op === "update") {
    return { data: { organization_id: TENANT, plano_id: (argumentos(c, "update")?.[0] as { plano_id: string }).plano_id } };
  }
  // delete: o dublê respeita o filtro de provedor que a rota manda.
  return { data: m.assinatura && m.assinatura.provedor === null ? { plano_id: m.assinatura.plano_id } : null };
}

const ctx = (id = TENANT) => ({ params: Promise.resolve({ id }) });
const pedido = (metodo: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/v1/admin/tenants/${TENANT}/assinatura`, {
    method: metodo,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
const escritas = () => h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) !== "select");

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.escrita.mockResolvedValue({ user: { id: h.ator }, platformAdmin: { user_id: h.ator, scope: "full", mfa_required: false } });
  m = {
    org: { id: TENANT, status: "active", suspended_kind: null },
    assinatura: {
      organization_id: TENANT, plano_id: BASICO.id, plano_agendado_id: null, estado: "trial",
      trial_ate: new Date(Date.now() + 5 * DIA).toISOString(), provedor: null, prazo_extra_ate: null,
    },
    assentos: 1,
    canais: 1,
    escrita: null,
    rpc: { data: { changed: true } },
  };
  h.banco = bancoFalso(responder, () => m.rpc);
});

describe.each([
  ["POST", POST, { plano_id: PRO.id }],
  ["PATCH", PATCH, { plano_id: PRO.id }],
  ["DELETE", DELETE, undefined],
] as const)("%s — os portões", (metodo, handler, corpo) => {
  it("chave desligada → 404, nada lido nem escrito", async () => {
    h.ligada = false;
    expect((await handler(pedido(metodo, corpo), ctx())).status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });
  it("support_readonly → 403 forbidden_scope", async () => {
    h.escrita.mockRejectedValueOnce(new EscritaDePlatformAdminNegada("forbidden_scope", "somente leitura"));
    const res = await handler(pedido(metodo, corpo), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden_scope");
    expect(h.banco.cadeias).toEqual([]);
  });
  it("id que não é uuid → 404", async () => {
    expect((await handler(pedido(metodo, corpo), ctx("x"))).status).toBe(404);
    expect(h.banco.cadeias).toEqual([]);
  });
});

describe("POST — atribuir plano a empresa isenta", () => {
  it("cria trial com os dias do plano; organization_id do PATH; audita plano_trocado 'atribuido'", async () => {
    const res = await POST(pedido("POST", { plano_id: BASICO.id }), ctx());
    expect(res.status).toBe(201);
    const linha = argumentos(escritas()[0]!, "insert")?.[0] as Record<string, unknown>;
    expect(Object.keys(linha).sort()).toEqual(["estado", "organization_id", "plano_id", "trial_ate"]);
    expect(linha).toMatchObject({ organization_id: TENANT, plano_id: BASICO.id, estado: "trial" });
    expect(Math.abs(Date.parse(String(linha.trial_ate)) - (Date.now() + 14 * DIA))).toBeLessThan(5_000);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.plano_trocado", organizationId: TENANT, metadata: { de: null, para: BASICO.id, quando: "atribuido" },
    }));
  });
  it("já tem linha → 409 state_conflict", async () => {
    m.escrita = { error: { code: "23505", message: "dup" } };
    const res = await POST(pedido("POST", { plano_id: BASICO.id }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("state_conflict");
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("plano arquivado ou inexistente → 422 plano_invalido, nada gravado", async () => {
    expect((await POST(pedido("POST", { plano_id: VELHO.id }), ctx())).status).toBe(422);
    expect((await POST(pedido("POST", { plano_id: "cccccccc-0000-4000-8000-00000000ffff" }), ctx())).status).toBe(422);
    expect(escritas()).toEqual([]);
  });
  it("tenant inexistente → 404; sem plano_id → 400", async () => {
    expect((await POST(pedido("POST", {}), ctx())).status).toBe(400);
    m.org = null;
    expect((await POST(pedido("POST", { plano_id: BASICO.id }), ctx())).status).toBe(404);
    expect(escritas()).toEqual([]);
  });
});

describe("PATCH — trocar plano (§7e; PR 2 sem provedor)", () => {
  it("em teste: troca na hora; só plano_id, plano_agendado_id e updated_at; compare-and-set", async () => {
    const res = await PATCH(pedido("PATCH", { plano_id: PRO.id }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ changed: true, plano_id: PRO.id });
    const [update] = escritas();
    expect(Object.keys(argumentos(update!, "update")?.[0] as object).sort()).toEqual(["plano_agendado_id", "plano_id", "updated_at"]);
    expect(filtros(update!)).toEqual([["eq", "organization_id", TENANT], ["eq", "plano_id", BASICO.id], ["is", "provedor", null]]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.plano_trocado", metadata: { de: BASICO.id, para: PRO.id, quando: "imediato" },
    }));
  });
  it("mesmo plano → 200 changed:false, nada gravado", async () => {
    expect((await (await PATCH(pedido("PATCH", { plano_id: BASICO.id }), ctx())).json()).data).toEqual({ changed: false, plano_id: BASICO.id });
    expect(escritas()).toEqual([]);
  });
  it("uso não cabe → 409 plan_limit_reached com o excedente (só o que passa)", async () => {
    m.assinatura = { ...m.assinatura, plano_id: PRO.id };
    m.assentos = 5;
    m.canais = 2;
    const res = await PATCH(pedido("PATCH", { plano_id: BASICO.id }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "plan_limit_reached", details: { excedente: { assentos: 2, canais: 1 } } });
    expect(escritas()).toEqual([]);
  });
  it("outro intervalo ou plano arquivado → 422 plano_invalido", async () => {
    expect((await PATCH(pedido("PATCH", { plano_id: ANUAL.id }), ctx())).status).toBe(422);
    expect((await PATCH(pedido("PATCH", { plano_id: VELHO.id }), ctx())).status).toBe(422);
    expect(escritas()).toEqual([]);
  });
  it.each([["em_atraso"], ["cancelada"]])("estado %s → 409 pagamento_pendente", async (estado) => {
    m.assinatura = { ...m.assinatura, estado };
    const res = await PATCH(pedido("PATCH", { plano_id: PRO.id }), ctx());
    expect((await res.json()).error.code).toBe("pagamento_pendente");
    expect(escritas()).toEqual([]);
  });
  it("teste vencido sem pagamento → 409 pagamento_pendente", async () => {
    m.assinatura = { ...m.assinatura, trial_ate: new Date(Date.now() - DIA).toISOString() };
    expect((await (await PATCH(pedido("PATCH", { plano_id: PRO.id }), ctx())).json()).error.code).toBe("pagamento_pendente");
    expect(escritas()).toEqual([]);
  });
  it("com provedor → 409 state_conflict e nada muda (troca agendada chega com o provedor)", async () => {
    m.assinatura = { ...m.assinatura, provedor: "stripe" };
    expect((await (await PATCH(pedido("PATCH", { plano_id: PRO.id }), ctx())).json()).error.code).toBe("state_conflict");
    expect(escritas()).toEqual([]);
  });
  it("sem linha (isenta) → 404", async () => {
    m.assinatura = null;
    expect((await PATCH(pedido("PATCH", { plano_id: PRO.id }), ctx())).status).toBe(404);
  });
  it("compare-and-set perdido → 409 state_conflict, sem audit", async () => {
    m.escrita = { data: null };
    expect((await PATCH(pedido("PATCH", { plano_id: PRO.id }), ctx())).status).toBe(409);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("DELETE — tornar isenta (PR 2: sem lerSituacao)", () => {
  it("sem provedor: apaga com o filtro de provedor no próprio DELETE; org ativa não chama reativação", async () => {
    const res = await DELETE(pedido("DELETE"), ctx());
    expect((await res.json()).data).toEqual({ changed: true, reativada: false });
    expect(filtros(escritas()[0]!)).toEqual([["eq", "organization_id", TENANT], ["is", "provedor", null]]);
    expect(h.banco.rpcs).toEqual([]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.isencao_definida", metadata: { plano_id: BASICO.id, reativada: false },
    }));
  });
  it("suspensa por cobrança: reativa pela função com kind 'cobranca'", async () => {
    m.org = { id: TENANT, status: "suspended", suspended_kind: "cobranca" };
    expect((await (await DELETE(pedido("DELETE"), ctx())).json()).data).toEqual({ changed: true, reativada: true });
    expect(h.banco.rpcs).toEqual([{ nome: "fn_reativar_organizacao", args: { p_org: TENANT, p_kind_exigido: "cobranca", p_ator: h.ator } }]);
  });
  it("suspensa administrativa: isenta, mas a suspensão fica", async () => {
    m.org = { id: TENANT, status: "suspended", suspended_kind: "administrativa" };
    expect((await (await DELETE(pedido("DELETE"), ctx())).json()).data).toEqual({ changed: true, reativada: false });
    expect(h.banco.rpcs).toEqual([]);
  });
  it("com provedor: 409 state_conflict, nada apagado, nada reativado", async () => {
    m.assinatura = { ...m.assinatura, provedor: "stripe" };
    m.org = { id: TENANT, status: "suspended", suspended_kind: "cobranca" };
    expect((await (await DELETE(pedido("DELETE"), ctx())).json()).error.code).toBe("state_conflict");
    expect(h.banco.rpcs).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("já isenta e ativa: 200 changed:false, sem audit (idempotente)", async () => {
    m.assinatura = null;
    expect((await (await DELETE(pedido("DELETE"), ctx())).json()).data).toEqual({ changed: false, reativada: false });
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("sem linha mas ainda suspensa por cobrança (tentativa anterior caiu no meio): reativa", async () => {
    m.assinatura = null;
    m.org = { id: TENANT, status: "suspended", suspended_kind: "cobranca" };
    expect((await (await DELETE(pedido("DELETE"), ctx())).json()).data).toEqual({ changed: true, reativada: true });
  });
  it("reativação que falha → 500", async () => {
    m.org = { id: TENANT, status: "suspended", suspended_kind: "cobranca" };
    m.rpc = { data: null, error: { code: "XX000", message: "boom" } };
    expect((await DELETE(pedido("DELETE"), ctx())).status).toBe(500);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.isencao_definida", metadata: { plano_id: BASICO.id, reativada: false },
    }));
  });
});
