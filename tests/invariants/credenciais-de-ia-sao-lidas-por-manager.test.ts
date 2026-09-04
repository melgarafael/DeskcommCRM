import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_MANAGER, GOV_ORG, GOV_VIEWER, seedGov, sql } from "./gov-helpers";

/**
 * AS CREDENCIAIS DE IA SÃO LIDAS POR QUEM NÃO É ADMIN — E O SEGREDO NÃO É
 * (migration 0206, issue #292).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A migration 0150 removeu a policy de SELECT por tenancy e deixou
 * `tenant_isolation_ai_provider_credentials_write` como ÚNICA policy da tabela.
 * Em Postgres, `FOR ALL` cobre também a leitura — então a única regra aplicável
 * ao SELECT passou a exigir `fn_role_at_least(organization_id, 'admin')`.
 *
 * A view `ai_provider_credentials_safe` é `security_invoker = true` de propósito
 * (para que a RLS da base valha para quem consulta). Consequência: um `manager`
 * passa na autorização da aplicação, é filtrado para ZERO LINHAS na base, e a
 * tela `/app/ai/credentials` — que não é admin-gated — responde 200 com `[]`.
 * Sem erro, sem aviso: a pessoa conclui que a organização não tem credencial
 * cadastrada.
 *
 * ─── Por que ARQUIVO NOVO, e não um caso no irmão ───────────────────────────
 *
 * `tests/invariants/rbac-config-ia-canais.test.ts` mede a mesma migration e
 * seria o lugar óbvio. Ele é CONGELADO por `loop/hooks/freeze-invariants.sh` —
 * invariante existente não se edita, arquivo novo passa. Esta é a porta certa.
 *
 * ─── O par, e ele é o ponto ─────────────────────────────────────────────────
 *
 * Um teste só com "o manager lê" ficaria verde se o conserto reabrisse a tabela
 * INTEIRA — inclusive as três colunas do segredo. Quem esconde
 * `api_key_encrypted/iv/tag` é o GRANT POR COLUNA da 0150, não a RLS; este
 * arquivo mede as duas metades para que reabrir a leitura não vire reabrir o
 * segredo.
 */

const CRED_LEITURA = "eeeeeeee-3333-4000-8000-000000000001";

function seedCredencial(): void {
  sql(`
    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4)
      values ('${CRED_LEITURA}', '${GOV_ORG}', 'anthropic', 'Chave da leitura',
              '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '4242')
      on conflict do nothing;
  `);
}

/** Roda um SELECT como `authenticated` e devolve a primeira coluna, ou null se foi barrado. */
function leComo(userId: string, select: string): string | null {
  try {
    return sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${select}
    `);
  } catch {
    return null;
  }
}

beforeAll(() => {
  seedGov();
  seedCredencial();
});

describe("0206 — a lista de credenciais de IA é legível por quem não é admin", () => {
  it("⭐ manager LÊ a view segura — a tela dele deixa de vir vazia", () => {
    const saida = leComo(
      GOV_MANAGER,
      `select label from public.ai_provider_credentials_safe where id = '${CRED_LEITURA}';`,
    );

    expect(
      saida,
      "o manager foi barrado ou filtrado para zero linhas — a tela /app/ai/credentials responde 200 com [] e ele conclui que não há credencial cadastrada",
    ).not.toBeNull();
    expect(String(saida)).toContain("Chave da leitura");
  });

  it("viewer também LÊ — a tela é read-only e não é admin-gated", () => {
    const saida = leComo(
      GOV_VIEWER,
      `select label from public.ai_provider_credentials_safe where id = '${CRED_LEITURA}';`,
    );
    expect(saida).not.toBeNull();
    expect(String(saida)).toContain("Chave da leitura");
  });

  it("CONTROLE POSITIVO: admin continua lendo (a policy não quebrou quem já lia)", () => {
    const saida = leComo(
      GOV_ADMIN,
      `select label from public.ai_provider_credentials_safe where id = '${CRED_LEITURA}';`,
    );
    expect(saida).not.toBeNull();
  });
});

describe("0206 — e reabrir a LEITURA não reabre o SEGREDO", () => {
  it("⭐ manager NÃO alcança api_key_encrypted", () => {
    // Sem este caso, um "conserto" que devolvesse `grant select` na tabela
    // inteira ficaria verde nos casos acima — e entregaria o ciphertext, o iv e
    // a tag a todo membro do tenant.
    expect(
      leComo(
        GOV_MANAGER,
        `select api_key_encrypted from public.ai_provider_credentials where id = '${CRED_LEITURA}';`,
      ),
      "o manager alcançou a coluna do segredo — o grant por coluna da 0150 foi desfeito",
    ).toBeNull();
  });

  it("⭐ nem o iv, nem a tag", () => {
    expect(
      leComo(GOV_MANAGER, `select api_key_iv from public.ai_provider_credentials where id = '${CRED_LEITURA}';`),
    ).toBeNull();
    expect(
      leComo(GOV_MANAGER, `select api_key_tag from public.ai_provider_credentials where id = '${CRED_LEITURA}';`),
    ).toBeNull();
  });

  it("manager continua SEM escrever — a 0150 seguia certa nessa metade", () => {
    // ⚠️ Um DELETE barrado por RLS NÃO lança: ele afeta ZERO linhas e volta
    // silencioso. Medir com `toBeNull()` (que é o que `leComo` devolve quando o
    // comando ERRA) daria vermelho por motivo errado — foi o que aconteceu na
    // primeira versão deste caso. O que separa "barrado" de "apagou" é o
    // `returning id` vir VAZIO.
    const saida = leComo(
      GOV_MANAGER,
      `delete from public.ai_provider_credentials where id = '${CRED_LEITURA}' returning id;`,
    );
    expect(
      String(saida ?? "").includes(CRED_LEITURA),
      "o manager apagou uma credencial — a policy de escrita da 0150 foi desfeita junto",
    ).toBe(false);

    // CONTROLE POSITIVO: a linha continua lá. Sem ele, um `returning` vazio por
    // a fixture nunca ter existido leria como "a proteção funcionou".
    const aindaExiste = sql(
      `select label from public.ai_provider_credentials where id = '${CRED_LEITURA}';`,
    );
    expect(String(aindaExiste)).toContain("Chave da leitura");
  });
});
