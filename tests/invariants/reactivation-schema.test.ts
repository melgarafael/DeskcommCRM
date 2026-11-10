import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O que a 0082 promete, cobrado no banco que o clone recebe.
 *
 * ⚠️ CADA CASO É ISOLADO DO VIZINHO, e isso não é preciosismo: no primeiro
 * ataque, "status inválido" foi rejeitado por `decisao_datada` e NÃO por
 * `status_check` — porque um status não-pendente exige `decided_at`, e eu não
 * passei. O caso passava pelo motivo errado e o `status_check` seguia sem prova.
 * Rejeitar não é o veredito; rejeitar PELA TRAVA CERTA é.
 */
function violacao(colunas: string, valores: string): string {
  const lead = sql(`select id from public.crm_leads limit 1`).split("\n")[0]!.trim();
  const org = sql(`select organization_id from public.crm_leads where id = '${lead}'`)
    .split("\n")[0]!
    .trim();
  const saida = sql(`
    begin;
    insert into public.crm_lead_reactivations (lead_id, organization_id, ${colunas})
      values ('${lead}', '${org}', ${valores});
    rollback;
  `).toLowerCase();
  const m = /constraint "([a-z_]+)"/.exec(saida);
  return m ? m[1]! : "aceitou";
}

describe("0082 · proposta de reativação chega ao clone", () => {
  it("a tabela existe no baseline, não só na migration", () => {
    expect(
      sql(`select count(*) from information_schema.tables
            where table_schema='public' and table_name='crm_lead_reactivations'`),
    ).toBe("1");
  });

  it("não existe proposta SEM PRAZO — é o bloco obrigatório, no banco", () => {
    // A coluna é NOT NULL: omitir `expires_at` não pode ser um caminho.
    expect(
      sql(`select is_nullable from information_schema.columns
            where table_name='crm_lead_reactivations' and column_name='expires_at'`),
    ).toBe("NO");
  });

  it("uma proposta VIVA por negócio — e as decididas não bloqueiam a próxima", () => {
    const idx = sql(`select indexdef from pg_indexes
                      where indexname='uq_crm_lead_reactivations_uma_viva'`);
    expect(idx).toContain("UNIQUE");
    // O `where` parcial é o que permite o negócio esfriar DE NOVO. Sem ele, um
    // negócio reativado uma vez nunca mais receberia proposta.
    expect(idx.toLowerCase()).toContain("where (status = 'pending'");
  });

  it("RLS ligada e policy de tenant", () => {
    expect(
      sql(`select relrowsecurity from pg_class where relname='crm_lead_reactivations'`),
    ).toBe("t");
    expect(
      sql(`select count(*) from pg_policies
            where tablename='crm_lead_reactivations'
              and policyname='tenant_isolation_crm_lead_reactivations_all'`),
    ).toBe("1");
  });

  it("FORA da publicação de realtime — nenhuma tela assina proposta (#3697)", () => {
    // A 0082 publicou a tabela pela regra "mudança de estado pinta o card" — mas
    // o card é do NEGÓCIO (`crm_leads`), e nenhuma tela abriu canal nesta. Publicada
    // sem consumidor, cada escrita era decodificada pelo Realtime e descartada. A
    // 9046 tirou; `tests/unit/realtime-assinatura-tem-publicacao.test.ts` guarda o
    // outro lado (se alguém voltar a assinar, tem que republicar).
    expect(
      sql(`select count(*) from pg_publication_tables
            where pubname='supabase_realtime' and tablename='crm_lead_reactivations'`),
    ).toBe("0");
  });
});
