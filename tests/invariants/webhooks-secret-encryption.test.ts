/**
 * Migration 0041 — cifragem at-rest dos secrets de webhooks.
 *
 * Prova as 4 propriedades do retrofit:
 *  1. A coluna plaintext `webhook_sources.secret` NÃO existe mais;
 *     `secret_encrypted` (bytea) existe.
 *  2. Roundtrip fn_encrypt_oauth/fn_decrypt_oauth com a GUC configurada.
 *  3. Data-fix do jsonb: regra com `config.secret` plaintext (dado
 *     pré-migração) reescrita pela PRÓPRIA migration (arquivo real, aplicado
 *     de novo — idempotência inclusa) para `config.secret_enc` decifrável.
 *  4. Sem a chave (GUC vazia na sessão): o data-fix DESCARTA o plaintext
 *     (warning) em vez de mantê-lo — nunca fica secret em claro.
 *
 * Namespace de fixtures 'ffffffff-c*' (colisões entre arquivos já morderam:
 * ver webhooks-bulk-events vs gov-5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

const ORG = "ffffffff-c000-4000-8000-000000000001";
const RULE_WITH_KEY = "ffffffff-c100-4000-8000-000000000001";
const RULE_NO_KEY = "ffffffff-c100-4000-8000-000000000002";
const GUC_KEY = "test-guc-key-0123456789abcdef0123456789abcdef";
const SET_KEY = `select set_config('app.nuvemshop_oauth_key', '${GUC_KEY}', false);`;

const migrationSql = readFileSync(
  join(__dirname, "../../supabase/migrations/20260718150000_0041_webhook_secret_encryption.sql"),
  "utf8",
);

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'gov-inv-secenc', 'Secret Enc Org', 'Secret Enc')
      on conflict do nothing;
    insert into public.automation_rules (id, organization_id, name, trigger_event, conditions, actions)
      values
        ('${RULE_WITH_KEY}', '${ORG}', 'legacy plaintext (com chave)', 'lead.created', '[]'::jsonb,
         '[{"type":"call_webhook","config":{"url":"https://example.com/a","secret":"legacy-plain-1"}},{"type":"add_tag","config":{"tags":["x"]}}]'::jsonb),
        ('${RULE_NO_KEY}', '${ORG}', 'legacy plaintext (sem chave)', 'lead.created', '[]'::jsonb,
         '[{"type":"call_webhook","config":{"url":"https://example.com/b","secret":"legacy-plain-2"}}]'::jsonb)
      on conflict (id) do update set actions = excluded.actions;
  `);
});

describe("migration 0041 — cifragem at-rest dos secrets", () => {
  it("1. coluna plaintext dropada; secret_encrypted (bytea) existe", () => {
    const cols = sql(
      `select column_name || ':' || data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'webhook_sources'
          and column_name in ('secret', 'secret_encrypted');`,
    ).trim();
    expect(cols).toBe("secret_encrypted:bytea");
  });

  it("2. roundtrip encrypt→decrypt com a GUC", () => {
    // sql() devolve também a linha do set_config — a resposta é a última linha.
    const out = sql(
      `${SET_KEY}
       select public.fn_decrypt_oauth(public.fn_encrypt_oauth('meu-segredo-123'));`,
    )
      .trim()
      .split("\n")
      .pop();
    expect(out).toBe("meu-segredo-123");
  });

  it("3. data-fix reescreve config.secret → secret_enc decifrável (migration real, re-aplicada)", () => {
    sql(`${SET_KEY}\n${migrationSql}`);
    const row = sql(
      `${SET_KEY}
       select (a->'config' ? 'secret')::text || '|' || (a->'config' ? 'secret_enc')::text || '|' ||
              public.fn_decrypt_oauth(decode(a#>>'{config,secret_enc}', 'hex'))
         from public.automation_rules r, jsonb_array_elements(r.actions) a
        where r.id = '${RULE_WITH_KEY}' and a->>'type' = 'call_webhook';`,
    )
      .trim()
      .split("\n")
      .pop();
    expect(row).toBe("false|true|legacy-plain-1");
    // ação vizinha (add_tag) intacta
    const other = sql(
      `select a->'config'->>'tags' is not null from public.automation_rules r,
        jsonb_array_elements(r.actions) a
        where r.id = '${RULE_WITH_KEY}' and a->>'type' = 'add_tag';`,
    ).trim();
    expect(other).toBe("t");
  });

  it("4. sem chave na GUC: plaintext é DESCARTADO, nunca mantido em claro", () => {
    // O caso 3 cifrou TODAS as regras — re-seeda esta como plaintext
    // pré-migração antes de rodar o cenário sem chave.
    sql(`
      update public.automation_rules
        set actions = '[{"type":"call_webhook","config":{"url":"https://example.com/b","secret":"legacy-plain-2"}}]'::jsonb
        where id = '${RULE_NO_KEY}';
    `);
    // set_config('') na sessão anula a chave herdada do database p/ este batch.
    sql(
      `select set_config('app.nuvemshop_oauth_key', '', false);\n${migrationSql}`,
    );
    const row = sql(
      `select (a->'config' ? 'secret')::text || '|' || (a->'config' ? 'secret_enc')::text
         from public.automation_rules r, jsonb_array_elements(r.actions) a
        where r.id = '${RULE_NO_KEY}' and a->>'type' = 'call_webhook';`,
    ).trim();
    expect(row).toBe("false|false");
  });
});
