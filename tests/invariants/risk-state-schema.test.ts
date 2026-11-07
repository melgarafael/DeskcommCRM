import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O que a migration 0078 PROMETE, cobrado no banco que o clone recebe.
 *
 * POR QUE ISTO EXISTE E NÃO BASTA "a migration passou": eu apliquei a 0078 no
 * banco de desenvolvimento, rodei `npm run test:db` e vi 338 verdes — e 338 é
 * exatamente o número que já me enganou uma vez, quando um script abortou em
 * silêncio e o gate rodou sobre o baseline ANTIGO. Verde de suíte grande não
 * fala sobre a mudança de hoje; ele fala sobre tudo menos ela.
 *
 * O que este arquivo cobra é o par que a doutrina do repo separa: a migration é
 * o CAMINHO (para quem já tem banco), o baseline é o DESTINO (para quem clona).
 * Uma mudança que existe só no primeiro não chega ao self-hoster, e nada
 * reclama — o clone simplesmente não tem a tabela, e descobre no primeiro erro
 * de runtime.
 *
 * ⚠️ A publicação de realtime é a asserção menos óbvia e a mais fácil de perder:
 * `crm_lead_scores` fica FORA dela de propósito (telemetria) — e desde a 9046
 * (#3697) `crm_lead_risk_states` também: nenhuma tela assina a tabela, então
 * publicá-la só custava decodificação. Quem copiar o bloco da 0078 achando que
 * "estado tem que estar na publicação" reintroduz esse custo sem consumidor.
 */
describe("0078 · estado de risco chega ao clone", () => {
  it("a tabela existe no baseline, não só na migration", () => {
    const n = sql(
      `select count(*) from information_schema.tables
        where table_schema = 'public' and table_name = 'crm_lead_risk_states'`,
    );
    expect(n).toBe("1");
  });

  it("as três travas de coerência estão lá, pelo nome", () => {
    const nomes = sql(
      `select conname from pg_constraint
        where conrelid = 'public.crm_lead_risk_states'::regclass and contype = 'c'`,
    ).split("\n");
    // Nomeadas de propósito: "rejeitou" sem saber POR QUÊ passaria igual se a
    // linha caísse por FK, por NOT NULL ou por RLS.
    expect(nomes).toContain("crm_lead_risk_states_bucket_check");
    expect(nomes).toContain("crm_lead_risk_states_since_no_passado");
    expect(nomes).toContain("crm_lead_risk_states_cold_hours_positivo");
  });

  it("RLS ligada e a policy de tenant existe", () => {
    expect(
      sql(`select relrowsecurity from pg_class where relname = 'crm_lead_risk_states'`),
    ).toBe("t");
    expect(
      sql(`select count(*) from pg_policies
            where tablename = 'crm_lead_risk_states'
              and policyname = 'tenant_isolation_crm_lead_risk_states_all'`),
    ).toBe("1");
  });

  it("FORA da publicação de realtime — sem consumidor, não paga decodificação (#3697)", () => {
    // As duas asserções juntas de propósito: nenhuma das duas é telemetria, mas as
    // duas ficam fora — `crm_lead_scores` porque recálculo não pinta card, e
    // `crm_lead_risk_states` porque nenhuma tela assina (9046). Quem "uniformizar"
    // publicando a de risco reintroduz custo por escrita sem consumidor; quem
    // publicar o score reabre o pulso que mente (0075).
    const publicadas = sql(
      `select tablename from pg_publication_tables
        where pubname = 'supabase_realtime'
          and tablename in ('crm_lead_risk_states', 'crm_lead_scores')`,
    ).split("\n").filter(Boolean);
    expect(publicadas).not.toContain("crm_lead_risk_states");
    expect(publicadas).not.toContain("crm_lead_scores");
  });

  it("o índice que o radar usa para listar por org existe", () => {
    expect(
      sql(`select count(*) from pg_indexes
            where tablename = 'crm_lead_risk_states'
              and indexname = 'idx_crm_lead_risk_states_org_bucket'`),
    ).toBe("1");
  });
});
