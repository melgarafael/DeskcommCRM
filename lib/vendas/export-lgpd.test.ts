/**
 * O PEDIDO DE ACESSO ENTREGA AS VENDAS REGISTRADAS DO TITULAR (#5087).
 *
 * A anonimização limpa `observacao` e `tags` de `vendas_registradas` pelo
 * `contact_id` (trigger `fn_vendas_do_contato_anonimizado`). O que se apaga a
 * pedido dele é o que se entrega a pedido dele: o export lê a MESMA tabela pelo
 * MESMO `contact_id`, e a seção só aparece quando há linha (o data.json de quem
 * não registrou venda fica como antes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  vendas: [] as unknown[],
  filtros: [] as Array<[string, unknown]>,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://synthetic.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const objeto =
        tabela === "organizations"
          ? { legal_name: "Empresa Sintética", country: "BR", timezone: "America/Sao_Paulo" }
          : tabela === "contacts"
            ? { id: "contato-a", name: "Pessoa Sintética", custom_fields: {}, tags: [], source_metadata: {} }
            : null;
      const linhas = tabela === "vendas_registradas" ? estado.vendas : [];
      const q: unknown = new Proxy(
        {},
        {
          get: (_, prop) => {
            if (prop === "then")
              return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
                Promise.resolve({ data: linhas, error: null, count: 0 }).then(ok, falha);
            if (prop === "maybeSingle" || prop === "single") return async () => ({ data: objeto, error: null });
            if (prop === "eq" && tabela === "vendas_registradas")
              return (coluna: string, valor: unknown) => {
                estado.filtros.push([coluna, valor]);
                return q;
              };
            return () => q;
          },
        },
      );
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { collectExportData } from "@/lib/lgpd/export-collector";

const args = { organizationId: "org-sintetica", requestId: "pedido-sintetico", contactId: "contato-a", externalCustomerId: null };

beforeEach(() => {
  estado.vendas = [];
  estado.filtros = [];
});

describe("export LGPD: vendas registradas", () => {
  it("entrega as vendas do contato, lidas pela organização E pelo contact_id", async () => {
    estado.vendas = [
      { id: "v1", lead_id: "l1", valor_cents: 10_000, currency: "BRL", data: "2026-11-21", tags: ["atacado"], observacao: "pagou no pix", created_at: "2026-11-21T12:00:00Z" },
    ];
    const data = await collectExportData(args);
    expect(data.vendas_registradas).toEqual([expect.objectContaining({ id: "v1", valor_cents: 10_000, observacao: "pagou no pix" })]);
    expect(estado.filtros).toContainEqual(["organization_id", "org-sintetica"]);
    expect(estado.filtros).toContainEqual(["contact_id", "contato-a"]);
  });

  it("sem venda: a seção não aparece", async () => {
    const data = await collectExportData(args);
    expect(data).not.toHaveProperty("vendas_registradas");
  });
});
