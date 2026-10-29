import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { columnExists, indexExists, seedGov, sql, GOV_ORG } from "./gov-helpers";

/**
 * O TIPO DO CONTATO NO BANCO (issue 3005, fatia 1, migration 0763).
 *
 * A marca mora em `contacts.contact_type`, coluna nova de propósito: reutilizar
 * `is_personal` (0563) trancaria a conversa — aquela marca entra no predicado de
 * STOP do envio (`readStopFlags` em `lib/agent-engine/guardrails/before-send.ts`)
 * e a issue 3005 pede o oposto para o fornecedor ("continua recebendo mensagem
 * normalmente"). `is_blocked` é descadastro (LGPD) e `ai_opt_out` (0624) é veto
 * da IA: nenhuma das duas é papel, e dois papéis não cabem num booleano.
 *
 * Este arquivo cobra as CINCO coisas que a migration promete, e é a prova que o
 * `vitest run` não alcança: invariante de banco exige `pnpm test:db` (o harness
 * sobe o Postgres efêmero, aplica `baseline.sql` e fala com ele por
 * `docker exec psql` — ver tests/invariants/README.md).
 *
 * ─── SABOTAGEM (prova no CI; cada item derruba os casos marcados) ──────────
 * - Reverter o `default 'cliente'` para `default null` (ou tirar o `not null`):
 *   caem "nasce cliente — default e NOT NULL" e "contato novo nasce cliente".
 * - Tirar `'fornecedor'` do CHECK: cai "o CHECK aceita fornecedor".
 * - Tirar o `where (contact_type = 'fornecedor')` do índice: vira índice cheio
 *   que a busca por fornecedor não usa → cai "índice parcial".
 * - Meter `contact_type` no predicado de stop do envio (a marca virando veto,
 *   que é justamente o que a issue NÃO quer): cai "fornecedor segue elegível".
 * Linha para reverter: `supabase/migrations/20261024070505_0763_contato_tipo.sql`
 * (e o apêndice 0763 no fim de `supabase/baseline.sql`).
 */

/** Contato sintético desta prova — nenhum dado de pessoa real (LGPD). */
const CONTATO_PROVA = "dddd2222-2222-4222-8222-222222222222";
/** Segundo contato, para o controle positivo do predicado de stop. */
const CONTATO_PESSOAL = "dddd3333-3333-4333-8333-333333333333";

const RAIZ = join(__dirname, "..", "..");

describe("tipo de contato: coluna, default, CHECK, índice (issue 3005, fatia 1)", () => {
  it("a coluna existe", () => {
    expect(columnExists("contacts", "contact_type")).toBe(true);
  });

  it("nasce cliente — default 'cliente' e NOT NULL", () => {
    const def = sql(
      `select column_default || '|' || is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'contacts' and column_name = 'contact_type';`,
    );
    expect(def).toBe("'cliente'::text|NO");
  });

  it("contato novo nasce cliente SEM ninguém informar o tipo", () => {
    seedGov();
    sql(
      `insert into public.contacts (id, organization_id, display_name)
         values ('${CONTATO_PROVA}', '${GOV_ORG}', 'Prova tipo de contato')
         on conflict (id) do nothing;`,
    );
    const valor = sql(
      `select contact_type from public.contacts where id = '${CONTATO_PROVA}';`,
    );
    expect(valor).toBe("cliente");
  });

  it("o CHECK aceita fornecedor e recusa um terceiro valor", () => {
    const def = sql(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'contacts_contact_type_check';`,
    );
    expect(def).toContain("cliente");
    expect(def).toContain("fornecedor");

    // A troca que a ficha faz (PATCH) passa pelo CHECK.
    sql(
      `update public.contacts set contact_type = 'fornecedor' where id = '${CONTATO_PROVA}';`,
    );
    expect(
      sql(`select contact_type from public.contacts where id = '${CONTATO_PROVA}';`),
    ).toBe("fornecedor");

    // E o valor que o produto não conhece é recusado pela COLUNA, não só pelo
    // schema: um escritor futuro que invente um terceiro tipo bate aqui.
    expect(() =>
      sql(
        `update public.contacts set contact_type = 'transportadora' where id = '${CONTATO_PROVA}';`,
      ),
    ).toThrow(/contacts_contact_type_check/);
  });

  it("índice parcial existe, só para os fornecedores", () => {
    expect(indexExists("idx_contacts_org_fornecedor")).toBe(true);
    const def = sql(
      `select pg_get_indexdef(oid) from pg_class where relname = 'idx_contacts_org_fornecedor';`,
    );
    expect(def).toContain("contact_type");
    expect(def).toContain("fornecedor");
  });
});

describe("fornecedor CONTINUA recebendo mensagem (o tipo não é veto)", () => {
  it("o contato fornecedor não entra no predicado de stop do envio", () => {
    seedGov();
    // O MESMO predicado de `readStopFlags` (before-send.ts), palavra por
    // palavra: quem decide o veto de envio são estas quatro colunas — o TIPO
    // não está entre elas, e é isso que a issue 3005 exige do fornecedor.
    sql(
      `insert into public.contacts (id, organization_id, display_name, contact_type)
         values ('${CONTATO_PROVA}', '${GOV_ORG}', 'Prova fornecedor', 'fornecedor')
         on conflict (id) do update set contact_type = 'fornecedor',
           is_blocked = false, is_personal = false, force_human = false, ai_opt_out = false;`,
    );
    const parado = sql(
      `select (is_blocked or force_human or is_personal or ai_opt_out)::text as stopped
         from public.contacts where organization_id = '${GOV_ORG}' and id = '${CONTATO_PROVA}';`,
    );
    expect(parado).toBe("false");

    // CONTROLE POSITIVO: o mesmo predicado é VIVO — um contato pessoal cai nele.
    // Sem esta metade, o "false" acima poderia ser só uma consulta quebrada.
    sql(
      `insert into public.contacts (id, organization_id, display_name, is_personal)
         values ('${CONTATO_PESSOAL}', '${GOV_ORG}', 'Prova pessoal', true)
         on conflict (id) do update set is_personal = true;`,
    );
    const paradoPessoal = sql(
      `select (is_blocked or force_human or is_personal or ai_opt_out)::text as stopped
         from public.contacts where organization_id = '${GOV_ORG}' and id = '${CONTATO_PESSOAL}';`,
    );
    expect(paradoPessoal).toBe("true");
  });

  it("nenhum caminho de envio consulta o tipo (varredura do fonte)", () => {
    // A sabotagem que a issue teme é alguém "resolver" o fornecedor com um
    // veto, como `is_personal` faz. Enquanto o tipo não aparecer nestes
    // arquivos, o envio segue decidido por bloqueio/trava/handoff.
    const caminhos = [
      "lib/agent-engine/guardrails/before-send.ts",
      "app/api/v1/messages/_handler.ts",
      "lib/automation/engine.ts",
      "lib/wacalls/events-bridge.ts",
    ];
    for (const caminho of caminhos) {
      const fonte = readFileSync(join(RAIZ, caminho), "utf8");
      expect(fonte.includes("contact_type"), `${caminho} passou a olhar o tipo`).toBe(false);
    }
  });
});
