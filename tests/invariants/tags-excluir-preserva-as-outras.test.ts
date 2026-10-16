import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOV_CONTACT_1,
  GOV_CONV_UNASSIGNED,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  seedGov,
} from "./gov-helpers";

/**
 * EXCLUIR UMA ETIQUETA NÃO APAGA AS OUTRAS (issue #2895).
 *
 * `fn_tags_normalizar` anulava com `when p_remover then null` sem conferir o
 * valor, e `fn_vocabulario_de_tags_operar` repetia o mesmo `when v_remover then
 * null` em `settings.tags` e em `canonical_conversation_tags`. Resultado medido
 * pela tela (prova do #2784): excluir `retorno` deixava o contato, o negócio e a
 * conversa "Sem tags", e o vocabulário — onde mora a cor — virava `[]`.
 *
 * O caso que já existia em `tags-vocabulario.test.ts` excluía a ÚNICA etiqueta
 * do registro, e "anular tudo" e "anular só a excluída" dão o mesmo resultado
 * nesse caso. Aqui cada registro tem DUAS, e só uma sai.
 *
 * Chamada pela mesma RPC e com os mesmos 5 argumentos da rota
 * (`app/api/v1/tags/vocabulario/route.ts`), com a SESSÃO do gerente — a função é
 * `security definer`, e medir como `postgres` não provaria nada sobre papel.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

beforeAll(() => {
  seedGov();
});

afterAll(() => pool.end());

async function comoGerente(sql: string, args: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: GOV_MANAGER, role: "authenticated", aal: "aal2" }),
    ]);
    const r = await client.query(sql, args);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

async function tagsDe(tabela: "contacts" | "crm_leads" | "conversations", id: string) {
  const r = await pool.query(`select tags from public.${tabela} where id = $1`, [id]);
  return (r.rows[0]?.tags ?? []) as string[];
}

describe("excluir uma etiqueta (issue #2895)", () => {
  it("tira só a excluída: a outra continua nos 3 registros, no vocabulário e com a cor", async () => {
    // Caixa e espaço diferentes de propósito: a exclusão compara pela chave
    // canônica (`lower(btrim(...))`), como o resto da função.
    await pool.query("update public.contacts set tags = array['Fica', 'sai'] where id = $1", [GOV_CONTACT_1]);
    await pool.query("update public.crm_leads set tags = array['Sai', 'Fica'] where id = $1", [GOV_LEAD]);
    await pool.query("update public.conversations set tags = array['fica', ' sai '] where id = $1", [
      GOV_CONV_UNASSIGNED,
    ]);
    await pool.query(
      `update public.organizations
          set settings = coalesce(settings, '{}'::jsonb)
                || jsonb_build_object(
                     'tags', '[{"tag":"Fica","cor":"#7c3aed"},{"tag":"sai","cor":"#ef4444"}]'::jsonb,
                     'canonical_conversation_tags', '["Fica","sai"]'::jsonb)
        where id = $1`,
      [GOV_ORG],
    );

    const r = await comoGerente("select public.fn_vocabulario_de_tags_operar($1,$2,$3,$4,$5) as r", [
      GOV_ORG,
      "excluir",
      "SAI",
      null,
      null,
    ]);
    const resultado = r.rows[0].r as { contatos: number; leads: number; conversas: number };
    expect([resultado.contatos, resultado.leads, resultado.conversas].map(Number)).toEqual([1, 1, 1]);

    expect(await tagsDe("contacts", GOV_CONTACT_1)).toEqual(["Fica"]);
    expect(await tagsDe("crm_leads", GOV_LEAD)).toEqual(["Fica"]);
    expect(await tagsDe("conversations", GOV_CONV_UNASSIGNED)).toEqual(["fica"]);

    const org = await pool.query(
      "select settings -> 'tags' as tags, settings -> 'canonical_conversation_tags' as sementes from public.organizations where id = $1",
      [GOV_ORG],
    );
    expect(org.rows[0].tags).toEqual([{ tag: "Fica", cor: "#7c3aed" }]);
    expect(org.rows[0].sementes).toEqual(["Fica"]);
  });
});
