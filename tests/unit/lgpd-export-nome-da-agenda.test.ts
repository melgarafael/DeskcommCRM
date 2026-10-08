import { describe, expect, it, vi } from "vitest";

/**
 * O NOME DA AGENDA DO CELULAR SAI NO ACESSO DO TITULAR (PR #2439).
 *
 * `contacts.address_book_name` é o rótulo que alguém da empresa salvou no
 * celular. A anonimização o apaga (`trg_contato_anonimizado_esquece_a_agenda`);
 * pela regra de `lgpd-exporta-o-que-redige.test.ts`, o que se apaga a pedido do
 * titular é o que se entrega a pedido dele.
 *
 * Quem recebe o `data.json` é o titular FORA do Brasil (o worker só assina a
 * ligação do arquivo quando o país não é o padrão). No Brasil o arquivo fica
 * guardado sem ser enviado, e o PDF — que é o que sai — não lê este campo.
 *
 * O banco falso devolve só as colunas pedidas no `select` — senão a linha
 * chegaria inteira e o teste ficaria verde mesmo com a coluna fora da consulta.
 */

const LINHA = {
  id: "c1",
  name: null,
  display_name: null,
  address_book_name: "Maria caloteira",
  email: null,
  phone_number: "+5511999998888",
  created_at: "2026-01-02T03:04:05.000Z",
};

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const org = { legal_name: "Bem Viver LTDA", display_name: "Bem Viver", country: null, timezone: "America/Sao_Paulo" };
    const consulta = (tabela: string): unknown => {
      let colunas: string[] | null = null;
      const linha = (): Record<string, unknown> | null => {
        if (tabela === "organizations") return org;
        if (tabela !== "contacts" || colunas === null) return null;
        const pedidas = colunas;
        return Object.fromEntries(Object.entries(LINHA).filter(([k]) => pedidas.includes(k)));
      };
      const q: unknown = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "then")
              return (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
                Promise.resolve({ data: tabela === "organizations" ? [org] : [], error: null, count: 0 }).then(ok, erro);
            if (prop === "maybeSingle" || prop === "single") return async () => ({ data: linha(), error: null });
            if (prop === "select")
              return (sel?: string) => {
                if (typeof sel === "string") colunas = sel.split(",").map((c) => c.trim());
                return q;
              };
            return () => q;
          },
        },
      );
      return q;
    };
    return { from: consulta, rpc: async () => ({ data: null, error: null }) };
  },
}));

import { collectExportData } from "@/lib/lgpd/export-collector";

describe("export LGPD: o nome da agenda do celular", () => {
  it("sai no contato do data.json, no campo próprio", async () => {
    const p = await collectExportData({
      organizationId: "org-1",
      requestId: "r1",
      contactId: "c1",
      externalCustomerId: null,
    });
    // CONTROLE: o contato foi lido (senão o caso abaixo seria vazio por outro motivo).
    expect(p.contact?.phone_number).toBe("+5511999998888");
    expect(p.contact?.address_book_name).toBe("Maria caloteira");
  });
});
