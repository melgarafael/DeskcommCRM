import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  seedGov,
  GOV_ORG as org,
  GOV_MANAGER as manager,
  GOV_AGENT_A as agente,
  GOV_SESSION as sessao,
} from "./gov-helpers";

const pool = new Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 4 });
const q = (t: string, a: unknown[] = []) => pool.query(t, a);
async function comoUsuario(user: string, text: string, args: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin"); await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, aal: "aal1" })]);
    const r = await c.query(text, args); await c.query("commit"); return r;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const OUTRA_ORG = "dddddddd-0000-4000-8000-000000000001";
const OUTRA_SESSAO = "dddddddd-0000-4000-8000-000000000002";
const GRUPO = "120363000000000001@g.us";
const GRUPO_DA_OUTRA = "120363000000000099@g.us";

// Snapshot dos contatos que JÁ existiam antes deste arquivo mexer no banco
// (seed do gov-helpers). Escopar o teste de vocabulário a estes ids — em vez
// de `select count(*) from contacts` sem filtro — evita que ele dependa da
// ordem dos `describe`s deste arquivo (mais abaixo, este mesmo arquivo insere
// contato `kind='whatsapp_group'` de propósito) ou de seed futura que também
// crie contato de grupo.
let idsPreExistentes: string[] = [];

beforeAll(async () => {
  await seedGov();
  idsPreExistentes = (await q("select id from contacts")).rows.map((r) => r.id as string);
  await q(
    "insert into organizations(id,legal_name,display_name,slug) values($1,'Outra','Outra','outra-grupos') on conflict do nothing",
    [OUTRA_ORG],
  );
  // Sessão + linha de channel_session_groups da OUTRA organização, gravadas
  // como superusuário (bypassa RLS de propósito — é o setup, não a prova).
  // Sem esta linha, a asserção de isolamento cross-org do teste abaixo é
  // vazia: `count(*) = 0` é garantido com ou sem RLS quando não existe linha
  // nenhuma da outra organização para vazar.
  await q(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'outra-grupos-session','WORKING',decode('00','hex')) on conflict do nothing",
    [OUTRA_SESSAO, OUTRA_ORG],
  );
  await q(
    "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id,subject) values($1,$2,$3,'Grupo da Outra Org')",
    [OUTRA_ORG, OUTRA_SESSAO, GRUPO_DA_OUTRA],
  );
});
afterAll(() => pool.end());

describe("contacts.kind", () => {
  it("contatos pré-existentes (seed) nascem 'person'; valor fora do vocabulário é recusado", async () => {
    const r = await q("select count(*)::int n from contacts where id = any($1) and kind <> 'person'", [idsPreExistentes]);
    expect(r.rows[0].n).toBe(0);
    await expect(q("update contacts set kind='outro' where organization_id=$1", [org])).rejects.toThrow(/check/i);
  });
});

describe("channel_session_groups", () => {
  // I5 (revisão final): só o service role ESCREVE. Membro da
  // org só lê; a API grava pelo service role depois de confirmar o filtro do
  // WhatsApp e auditar. Uma escrita direta pelo PostgREST pularia os dois.
  async function comoServiceRole(text: string, args: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query("begin"); await c.query("set local role service_role");
      const r = await c.query(text, args); await c.query("commit"); return r;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  async function comoAnon(text: string, args: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query("begin"); await c.query("set local role anon");
      const r = await c.query(text, args); await c.query("commit"); return r;
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  const RECUSA = /permission denied|row-level security/i;

  it("isola por organização (RLS), membro só LÊ e só o service role escreve", async () => {
    await q("delete from channel_session_groups where organization_id=$1", [org]);

    // O escritor legítimo: service role grava, altera e apaga.
    const gravada = await comoServiceRole(
      "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id,subject) values($1,$2,$3,'Teste') returning id",
      [org, sessao, GRUPO],
    );
    expect(gravada.rowCount).toBe(1);
    const alterada = await comoServiceRole("update channel_session_groups set enabled=true where organization_id=$1 and group_chat_id=$2 returning id", [org, GRUPO]);
    expect(alterada.rowCount).toBe(1);

    // Gerente — o papel que a policy antiga deixava escrever — não insere, não
    // altera e não apaga nem na PRÓPRIA org.
    await expect(
      comoUsuario(manager, "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id) values($1,$2,'y@g.us')", [org, sessao]),
    ).rejects.toThrow(RECUSA);
    await expect(
      comoUsuario(manager, "update channel_session_groups set enabled=false, conversation_id=null where organization_id=$1", [org]),
    ).rejects.toThrow(RECUSA);
    await expect(
      comoUsuario(manager, "delete from channel_session_groups where organization_id=$1", [org]),
    ).rejects.toThrow(RECUSA);
    await expect(
      comoUsuario(agente, "insert into channel_session_groups(organization_id,channel_session_id,group_chat_id) values($1,$2,'x@g.us')", [org, sessao]),
    ).rejects.toThrow(RECUSA);
    await expect(
      comoAnon("insert into channel_session_groups(organization_id,channel_session_id,group_chat_id) values($1,$2,'z@g.us')", [org, sessao]),
    ).rejects.toThrow(RECUSA);

    // Nada do que o gerente tentou pegou: a linha continua ligada, e só ela existe.
    const estado = await q("select count(*)::int n, bool_and(enabled) ligada from channel_session_groups where organization_id=$1", [org]);
    expect(estado.rows[0]).toEqual({ n: 1, ligada: true });

    // Controle de não-vacuidade: a linha da OUTRA_ORG existe de verdade (foi
    // semeada em beforeAll como superusuário) — se este count desse 0 também,
    // a prova de isolamento logo abaixo estaria medindo o nada.
    const existeMesmo = await q("select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(existeMesmo.rows[0].n).toBe(1);

    // A prova de isolamento em si: o gerente de `org`, autenticado, não
    // enxerga a linha real da OUTRA_ORG, e lê a da própria.
    const daOutra = await comoUsuario(manager, "select count(*)::int n from channel_session_groups where organization_id=$1", [OUTRA_ORG]);
    expect(daOutra.rows[0].n).toBe(0);
    const doAgente = await comoUsuario(agente, "select count(*)::int n from channel_session_groups where organization_id=$1", [org]);
    expect(doAgente.rows[0].n).toBe(1);
  });

  it("nenhuma escrita concedida a anon/authenticated (grant, não só policy)", async () => {
    const r = await q(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name='channel_session_groups'
          and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
          and grantee in ('anon','authenticated','PUBLIC')`,
    );
    expect(r.rows).toEqual([]);
  });
});

describe("conversa de grupo no banco", () => {
  async function conversaDeGrupo() {
    const c = await q(
      "insert into contacts(organization_id,name,display_name,kind,source) values($1,'Grupo Teste','Grupo Teste','whatsapp_group','whatsapp_group') returning id",
      [org],
    );
    const conv = await q(
      "insert into conversations(organization_id,contact_id,channel_session_id,channel,status,is_group,group_chat_id) values($1,$2,$3,'whatsapp','open',true,$4) returning id",
      [org, c.rows[0].id, sessao, GRUPO],
    );
    return { contato: c.rows[0].id as string, conversa: conv.rows[0].id as string };
  }

  it("conversa de grupo nova NÃO pede roteamento", async () => {
    const { conversa } = await conversaDeGrupo();
    const r = await q("select count(*)::int n from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'", [org, conversa]);
    expect(r.rows[0].n).toBe(0);
  });

  it("mensagem recebida em grupo emite message.group_received e nunca message.received", async () => {
    const { contato, conversa } = await conversaDeGrupo();
    const m = await q(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','delivered','oi') returning id",
      [org, conversa, sessao, contato, `grp-${Date.now()}`],
    );
    const tipos = await q("select event_type from event_log where organization_id=$1 and payload->>'message_id'=$2", [org, m.rows[0].id]);
    const nomes = tipos.rows.map((r) => r.event_type);
    expect(nomes).toContain("message.group_received");
    expect(nomes).not.toContain("message.received");
  });

  it("I3: grupo sem dono é 'aguardando' no campo calculado (fila humana), nunca 'automatico'", async () => {
    const { conversa } = await conversaDeGrupo();
    const semDono = await q("select public.comando_da_conversa(c) v from conversations c where c.id=$1", [conversa]);
    expect(semDono.rows[0].v).toBe("aguardando");
    await q("update conversations set assigned_to_user_id=$2 where id=$1", [conversa, manager]);
    const comDono = await q("select public.comando_da_conversa(c) v from conversations c where c.id=$1", [conversa]);
    expect(comDono.rows[0].v).toBe("humano");
    // Controle: a regra ainda chama de 'automatico' a conversa 1:1 equivalente.
    const umParaUm = await q(
      "select public.fn_comando_da_conversa('open', null, null, false, false, now(), false) v",
    );
    expect(umParaUm.rows[0].v).toBe("automatico");
  });

  it("I2: a reabertura da entrada de grupo (mesmo UPDATE) tira a conversa de fechada, sem pedir roteamento", async () => {
    const { conversa } = await conversaDeGrupo();
    await q("update conversations set status='closed' where id=$1", [conversa]);
    const c = await pool.connect();
    try {
      await c.query("begin"); await c.query("set local role service_role");
      const r = await c.query(
        "update conversations set status='open', status_changed_at=now() where organization_id=$1 and id=$2 and is_group=true and status = any($3) returning status",
        [org, conversa, ["closed", "resolved", "archived"]],
      );
      await c.query("commit");
      expect(r.rows).toEqual([{ status: "open" }]);
    } finally { c.release(); }
    const rota = await q("select count(*)::int n from event_log where organization_id=$1 and entity_id=$2 and event_type='conversation.routing_requested'", [org, conversa]);
    expect(rota.rows[0].n).toBe(0);
  });

  it("conversa individual continua emitindo message.received (controle)", async () => {
    const conv = await q("select id, contact_id from conversations where organization_id=$1 and is_group=false limit 1", [org]);
    const m = await q(
      "insert into messages(organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,body) values($1,$2,$3,$4,$5,'text','inbound','delivered','oi') returning id",
      [org, conv.rows[0].id, sessao, conv.rows[0].contact_id, `ind-${Date.now()}`],
    );
    const tipos = await q("select event_type from event_log where organization_id=$1 and payload->>'message_id'=$2", [org, m.rows[0].id]);
    expect(tipos.rows.map((r) => r.event_type)).toContain("message.received");
  });
});

describe("uq_contacts_grupo", () => {
  it("um segundo contato de grupo com o mesmo group_chat_id na mesma organização é recusado", async () => {
    await q(
      "insert into contacts(organization_id,name,display_name,kind,source,source_metadata) values($1,'Grupo Dup','Grupo Dup','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id',$2::text))",
      [org, GRUPO],
    );
    await expect(
      q(
        "insert into contacts(organization_id,name,display_name,kind,source,source_metadata) values($1,'Grupo Dup 2','Grupo Dup 2','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id',$2::text))",
        [org, GRUPO],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("ficha de grupo MESCLADA não segura o group_chat_id — um novo placeholder pode ocupá-lo", async () => {
    const GRUPO_MESCLADO = "120363000000000077@g.us";
    const perdedor = await q(
      "insert into contacts(organization_id,name,display_name,kind,source,source_metadata) values($1,'Grupo Perdedor','Grupo Perdedor','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id',$2::text)) returning id",
      [org, GRUPO_MESCLADO],
    );
    // Junta a ficha perdedora a outra (qualquer contato vivo serve de vencedor
    // para este teste — o que importa é que `is_merged_into` deixa de ser null).
    await q("update contacts set is_merged_into=$1 where id=$2", [idsPreExistentes[0], perdedor.rows[0].id]);
    // Sem `where is_merged_into is null` no índice, este INSERT estouraria
    // "duplicate key" contra a ficha morta — que é exatamente o defeito que
    // `tests/unit/indice-de-contato-ignora-ficha-mesclada.test.ts` fecha.
    const vencedor = await q(
      "insert into contacts(organization_id,name,display_name,kind,source,source_metadata) values($1,'Grupo Vencedor','Grupo Vencedor','whatsapp_group','whatsapp_group',jsonb_build_object('group_chat_id',$2::text)) returning id",
      [org, GRUPO_MESCLADO],
    );
    expect(vencedor.rows[0].id).not.toEqual(perdedor.rows[0].id);
  });
});
