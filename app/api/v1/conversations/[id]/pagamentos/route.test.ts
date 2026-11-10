import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bancoFalso, type BancoFalso, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  autorizado: true,
  ligado: true,
  base: "https://crm.exemplo.com.br",
  chamadas: [] as unknown[],
  resultado: {} as unknown,
  auditorias: [] as Array<Record<string, unknown>>,
  /** O que a SESSÃO de quem pede lê em `conversations` (a policy já aplicada). */
  leituraDaSessao: {} as Resposta,
  sessao: undefined as unknown as BancoFalso,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    h.autorizado
      ? {
          ok: true,
          user: { id: "cccccccc-0000-4000-8000-0000000000ee" },
          org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "agent" },
        }
      : { ok: false, response: new Response("{}", { status: 403 }) },
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligado }));
vi.mock("@/lib/env", () => ({
  env: {
    get NEXT_PUBLIC_APP_URL() {
      return h.base;
    },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.sessao.cliente }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    h.auditorias.push(entrada);
  },
}));
vi.mock("@/lib/pagamentos/registrar", () => ({
  registrarRecebimento: async (_admin: unknown, entrada: unknown) => {
    h.chamadas.push(entrada);
    return h.resultado;
  },
}));

import { POST } from "./route";

const ORG = "cccccccc-0000-4000-8000-000000000001";
const CONV = "cccccccc-0000-4000-8000-000000000002";
const REC = "cccccccc-0000-4000-8000-000000000005";
const TOKEN = "segredo-deste-recebimento-com-43-caracteres-x";

const pedir = (corpo: Record<string, unknown> = { provedor: "infinitepay", valor_cents: 15000 }, conversa = CONV) =>
  POST(
    new NextRequest(`http://localhost/api/v1/conversations/${conversa}/pagamentos`, {
      method: "POST",
      body: JSON.stringify(corpo),
    }),
    { params: Promise.resolve({ id: conversa }) },
  );

const sucesso = {
  ok: true,
  token: TOKEN,
  recebimento: {
    id: REC,
    organization_id: ORG,
    conversation_id: CONV,
    lead_id: null,
    provedor: "infinitepay",
    external_id: null,
    valor_cents: 15000,
    moeda: "BRL",
    status: "pendente",
    pago_em: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.autorizado = true;
  h.ligado = true;
  h.base = "https://crm.exemplo.com.br";
  h.chamadas = [];
  h.auditorias = [];
  h.resultado = sucesso;
  h.leituraDaSessao = { data: { id: CONV } };
  h.sessao = bancoFalso(() => h.leituraDaSessao);
});

describe("POST /api/v1/conversations/[id]/pagamentos", () => {
  it("⭐ registra e entrega a URL do aviso: id do recebimento e segredo, uma vez, sem cache", async () => {
    const r = await pedir();
    expect(r.status).toBe(201);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const { data } = (await r.json()) as { data: { url_do_aviso: string; recebimento_id: string } };
    const url = new URL(data.url_do_aviso);
    expect(url.origin + url.pathname).toBe("https://crm.exemplo.com.br/api/v1/webhooks/pagamento/infinitepay");
    expect(url.searchParams.get("r")).toBe(REC);
    expect(url.searchParams.get("t")).toBe(TOKEN);
    expect(h.chamadas).toEqual([{ organizationId: ORG, conversationId: CONV, provedor: "infinitepay", valorCents: 15000 }]);
  });

  it("⭐ auditoria do registro sem o segredo", async () => {
    await pedir();
    expect(h.auditorias).toHaveLength(1);
    expect(h.auditorias[0]).toMatchObject({ action: "pagamento.link_registrado", organizationId: ORG, resourceId: REC });
    expect(JSON.stringify(h.auditorias)).not.toContain(TOKEN);
  });

  it("⭐ módulo desligado: 404 e nada registrado", async () => {
    h.ligado = false;
    expect((await pedir()).status).toBe(404);
    expect(h.chamadas).toEqual([]);
  });

  it("⭐ instalação sem endereço https público: 503 ANTES de gravar (o aviso nunca chegaria)", async () => {
    for (const base of ["http://localhost:3000", "https://placeholder.invalid"]) {
      h.base = base;
      const r = await pedir();
      expect(r.status).toBe(503);
    }
    expect(h.chamadas).toEqual([]);
  });

  it("sem papel de agent: a resposta do RBAC, e nada registrado", async () => {
    h.autorizado = false;
    expect((await pedir()).status).toBe(403);
    expect(h.chamadas).toEqual([]);
  });

  it("corpo com campo a mais (o organization_id do corpo NUNCA vale): 400", async () => {
    const r = await pedir({ provedor: "infinitepay", valor_cents: 15000, organization_id: "outra" });
    expect(r.status).toBe(400);
    expect(h.chamadas).toEqual([]);
  });

  it.each([{ provedor: "outro", valor_cents: 100 }, { provedor: "infinitepay", valor_cents: 0 }])(
    "pedido inválido %j: 400",
    async (corpo) => {
      expect((await pedir(corpo)).status).toBe(400);
      expect(h.chamadas).toEqual([]);
    },
  );

  it.each(["12a", "USD", "brl"])("⭐ moeda %j: 400 e nada registrado (só BRL)", async (moeda) => {
    const r = await pedir({ provedor: "infinitepay", valor_cents: 15000, moeda });
    expect(r.status).toBe(400);
    expect(h.chamadas).toEqual([]);
  });

  it("controle: moeda BRL explícita registra", async () => {
    const r = await pedir({ provedor: "infinitepay", valor_cents: 15000, moeda: "BRL" });
    expect(r.status).toBe(201);
    expect(h.chamadas).toEqual([{ organizationId: ORG, conversationId: CONV, provedor: "infinitepay", valorCents: 15000, moeda: "BRL" }]);
  });

  it("conversa que não é uuid: 400", async () => {
    expect((await pedir(undefined, "nao-e-uuid")).status).toBe(400);
  });

  it("⭐ a conversa é lida com a SESSÃO de quem pede, pelo id e pela organização da sessão", async () => {
    await pedir();
    const leituras = h.sessao.cadeias.filter((c) => c.tabela === "conversations");
    expect(leituras).toHaveLength(1);
    const filtros = leituras[0]!.passos.filter((p) => p.metodo === "eq").map((p) => p.args);
    expect(filtros).toContainEqual(["id", CONV]);
    expect(filtros).toContainEqual(["organization_id", ORG]);
  });

  it("⭐ conversa que a sessão não enxerga (fora do escopo do atendente): 404 e nada gravado", async () => {
    h.leituraDaSessao = { data: null };
    const r = await pedir();
    expect(r.status).toBe(404);
    expect(h.chamadas).toEqual([]);
    expect(h.auditorias).toEqual([]);
  });

  it("leitura da conversa pela sessão falhou: 500 e nada gravado", async () => {
    h.leituraDaSessao = { error: { code: "XX000", message: "queda" } };
    expect((await pedir()).status).toBe(500);
    expect(h.chamadas).toEqual([]);
  });

  it("recusa do registro (conversa de outra empresa): repassa o 404", async () => {
    h.resultado = { ok: false, code: "not_found", message: "Conversa não encontrada.", status: 404 };
    expect((await pedir()).status).toBe(404);
    expect(h.auditorias).toEqual([]);
  });
});
