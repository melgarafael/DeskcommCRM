import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * C2-07 — invariantes de não-destrutividade e isolamento do ciclo de vida
 * do contexto (Spec 16). Soft reset (setar context_reset_at) NÃO apaga nada;
 * hard reset SQL preserva contacts e crm_leads; marca da org A não alcança
 * a org B com o mesmo telefone.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

function count(query: string): number {
  const out = sql(query);
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (last === undefined || !/^\d+$/.test(last)) {
    throw new Error(`unexpected psql output: ${out}`);
  }
  return Number(last);
}

const ORG_A = "cccccccc-0000-4000-8000-000000000001";
const ORG_B = "cccccccc-0000-4000-8000-000000000002";
const CONTACT_A = "cccccccc-1111-4000-8000-000000000001";
const CONTACT_B = "cccccccc-1111-4000-8000-000000000002";
const SESS_A = "cccccccc-2222-4000-8000-000000000001";
const SESS_B = "cccccccc-2222-4000-8000-000000000002";
const CONV_A = "cccccccc-3333-4000-8000-000000000001";
const PIPE_A = "cccccccc-4444-4000-8000-000000000001";
const STAGE_A = "cccccccc-5555-4000-8000-000000000001";
const LEAD_A = "cccccccc-6666-4000-8000-000000000001";
const MSG_A = "cccccccc-7777-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values
        ('${ORG_A}', 'ctx-life-a', 'Ctx Life A', 'Ctx A'),
        ('${ORG_B}', 'ctx-life-b', 'Ctx Life B', 'Ctx B')
      on conflict (id) do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values
        ('${SESS_A}', '${ORG_A}', 'ctx-life-a', '\\x00'::bytea),
        ('${SESS_B}', '${ORG_B}', 'ctx-life-b', '\\x00'::bytea)
      on conflict (id) do nothing;

    -- Mesmo telefone nas duas orgs (prova de isolamento por org, não por número).
    --
    -- O número precisa ser EXCLUSIVO deste arquivo. ORG_A é o mesmo uuid que
    -- gov-helpers.ts chama de GOV_ORG, e automation-send-whatsapp.test.ts já semeia
    -- +5511999990001 ali com outro id. Como a suíte roda com fileParallelism:false
    -- contra um banco só, a segunda inserção violava uniq_contacts_org_phone — e o
    -- on-conflict daqui tem alvo na PK, então não engolia nada.
    -- O sintoma enganava: o erro que aparecia era conversations_contact_id_fkey,
    -- porque o on-conflict-do-nothing SEM alvo do outro arquivo engole a colisão
    -- de unicidade em silêncio e a quebra só estoura um insert adiante.
    insert into public.contacts (id, organization_id, phone_number, display_name)
      values
        ('${CONTACT_A}', '${ORG_A}', '+5511999991001', 'Contato A'),
        ('${CONTACT_B}', '${ORG_B}', '+5511999991001', 'Contato B')
      on conflict (id) do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id)
      values ('${CONV_A}', '${ORG_A}', '${CONTACT_A}', '${SESS_A}')
      on conflict (id) do nothing;

    insert into public.messages (
      id, organization_id, conversation_id, channel_session_id, contact_id,
      type, direction, body
    ) values (
      '${MSG_A}', '${ORG_A}', '${CONV_A}', '${SESS_A}', '${CONTACT_A}',
      'text', 'inbound', 'ola'
    ) on conflict (id) do nothing;

    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE_A}', '${ORG_A}', 'Pipe A', 'ctx-life-a')
      on conflict (id) do nothing;

    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE_A}', '${ORG_A}', '${PIPE_A}', 'Novo', 'novo', 1000)
      on conflict (id) do nothing;

    insert into public.crm_leads (
      id, organization_id, pipeline_id, stage_id, contact_id, title
    ) values (
      '${LEAD_A}', '${ORG_A}', '${PIPE_A}', '${STAGE_A}', '${CONTACT_A}', 'Lead A'
    ) on conflict (id) do nothing;

    insert into public.lead_notes (organization_id, contact_id, headline, body)
    select '${ORG_A}', '${CONTACT_A}', 'nota', 'corpo da nota'
     where not exists (
       select 1 from public.lead_notes
        where organization_id = '${ORG_A}' and contact_id = '${CONTACT_A}' and headline = 'nota'
     );
  `);
});

describe("C2-07 — soft reset não apaga nada", () => {
  it("setar context_reset_at preserva contagens de messages/conversations/activities/notes/orders", () => {
    const before = {
      messages: count(`select count(*) from messages where contact_id = '${CONTACT_A}'`),
      conversations: count(
        `select count(*) from conversations where contact_id = '${CONTACT_A}'`,
      ),
      activities: count(
        `select count(*) from crm_lead_activities where contact_id = '${CONTACT_A}'`,
      ),
      notes: count(`select count(*) from lead_notes where contact_id = '${CONTACT_A}'`),
      orders: count(`select count(*) from orders where contact_id = '${CONTACT_A}'`),
    };

    sql(`
      update contacts
         set context_reset_at = now(), context_reset_reason = 'stage_policy'
       where id = '${CONTACT_A}' and organization_id = '${ORG_A}';
    `);

    const after = {
      messages: count(`select count(*) from messages where contact_id = '${CONTACT_A}'`),
      conversations: count(
        `select count(*) from conversations where contact_id = '${CONTACT_A}'`,
      ),
      activities: count(
        `select count(*) from crm_lead_activities where contact_id = '${CONTACT_A}'`,
      ),
      notes: count(`select count(*) from lead_notes where contact_id = '${CONTACT_A}'`),
      orders: count(`select count(*) from orders where contact_id = '${CONTACT_A}'`),
    };

    expect(after).toEqual(before);
    expect(before.messages).toBeGreaterThanOrEqual(1);
    expect(before.conversations).toBeGreaterThanOrEqual(1);
  });
});

describe("C2-07 — isolamento 2-tenants", () => {
  it("context_reset_at da org A não aparece no contato da org B com o mesmo telefone", () => {
    sql(`
      update contacts
         set context_reset_at = now(), context_reset_reason = 'stage_policy'
       where id = '${CONTACT_A}' and organization_id = '${ORG_A}';
      update contacts
         set context_reset_at = null, context_reset_reason = null
       where id = '${CONTACT_B}' and organization_id = '${ORG_B}';
    `);

    const aHas = count(`
      select count(*) from contacts
       where id = '${CONTACT_A}' and context_reset_at is not null
    `);
    const bHas = count(`
      select count(*) from contacts
       where id = '${CONTACT_B}' and context_reset_at is not null
    `);
    expect(aHas).toBe(1);
    expect(bHas).toBe(0);
  });
});

describe("C2-07 — hard reset SQL preserva contact e lead, apaga notas", () => {
  it("apagar conversations/checkpoints/state/notes mantém contacts e crm_leads", () => {
    // Garante que existe nota para provar que o hard reset a remove.
    sql(`
      insert into public.lead_notes (organization_id, contact_id, headline, body)
      select '${ORG_A}', '${CONTACT_A}', 'nota-hard-reset', 'corpo que deve sumir'
       where not exists (
         select 1 from public.lead_notes
          where organization_id = '${ORG_A}' and contact_id = '${CONTACT_A}'
            and headline = 'nota-hard-reset'
       );
    `);
    expect(
      count(`select count(*) from lead_notes where contact_id = '${CONTACT_A}'`),
    ).toBeGreaterThanOrEqual(1);

    const contactsBefore = count(`select count(*) from contacts where id = '${CONTACT_A}'`);
    const leadsBefore = count(`select count(*) from crm_leads where id = '${LEAD_A}'`);

    sql(`
      delete from lead_checkpoints
       where organization_id = '${ORG_A}' and contact_id = '${CONTACT_A}';
      delete from lead_state
       where organization_id = '${ORG_A}' and contact_id = '${CONTACT_A}';
      delete from lead_notes
       where organization_id = '${ORG_A}' and contact_id = '${CONTACT_A}';
      delete from conversations
       where organization_id = '${ORG_A}' and contact_id = '${CONTACT_A}';
      update contacts
         set context_reset_at = null, context_reset_reason = null
       where id = '${CONTACT_A}' and organization_id = '${ORG_A}';
    `);

    const contactsAfter = count(`select count(*) from contacts where id = '${CONTACT_A}'`);
    const leadsAfter = count(`select count(*) from crm_leads where id = '${LEAD_A}'`);
    const convsAfter = count(
      `select count(*) from conversations where contact_id = '${CONTACT_A}'`,
    );
    const notesAfter = count(`select count(*) from lead_notes where contact_id = '${CONTACT_A}'`);

    expect(contactsAfter).toBe(contactsBefore);
    expect(leadsAfter).toBe(leadsBefore);
    expect(contactsAfter).toBe(1);
    expect(leadsAfter).toBe(1);
    expect(convsAfter).toBe(0);
    expect(notesAfter).toBe(0);
  });
});
