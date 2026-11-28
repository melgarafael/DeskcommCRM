/**
 * ENVIAR UMA PROPOSTA NÃO SOBRESCREVE O VALOR DE UM NEGÓCIO QUE JÁ TEM VENDA (#5254).
 *
 * Com venda registrada (`valor_pelas_vendas = true`), `crm_leads.value_cents` é a
 * soma das vendas, gravada pelo gatilho em `vendas_registradas`. O envio da
 * proposta gravava o total dela por cima, e o número ficava errado até a próxima
 * mudança numa venda. Mesma regra que `valor-pelas-vendas-no-patch.test.ts`
 * fixa para o PATCH do lead.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { gravarValorDaPropostaNoNegocio } from "@/lib/propostas/valor-do-negocio";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Um `crm_leads` de uma linha que respeita os filtros `.eq` do UPDATE. */
function bancoComNegocio(negocio: Record<string, unknown>) {
  const linha: Record<string, unknown> = { organization_id: ORG, id: LEAD, ...negocio };
  const db = {
    from: (tabela: string) => {
      if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        update: (valores: Record<string, unknown>) => {
          const filtros: [string, unknown][] = [];
          const escrita = {
            eq: (coluna: string, valor: unknown) => {
              filtros.push([coluna, valor]);
              return escrita;
            },
            select: async () => {
              const casa = filtros.every(([coluna, valor]) => linha[coluna] === valor);
              if (casa) Object.assign(linha, valores);
              return { data: casa ? [{ id: LEAD }] : [], error: null };
            },
          };
          return escrita;
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, linha };
}

describe("enviar uma proposta e o valor do negócio", () => {
  it("com venda registrada, mantém a soma das vendas e diz que nada mudou", async () => {
    const { db, linha } = bancoComNegocio({ value_cents: 10_000, valor_pelas_vendas: true });
    const mudou = await gravarValorDaPropostaNoNegocio(db, { organizationId: ORG, leadId: LEAD, totalCents: 5_000 });
    expect(mudou).toBe(false);
    expect(linha.value_cents).toBe(10_000);
  });

  it("sem venda, grava o total da proposta (o controle)", async () => {
    const { db, linha } = bancoComNegocio({ value_cents: 10_000, valor_pelas_vendas: false });
    const mudou = await gravarValorDaPropostaNoNegocio(db, { organizationId: ORG, leadId: LEAD, totalCents: 5_000 });
    expect(mudou).toBe(true);
    expect(linha.value_cents).toBe(5_000);
  });

  it("a rota de envio grava pelo helper e só registra proposal_value_changed quando o valor mudou", () => {
    const rota = readFileSync("app/api/v1/proposals/[id]/send/route.ts", "utf8");
    expect(rota).toContain("gravarValorDaPropostaNoNegocio(");
    expect(rota).not.toMatch(/from\("crm_leads"\)\.update\(\{ value_cents/);
    expect(rota).toMatch(/if \(valorMudou\) \{\s*await emitLeadActivity\([\s\S]*?type: "proposal_value_changed"/);
  });
});
