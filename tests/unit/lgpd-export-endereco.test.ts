// @vitest-environment node
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * O ENDEREÇO DA PESSOA FÍSICA SAI NO ACESSO DO TITULAR (issue #3494).
 *
 * A anonimização apaga as colunas de endereço de `contacts`
 * (`trg_contato_anonimizado_esquece_o_endereco`); pela regra de
 * `lgpd-exporta-o-que-redige.test.ts`, o que se apaga a pedido do titular é o
 * que se entrega a pedido dele. Aqui o caminho inteiro: o coletor PEDE as
 * colunas ao banco, o `data.json` as leva, e o PDF — que é o que o titular no
 * Brasil recebe — as imprime.
 *
 * O banco falso devolve só as colunas pedidas no `select` — senão a linha
 * chegaria inteira e o teste ficaria verde mesmo com a coluna fora da consulta.
 */

const ENDERECO = {
  zip_code: "80000-000",
  street: "Rua XV de Novembro",
  number: "120",
  complement: "apto 42",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
};

const LINHA = {
  id: "c1",
  name: "Lia",
  display_name: null,
  email: null,
  phone_number: "+5541999998888",
  created_at: "2026-01-02T03:04:05.000Z",
  ...ENDERECO,
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
import { renderLgpdPdf } from "@/lib/lgpd/pdf-renderer";

async function textoDoPdf(bytes: Uint8Array | Buffer): Promise<string> {
  const fonts =
    join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + sep;
  const task = getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: fonts });
  const documento = await task.promise;
  try {
    const paginas: string[] = [];
    for (let n = 1; n <= documento.numPages; n++) {
      const conteudo = await (await documento.getPage(n)).getTextContent();
      paginas.push(conteudo.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return paginas.join("\n").replace(/\s+/g, " ");
  } finally {
    await task.destroy();
  }
}

describe("export LGPD: o endereço da pessoa física", () => {
  it("sai no contato do data.json e no PDF", async () => {
    const p = await collectExportData({
      organizationId: "org-1",
      requestId: "r1",
      contactId: "c1",
      externalCustomerId: null,
    });
    // CONTROLE: o contato foi lido (senão o caso abaixo seria vazio por outro motivo).
    expect(p.contact?.phone_number).toBe("+5541999998888");
    expect(p.contact).toMatchObject(ENDERECO);

    const texto = await textoDoPdf(await renderLgpdPdf(p));
    expect(texto).toContain("Rua XV de Novembro, 120, apto 42, Centro, Curitiba, PR, 80000-000");
  });
});
