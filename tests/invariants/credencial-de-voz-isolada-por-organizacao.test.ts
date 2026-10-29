import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_MANAGER, GOV_ORG, GOV_VIEWER, seedGov, sql } from "./gov-helpers";

/**
 * A CHAVE DE VOZ (Google Cloud Text-to-Speech) NO BANCO REAL.
 *
 * A chave de voz não ganhou tabela nem migration: é uma linha de
 * `ai_provider_credentials` com `provider = 'google-tts'` (coluna aberta desde a
 * 0127). Os testes unitários (`tests/unit/voz-rotas.test.ts`) provam as rotas
 * com um banco simulado; aqui se prova que a MESMA RLS, a MESMA view segura e o
 * MESMO grant por coluna que protegem as chaves de IA valem para ela, com duas
 * organizações de verdade e o papel `authenticated` do PostgREST:
 *
 *   - quem é da organização lê a linha pela view segura, com os 4 últimos;
 *   - ninguém alcança `api_key_encrypted/iv/tag` pelo PostgREST;
 *   - o admin de OUTRA organização não lê, não altera e não apaga;
 *   - quem não é admin não escreve; o admin da própria organização escreve;
 *   - `anon` não vê nada.
 *
 * Arquivo novo (os irmãos são congelados por `loop/hooks/freeze-invariants.sh`).
 */

const PROVEDOR_DA_VOZ = "google-tts";
const ORG_B = "cccccccc-0000-4000-8000-0000000000b9";
const ADMIN_B = "cccccccc-1111-4000-8000-0000000000b9";
const VOZ_A = "eeeeeeee-7070-4000-8000-00000000000a";
const VOZ_B = "eeeeeeee-7070-4000-8000-00000000000b";

/** Roda como `authenticated` com o JWT de `userId`; devolve a saída, ou null se o comando ERROU. */
function como(userId: string, comando: string): string | null {
  try {
    return sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false);
      ${comando}
    `);
  } catch {
    return null;
  }
}

function comoAnon(comando: string): string | null {
  try {
    return sql(`
      set role anon;
      select set_config('request.jwt.claims', '{"role":"anon"}', false);
      ${comando}
    `);
  } catch {
    return null;
  }
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values ('${ADMIN_B}', 'voz-admin-b@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'voz-inv-b', 'Voz Invariant Org B', 'Voz B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_B}', '${ORG_B}', 'admin', now()) on conflict do nothing;
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, validated_at)
      values
        ('${VOZ_A}', '${GOV_ORG}', '${PROVEDOR_DA_VOZ}', 'Google Cloud Text-to-Speech',
         '\\xa1'::bytea, '\\xa2'::bytea, '\\xa3'::bytea, 'aaaa', now()),
        ('${VOZ_B}', '${ORG_B}', '${PROVEDOR_DA_VOZ}', 'Google Cloud Text-to-Speech',
         '\\xb1'::bytea, '\\xb2'::bytea, '\\xb3'::bytea, 'bbbb', now())
      on conflict do nothing;
  `);
});

describe("chave de voz — leitura pela view segura, só da própria organização", () => {
  it("CONTROLE: a linha google-tts existe nas duas organizações (o banco aceitou o provider sem migration)", () => {
    const n = sql(`select count(*) from public.ai_provider_credentials where provider = '${PROVEDOR_DA_VOZ}';`);
    expect(Number(n.trim().split("\n").pop())).toBe(2);
  });

  it("manager e viewer da organização leem a máscara pela view segura", () => {
    for (const quem of [GOV_MANAGER, GOV_VIEWER, GOV_ADMIN]) {
      const saida = como(
        quem,
        `select api_key_last4 from public.ai_provider_credentials_safe where provider = '${PROVEDOR_DA_VOZ}';`,
      );
      expect(saida, `usuário ${quem} foi barrado`).not.toBeNull();
      expect(String(saida)).toContain("aaaa");
      // Só a da própria organização: a da B não aparece.
      expect(String(saida)).not.toContain("bbbb");
    }
  });

  it("⭐ o admin da OUTRA organização não enxerga a chave de voz desta", () => {
    const saida = como(
      ADMIN_B,
      `select api_key_last4 from public.ai_provider_credentials_safe where provider = '${PROVEDOR_DA_VOZ}';`,
    );
    expect(String(saida ?? "")).toContain("bbbb");
    expect(String(saida ?? "")).not.toContain("aaaa");
    const direto = como(ADMIN_B, `select count(*) from public.ai_provider_credentials_safe where id = '${VOZ_A}';`);
    expect(String(direto ?? "").trim().split("\n").pop()).toBe("0");
  });

  it("anon não vê chave de voz nenhuma", () => {
    const saida = comoAnon(`select count(*) from public.ai_provider_credentials_safe where provider = '${PROVEDOR_DA_VOZ}';`);
    // Barrado (null) ou zero linhas: as duas leituras são "não vê".
    expect(saida === null || saida.trim().split("\n").pop() === "0").toBe(true);
  });
});

describe("chave de voz — o segredo não sai pelo PostgREST", () => {
  it.each(["api_key_encrypted", "api_key_iv", "api_key_tag"])("⭐ nem o admin da própria organização alcança %s", (coluna) => {
    expect(
      como(GOV_ADMIN, `select ${coluna} from public.ai_provider_credentials where id = '${VOZ_A}';`),
      `o admin alcançou ${coluna} pelo papel authenticated — o grant por coluna foi desfeito`,
    ).toBeNull();
  });

  it("a view segura não tem coluna de segredo", () => {
    const colunas = sql(`
      select string_agg(column_name, ',') from information_schema.columns
       where table_schema = 'public' and table_name = 'ai_provider_credentials_safe';
    `);
    expect(colunas).toContain("api_key_last4");
    expect(colunas).not.toMatch(/api_key_(encrypted|iv|tag)/);
  });
});

describe("chave de voz — escrita só pelo admin da própria organização", () => {
  it("⭐ o admin da OUTRA organização não altera nem apaga a chave desta", () => {
    const alterou = como(
      ADMIN_B,
      `update public.ai_provider_credentials set api_key_last4 = 'XXXX' where id = '${VOZ_A}' returning id;`,
    );
    expect(String(alterou ?? "")).not.toContain(VOZ_A);
    const apagou = como(ADMIN_B, `delete from public.ai_provider_credentials where id = '${VOZ_A}' returning id;`);
    expect(String(apagou ?? "")).not.toContain(VOZ_A);
    // CONTROLE: a linha segue lá, intacta.
    expect(sql(`select api_key_last4 from public.ai_provider_credentials where id = '${VOZ_A}';`)).toContain("aaaa");
  });

  it("⭐ o admin da OUTRA organização não cria chave de voz nesta", () => {
    const criou = como(
      ADMIN_B,
      `insert into public.ai_provider_credentials
         (organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4)
         values ('${GOV_ORG}', '${PROVEDOR_DA_VOZ}', 'Intrusa', '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, 'zzzz')
         returning id;`,
    );
    expect(criou).toBeNull();
    const n = sql(`select count(*) from public.ai_provider_credentials where organization_id = '${GOV_ORG}' and label = 'Intrusa';`);
    expect(n.trim().split("\n").pop()).toBe("0");
  });

  it("manager da própria organização não apaga", () => {
    const apagou = como(GOV_MANAGER, `delete from public.ai_provider_credentials where id = '${VOZ_A}' returning id;`);
    expect(String(apagou ?? "")).not.toContain(VOZ_A);
    expect(sql(`select count(*) from public.ai_provider_credentials where id = '${VOZ_A}';`).trim().split("\n").pop()).toBe("1");
  });

  it("CONTROLE POSITIVO: o admin da própria organização altera a sua (a RLS não barrou todo mundo)", () => {
    const alterou = como(
      GOV_ADMIN,
      `update public.ai_provider_credentials set validated_at = null where id = '${VOZ_A}' returning id;`,
    );
    expect(String(alterou ?? "")).toContain(VOZ_A);
  });
});
