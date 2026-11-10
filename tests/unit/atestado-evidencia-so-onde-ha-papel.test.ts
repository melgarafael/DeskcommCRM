// @vitest-environment node
/**
 * A EVIDÊNCIA DO ATO (quem aprovou, de qual IP) SÓ É GRAVADA ONDE VIRA PAPEL.
 *
 * A rota de aprovação é o único ponto que vê o operador e o IP dele, e grava os
 * dois em `request_payload.execucao` para o worker imprimir no atestado. Mas o
 * atestado só existe para pedido de EXCLUSÃO de organização de FORA do Brasil
 * (decisão de 2026-10-16). Gravar a evidência em toda aprovação manual deixava
 * dado de quem opera guardado — e exposto nas rotas de detalhe, que devolvem
 * `request_payload` — no Brasil e em pedido de dados, onde ninguém o lê.
 *
 * Os dois sentidos com a rota REAL e um dublê de banco: o país vem da coluna
 * `organizations.country`, lida pelo `perfilDaOrganizacao` real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => {
  const estado = {
    pais: "PT",
    tipo: "redact",
    /** Os `update` em `lgpd_requests` — é neles que `request_payload` aparece ou não. */
    atualizacoes: [] as Array<Record<string, unknown>>,
  };

  function criar() {
    return {
      from(tabela: string) {
        const resposta = () => {
          if (tabela === "organizations") return { data: { country: estado.pais }, error: null };
          if (tabela === "lgpd_requests") {
            return {
              data: {
                id: "pedido-1",
                organization_id: "org-1",
                request_type: estado.tipo,
                status: "received",
                contact_id: "contato-1",
                external_customer_id: null,
                due_at: "2026-11-05T00:00:00.000Z",
                request_payload: { origem: "painel" },
              },
              error: null,
            };
          }
          return { data: null, error: null };
        };
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: () => cadeia,
          insert: () => cadeia,
          update: (payload: Record<string, unknown>) => {
            if (tabela === "lgpd_requests") estado.atualizacoes.push(payload);
            return cadeia;
          },
          maybeSingle: async () => resposta(),
          single: async () => ({ data: { id: "k1" }, error: null }),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(res, rej),
        };
        return cadeia;
      },
      rpc: async () => ({ data: null, error: null }),
    };
  }

  return { estado, criar };
});

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "u1", email: "ana@loja.test", full_name: "Ana Lima", idioma: "pt-BR" },
    org: { orgId: "org-1", role: "admin" },
  })),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.criar() }));

import { POST } from "@/app/api/v1/lgpd/requests/[id]/approve/route";

async function aprovar(): Promise<Record<string, unknown>> {
  const req = new NextRequest("http://localhost/api/v1/lgpd/requests/pedido-1/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "11111111-2222-4333-8444-555555555555",
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ approved_reason: "pedido conferido com o titular" }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: "pedido-1" }) });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(h.estado.atualizacoes, "a rota não passou o pedido para processing").toHaveLength(1);
  const update = h.estado.atualizacoes[0]!;
  expect(update.status).toBe("processing");
  return update;
}

beforeEach(() => {
  h.estado.atualizacoes.length = 0;
});

describe("a rota de aprovação grava quem aprovou só quando vai virar atestado", () => {
  it("exclusão em Portugal: grava a evidência do ato, sem o user-agent", async () => {
    h.estado.pais = "PT";
    h.estado.tipo = "redact";

    const update = await aprovar();

    const payload = update.request_payload as Record<string, unknown>;
    // O que o pedido já tinha é preservado; a evidência entra ao lado.
    expect(payload.origem).toBe("painel");
    expect(payload.execucao).toMatchObject({
      origem: "aprovacao_manual",
      executor: { user_id: "u1", nome: "Ana Lima", email: "ana@loja.test" },
      em: expect.any(String),
    });
    expect(Object.prototype.hasOwnProperty.call(payload.execucao, "user_agent")).toBe(false);
  });

  it("exclusão no Brasil: não grava quem aprovou nem de qual IP", async () => {
    h.estado.pais = "BR";
    h.estado.tipo = "redact";

    const update = await aprovar();

    expect(Object.prototype.hasOwnProperty.call(update, "request_payload")).toBe(false);
  });

  it("pedido de dados em Portugal: nunca gera atestado, então também não grava", async () => {
    h.estado.pais = "PT";
    h.estado.tipo = "data_request";

    const update = await aprovar();

    expect(Object.prototype.hasOwnProperty.call(update, "request_payload")).toBe(false);
  });
});
