/**
 * A conversa aberta numa conexão de SMS nasce `channel = 'sms'` (#4415), em
 * QUALQUER caminho — não só no SMS recebido.
 *
 * `fn_upsert_wa_conversation` é o ponto único de abertura de conversa 1:1 por
 * conexão (SMS recebido, automação, lembrete da agenda, envio por telefone,
 * campanha), e gravava 'whatsapp' fixo. Este teste lê o que o banco INSTALA —
 * a ÚLTIMA definição no baseline, como manda a doutrina de migrations — e
 * confere que a migration 9364 traz o mesmo corpo. A prova contra um Postgres
 * de verdade é do `test:db`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const ASSINATURA = "create or replace function public.fn_upsert_wa_conversation(";

function ultimaDefinicao(sql: string): string {
  const i = sql.lastIndexOf(ASSINATURA);
  expect(i, "a função sumiu do arquivo").toBeGreaterThanOrEqual(0);
  return sql.slice(i, sql.indexOf("end; $$;", i) + "end; $$;".length);
}

describe("conversa de SMS nasce sms", () => {
  const baseline = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
  const arquivo = readdirSync(join(RAIZ, "supabase", "migrations")).find((n) => /_9364_canal_de_sms\.sql$/.test(n));
  const migration = readFileSync(join(RAIZ, "supabase", "migrations", arquivo ?? "inexistente"), "utf8");

  it("a definição que o banco instala tira o canal da conexão, e SMS vira 'sms'", () => {
    const corpo = ultimaDefinicao(baseline);
    expect(corpo).toMatch(/when s\.provider = 'twilio' then 'sms' else 'whatsapp'/);
    expect(corpo).toMatch(/s\.organization_id = p_org/);
    expect(corpo).toMatch(/coalesce\(v_canal, 'whatsapp'\)/);
    expect(corpo).not.toMatch(/values \(p_org, p_contact, p_session, 'whatsapp'/);
  });

  it("a migration traz o mesmo corpo do baseline", () => {
    expect(ultimaDefinicao(migration)).toBe(ultimaDefinicao(baseline));
  });
});
