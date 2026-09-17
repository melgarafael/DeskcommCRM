import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedGov, GOV_MANAGER, GOV_ORG, GOV_VIEWER } from "./gov-helpers";

/**
 * Vocabulário de tags (issue #852, fatia S4) — o aceite combinado no fio da issue:
 * "pnpm test:db com duas orgs (renomear em uma não toca a outra); juntar 'vip' e
 * 'VIP' deixa uma só, sem repetição no array".
 *
 * Aqui a função é chamada com a SESSÃO do usuário (`set local role authenticated`
 * + `request.jwt.claims`), nunca como `postgres`: como a de escrita é
 * `security definer`, medir como superusuário não provaria nada sobre papel.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

const ORG_B = "cccccccc-0000-4000-8000-0000000000b4";

beforeAll(() => {
  seedGov();
});

afterAll(() => pool.end());

/** Roda SQL com a identidade de quem chama (papel + claims do JWT). */
async function actor(user: string | null, sql: string, args: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(user ? "set local role authenticated" : "set local role anon");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user, role: user ? "authenticated" : "anon", aal: "aal2" }),
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

function operar(org: string, acao: string, tag: string, destino: string | null) {
  return actor(
    GOV_MANAGER,
    "select public.fn_vocabulario_de_tags_operar($1,$2,$3,$4) as r",
    [org, acao, tag, destino],
  );
}

async function tagsDe(tabela: "contacts" | "crm_leads" | "conversations", id: string) {
  const r = await pool.query(`select tags from public.${tabela} where id = $1`, [id]);
  return (r.rows[0]?.tags ?? []) as string[];
}

describe("fatia S4 — vocabulário de tags", () => {
  it("renomear numa organização não toca a outra (duas orgs, mesma etiqueta)", async () => {
    await pool.query(
      "insert into public.organizations(id,slug,legal_name,display_name) values($1,'s4-org-b','S4 B','S4 B') on conflict do nothing",
      [ORG_B],
    );
    await pool.query(
      "insert into public.contacts(id,organization_id,name,display_name,tags) values($1,$2,'Sem S4','Sem S4',array['reclamacao']) on conflict (id) do update set tags = array['reclamacao']",
      ["cccccccc-3333-4000-8000-0000000000b4", ORG_B],
    );
    await pool.query(
      "insert into public.contacts(id,organization_id,name,display_name,tags) values($1,$2,'Da S4','Da S4',array['reclamacao']) on conflict (id) do update set tags = array['reclamacao']",
      ["cccccccc-3333-4000-8000-0000000000c4", GOV_ORG],
    );

    const r = await operar(GOV_ORG, "renomear", "reclamacao", "atendimento");
    expect(Number((r.rows[0].r as { contatos: number }).contatos)).toBeGreaterThanOrEqual(1);

    expect(await tagsDe("contacts", "cccccccc-3333-4000-8000-0000000000c4")).toEqual(["atendimento"]);
    // A org de fora continua com a etiqueta antiga: o `p_org` é filtro, não
    // sugestão — quem chama com a organização de outro tenant não alcança nada.
    expect(await tagsDe("contacts", "cccccccc-3333-4000-8000-0000000000b4")).toEqual(["reclamacao"]);
  });

  it("juntar 'vip' e 'VIP' deixa uma só, sem repetição no array", async () => {
    await pool.query(
      "update public.crm_leads set tags = array['vip','VIP','obra'] where organization_id = $1",
      [GOV_ORG],
    );
    await operar(GOV_ORG, "juntar", "vip", "VIP");

    const linhas = await pool.query(
      "select tags from public.crm_leads where organization_id = $1",
      [GOV_ORG],
    );
    for (const linha of linhas.rows) {
      const tags = linha.tags as string[];
      const iguais = tags.filter((tag) => tag.toLowerCase() === "vip");
      expect(iguais).toEqual(["VIP"]);
      expect(new Set(tags.map((tag) => tag.toLowerCase())).size).toBe(tags.length);
    }
  });

  it("juntar duas etiquetas de chaves DIFERENTES não deixa a etiqueta repetida", async () => {
    // O caso acima passa por acidente: 'vip' e 'VIP' já têm a MESMA chave
    // canônica ANTES da substituição, então deduplicar pela entrada resolve.
    // No `juntar` de verdade as chaves são diferentes por definição — é o que
    // torna as duas etiquetas duas —, e elas só colidem DEPOIS da troca de nome.
    // Medido num Postgres real com a versão anterior de `fn_tags_normalizar`:
    // {VIP, obra} juntando 'obra' em 'VIP' devolvia {VIP, VIP}.
    await pool.query(
      "update public.crm_leads set tags = array['VIP','obra'] where organization_id = $1",
      [GOV_ORG],
    );
    await operar(GOV_ORG, "juntar", "obra", "VIP");

    const linhas = await pool.query(
      "select tags from public.crm_leads where organization_id = $1",
      [GOV_ORG],
    );
    for (const linha of linhas.rows) {
      expect(linha.tags as string[]).toEqual(["VIP"]);
    }
  });

  it("renomear preserva TODAS as ações da regra, não só as do tipo add_tag", async () => {
    // O bloco (d) agrupava por (regra, TIPO de ação): o `update ... from alvo`
    // casava uma linha por tipo e o Postgres usava uma arbitrária, truncando a
    // regra ao subconjunto de um tipo só — em TODA organização, mesmo numa regra
    // que nunca citou a etiqueta renomeada. Medido num Postgres real: regra com
    // `add_tag` + `assign_owner` ficava com UMA ação, e a operação reportava
    // "atualizada em 1 regra(s) de agente".
    const regra = "cccccccc-7777-4000-8000-000000000002";
    await pool.query(
      `insert into public.automation_rules(id,organization_id,name,trigger_event,actions)
       values($1,$2,'Regra de dois tipos','message.received',
              '[{"type":"add_tag","config":{"tags":["promo"]}},{"type":"assign_owner","config":{"user_id":"${GOV_MANAGER}"}}]'::jsonb)
       on conflict (id) do update set actions = excluded.actions`,
      [regra, GOV_ORG],
    );

    await operar(GOV_ORG, "renomear", "promo", "Promoção");

    const depois = await pool.query("select actions from public.automation_rules where id = $1", [regra]);
    const acoes = depois.rows[0].actions as Array<{ type: string; config?: { tags?: string[] } }>;
    expect(acoes).toHaveLength(2);
    expect(acoes[0]?.config?.tags).toEqual(["Promoção"]);
    // A ação do OUTRO tipo continua inteira — é ela que a versão anterior comia.
    expect(acoes[1]?.type).toBe("assign_owner");
  });

  it("excluir tira dos arrays e NÃO apaga a regra add_tag (só informa quantas sobram)", async () => {
    const regra = "cccccccc-7777-4000-8000-000000000001";
    await pool.query(
      `insert into public.automation_rules(id,organization_id,name,trigger_event,actions)
       values($1,$2,'Regra da S4','message.received','[{"type":"add_tag","config":{"tags":["vip"]}}]'::jsonb)
       on conflict (id) do update set actions = excluded.actions`,
      [regra, GOV_ORG],
    );

    const r = await operar(GOV_ORG, "excluir", "vip", null);
    expect(Number((r.rows[0].r as { regras: number }).regras)).toBeGreaterThanOrEqual(1);

    const depois = await pool.query("select actions from public.automation_rules where id = $1", [regra]);
    const acoes = depois.rows[0].actions as Array<{ config?: { tags?: string[] } }>;
    expect(acoes[0]?.config?.tags).toEqual(["vip"]);
  });

  it("viewer é recusado antes de qualquer escrita", async () => {
    await expect(
      actor(GOV_VIEWER, "select public.fn_vocabulario_de_tags_operar($1,$2,$3,$4)", [
        GOV_ORG,
        "excluir",
        "obra",
        null,
      ]),
    ).rejects.toThrow(/insufficient_role/);
  });

  it("anon não alcança a função", async () => {
    await expect(
      actor(null, "select public.fn_vocabulario_de_tags_operar($1,$2,$3,$4)", [
        GOV_ORG,
        "excluir",
        "obra",
        null,
      ]),
    ).rejects.toThrow(/permission denied|insufficient_role/);
  });
});
