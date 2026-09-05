import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_mesclar_contatos` — juntar dois cadastros da MESMA pessoa sem perder nada.
 *
 * A prova que importa não é "as tabelas que eu listei foram repontadas" — é que
 * a lista NÃO é minha. O caso `tabela criada depois da função` cria uma tabela
 * nova com FK para `contacts` DENTRO do teste e exige que a fusão a alcance sem
 * uma linha de código nova. Se alguém trocar o catálogo por uma lista à mão, é
 * esse caso que fica vermelho — os outros continuariam verdes.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = "d0208000-0000-4000-8000-000000000001";
const ORG_VIZINHA = "d0208000-0000-4000-8000-0000000000f0";
const SESSAO = "d0208000-0000-4000-8000-000000000002";
const FUNIL = "d0208000-0000-4000-8000-000000000003";
const ETAPA = "d0208000-0000-4000-8000-000000000004";

/** Cria um contato e devolve o id. */
async function contato(
  id: string,
  campos: {
    org?: string;
    nome?: string | null;
    email?: string | null;
    telefone?: string | null;
    lid?: string | null;
    anonimizado?: boolean;
    tags?: string[];
  } = {},
): Promise<string> {
  await pool.query(
    `insert into contacts (id, organization_id, name, email, phone_number, source_metadata,
                           is_anonymized, anonymized_at, tags)
     values ($1, $2, $3, $4, $5, $6, $7, case when $7 then now() else null end, $8)`,
    [
      id,
      campos.org ?? ORG,
      campos.nome ?? null,
      campos.email ?? null,
      campos.telefone ?? null,
      campos.lid ? JSON.stringify({ waha_lid: campos.lid }) : "{}",
      campos.anonimizado ?? false,
      campos.tags ?? [],
    ],
  );
  return id;
}

async function mesclar(principal: string, secundarios: string[], org = ORG) {
  const { rows } = await pool.query<{ r: Record<string, unknown> }>(
    "select public.fn_mesclar_contatos($1, $2, $3) as r",
    [org, principal, secundarios],
  );
  return rows[0]!.r;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-0208-merge', 'Merge LTDA', 'Merge'), ($2, 'org-0208-vizinha', 'Vizinha LTDA', 'Vizinha')
     on conflict (id) do nothing`,
    [ORG, ORG_VIZINHA],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'sessao-0208', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSAO, ORG],
  );
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug)
     values ($1, $2, 'Funil 0208', 'funil-0208') on conflict (id) do nothing`,
    [FUNIL, ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1, $2, $3, 'Entrada', 'entrada', 1) on conflict (id) do nothing`,
    [ETAPA, ORG, FUNIL],
  );
});

afterAll(async () => {
  await pool.query("drop table if exists public.anexos_do_contato_0208");
  await pool.query("delete from organizations where id in ($1, $2)", [ORG, ORG_VIZINHA]);
  await pool.end();
});

describe("fn_mesclar_contatos — o histórico segue o vencedor", () => {
  it("reponta conversa, mensagem, negócio do funil e atividade; a lápide fica", async () => {
    const vencedor = await contato("d0208001-0000-4000-8000-000000000001", {
      nome: "Maria",
      telefone: "+5531998966301",
    });
    const perdedor = await contato("d0208001-0000-4000-8000-000000000002", {
      email: "maria@example.com",
      telefone: "+553198966301",
    });

    const conversa = "d0208001-0000-4000-8000-00000000000a";
    await pool.query(
      `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
       values ($1, $2, $3, $4, 'open', false)`,
      [conversa, ORG, perdedor, SESSAO],
    );
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at)
       values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi', 'external_device', now())`,
      ["d0208001-0000-4000-8000-00000000000b", ORG, conversa, SESSAO, perdedor],
    );
    const negocio = "d0208001-0000-4000-8000-00000000000c";
    await pool.query(
      `insert into crm_leads (id, organization_id, pipeline_id, stage_id, title, contact_id)
       values ($1, $2, $3, $4, 'Negócio do perdedor', $5)`,
      [negocio, ORG, FUNIL, ETAPA, perdedor],
    );
    await pool.query(
      `insert into crm_lead_activities (organization_id, lead_id, contact_id, source_module, type)
       values ($1, $2, $3, 'crm', 'note')`,
      [ORG, negocio, perdedor],
    );
    await pool.query(
      `insert into crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
       values ($1, $2, 'contact', $3, 'primary')`,
      [ORG, negocio, perdedor],
    );

    const resultado = await mesclar(vencedor, [perdedor]);

    const { rows: conta } = await pool.query<{ t: string; n: string }>(
      `select 'conversas' as t, count(*)::text as n from conversations where contact_id = $1
       union all select 'mensagens', count(*)::text from messages where contact_id = $1
       union all select 'negocios', count(*)::text from crm_leads where contact_id = $1
       union all select 'atividades', count(*)::text from crm_lead_activities where contact_id = $1 and type = 'note'
       union all select 'vinculos', count(*)::text from crm_lead_links where target_kind = 'contact' and target_id = $1`,
      [vencedor],
    );
    expect(Object.fromEntries(conta.map((r) => [r.t, r.n]))).toEqual({
      conversas: "1",
      mensagens: "1",
      negocios: "1",
      atividades: "1",
      vinculos: "1",
    });

    // Lápide, não delete: a linha continua existindo e apontando para o vencedor.
    const { rows: lapide } = await pool.query<{ is_merged_into: string; merged_at: string | null }>(
      "select is_merged_into, merged_at from contacts where id = $1",
      [perdedor],
    );
    expect(lapide).toHaveLength(1);
    expect(lapide[0]!.is_merged_into).toBe(vencedor);
    expect(lapide[0]!.merged_at).not.toBeNull();

    // O relatório devolvido diz o que se moveu — é ele que a rota audita.
    expect(resultado).toMatchObject({
      contato_id: vencedor,
      repontado: expect.objectContaining({
        "conversations.contact_id": 1,
        "messages.contact_id": 1,
        "crm_leads.contact_id": 1,
        "crm_lead_links.target_id": 1,
      }),
    });
  });

  it("alcança uma tabela criada DEPOIS da função, sem código novo", async () => {
    // A prova de que a lista de FKs sai do catálogo. Uma lista à mão ficaria
    // vermelha exatamente aqui e em nenhum outro caso deste arquivo.
    await pool.query(
      `create table public.anexos_do_contato_0208 (
         id uuid primary key default gen_random_uuid(),
         organization_id uuid not null references organizations(id) on delete cascade,
         contact_id uuid not null references contacts(id) on delete cascade,
         rotulo text not null
       )`,
    );
    const vencedor = await contato("d0208002-0000-4000-8000-000000000001", {
      telefone: "+5531998966302",
    });
    const perdedor = await contato("d0208002-0000-4000-8000-000000000002", {
      telefone: "+553198966302",
    });
    await pool.query(
      "insert into public.anexos_do_contato_0208 (organization_id, contact_id, rotulo) values ($1, $2, 'contrato.pdf')",
      [ORG, perdedor],
    );

    const resultado = await mesclar(vencedor, [perdedor]);

    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text as n from public.anexos_do_contato_0208 where contact_id = $1",
      [vencedor],
    );
    expect(rows[0]!.n).toBe("1");
    expect(resultado).toMatchObject({
      repontado: expect.objectContaining({ "anexos_do_contato_0208.contact_id": 1 }),
    });
  });

  it("o WhatsApp do perdedor passa a cair no vencedor — a duplicata não volta", async () => {
    const vencedor = await contato("d0208003-0000-4000-8000-000000000001", {
      nome: "João",
      telefone: "+5531998966303",
    });
    const perdedor = await contato("d0208003-0000-4000-8000-000000000002", {
      lid: "553198966303",
    });

    await mesclar(vencedor, [perdedor]);

    // O reencontro é o teste real: sem herdar o `waha_lid`, a próxima mensagem
    // criaria um contato NOVO e refaria a duplicata que acabou de ser desfeita.
    const { rows } = await pool.query<{ id: string }>(
      "select public.fn_upsert_wa_contact($1, 'lid', null, $2, $3, null) as id",
      [ORG, "553198966303", "553198966303@lid"],
    );
    expect(rows[0]!.id).toBe(vencedor);
  });

  it("completa o que falta no vencedor e NUNCA sobrescreve o que ele já tinha", async () => {
    const vencedor = await contato("d0208004-0000-4000-8000-000000000001", {
      nome: "Nome do atendente",
      telefone: "+5531998966304",
    });
    const perdedor = await contato("d0208004-0000-4000-8000-000000000002", {
      nome: "Nome do WhatsApp",
      email: "cliente@example.com",
      telefone: "+553198966304",
    });
    await pool.query("update contacts set tags = $2 where id = $1", [vencedor, ["vip"]]);
    await pool.query("update contacts set tags = $2 where id = $1", [perdedor, ["import"]]);

    await mesclar(vencedor, [perdedor]);

    const { rows } = await pool.query<{
      name: string;
      email: string | null;
      phone_number: string;
      tags: string[];
      mesclado_de: unknown;
    }>(
      `select name, email, phone_number, tags, source_metadata->'mesclado_de' as mesclado_de
         from contacts where id = $1`,
      [vencedor],
    );
    expect(rows[0]!.name).toBe("Nome do atendente");
    expect(rows[0]!.email).toBe("cliente@example.com");
    expect(rows[0]!.phone_number).toBe("+5531998966304");
    expect([...rows[0]!.tags].sort()).toEqual(["import", "vip"]);
    expect(rows[0]!.mesclado_de).toEqual([perdedor]);
  });

  it("recusa contato anonimizado — L-04 não se desfaz pela porta dos fundos", async () => {
    const vencedor = await contato("d0208005-0000-4000-8000-000000000001", {
      telefone: "+5531998966305",
    });
    const anonimizado = await contato("d0208005-0000-4000-8000-000000000002", {
      anonimizado: true,
    });
    await expect(mesclar(vencedor, [anonimizado])).rejects.toThrow(
      /contato_secundario_indisponivel/,
    );
  });

  it("recusa contato de outra organização", async () => {
    const vencedor = await contato("d0208006-0000-4000-8000-000000000001", {
      telefone: "+5531998966306",
    });
    const alheio = await contato("d0208006-0000-4000-8000-000000000002", {
      org: ORG_VIZINHA,
      telefone: "+5511988880000",
    });
    await expect(mesclar(vencedor, [alheio])).rejects.toThrow(
      /contato_secundario_indisponivel/,
    );
    const { rows } = await pool.query<{ is_merged_into: string | null }>(
      "select is_merged_into from contacts where id = $1",
      [alheio],
    );
    expect(rows[0]!.is_merged_into).toBeNull();
  });

  it("recusa o principal entre os secundários", async () => {
    const um = await contato("d0208007-0000-4000-8000-000000000001", {
      telefone: "+5531998966307",
    });
    await expect(mesclar(um, [um])).rejects.toThrow(/selecao_de_mesclagem_invalida/);
  });

  it("a RPC não é alcançável pela anon key", async () => {
    const { rows } = await pool.query<{ tem: boolean }>(
      `select bool_or(has_function_privilege(g, p.oid, 'execute')) as tem
         from pg_proc p, pg_namespace n, unnest(array['anon','public']) as g
        where p.pronamespace = n.oid and n.nspname = 'public'
          and p.proname = 'fn_mesclar_contatos'`,
    );
    expect(rows[0]!.tem).toBe(false);
  });
});
