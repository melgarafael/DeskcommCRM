import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolverDestinosDosAvisos } from "@/lib/ai/inbox-destino";
import { sql, lastLine } from "./gov-helpers";
const org = randomUUID(), external = randomUUID(), actor = randomUUID(), other = randomUUID();
const convs = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const leads = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
beforeAll(() => {
  sql(`insert into auth.users (id, email) values ('${actor}', 'avisos-a@invariant.test'), ('${other}', 'avisos-b@invariant.test');`);
  for (const organization of [org, external]) {
    const session = randomUUID(), pipeline = randomUUID(), stage = randomUUID();
    sql(`insert into organizations (id, slug, legal_name, display_name) values ('${organization}', '${organization}', 'Avisos', 'Avisos');
      insert into user_organizations (user_id, organization_id, role, accepted_at) values ('${actor}', '${organization}', 'agent', now()), ('${other}', '${organization}', 'agent', now());
      insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values ('${session}', '${organization}', '${session}', '\\x00');
      insert into crm_pipelines (id, organization_id, name, slug) values ('${pipeline}', '${organization}', 'Funil', '${pipeline}');
      insert into crm_stages (id, organization_id, pipeline_id, name, slug, position) values ('${stage}', '${organization}', '${pipeline}', 'Entrada', 'entrada', 1);`);
    for (const i of organization === org ? [0, 1, 2] : [3]) {
      const contact = randomUUID(); const owner = i === 0 || i === 3 ? `'${actor}'` : i === 1 ? 'null' : `'${other}'`;
      sql(`insert into contacts (id, organization_id, display_name) values ('${contact}', '${organization}', 'Contato');
        insert into conversations (id, organization_id, contact_id, channel_session_id, assigned_to_user_id) values ('${convs[i]}', '${organization}', '${contact}', '${session}', ${owner});
        insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, owner_user_id) values ('${leads[i]}', '${organization}', '${pipeline}', '${stage}', '${contact}', 'Negócio', ${owner});`);
    }
  }
  // Ator tem membership também em B: o filtro explícito da org precisa continuar valendo.
});
/** Adapter de transporte para Postgres REAL: nenhum dublê de visibilidade.
 * SET ROLE + JWT usam as mesmas policies do PostgREST; a projeção real roda acima.
 */
function authenticated() {
  return { from(table: string) {
    expect(["conversations", "crm_leads", "crm_pipelines"]).toContain(table);
    let orgFilter = "", ids: string[] = [];
    let columns = "id";
    const chain = { select: (value: string) => { columns = value; return chain; },
      eq: (key: string, value: string) => { expect(key).toBe("organization_id"); orgFilter = value; return chain; },
      in: (key: string, value: string[]) => { expect(key).toBe("id"); ids = value; return chain; },
      then: (resolve: (data: unknown) => unknown) => {
        expect(orgFilter).toBe(org);
        const out = sql(`set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${actor}"}', false);
          select coalesce(json_agg(row_to_json(r)), '[]'::json) from
          (select ${columns} from ${table} where organization_id = '${orgFilter}' and id in (${ids.map(id => `'${id}'`).join(',')})) r;`);
        return Promise.resolve({ data: JSON.parse(lastLine(out)), error: null }).then(resolve);
      } }; return chain;
  } } as unknown as SupabaseClient;
}
describe("destinos Central respeitam RLS de registro e organização", () => {
  it.each(["own", "own_and_unassigned"])("agent em %s: própria sim, outro dono não, fila conforme RLS", async mode => {
    sql(`update organizations set settings = jsonb_build_object('visibility_mode', '${mode}') where id = '${org}';`);
    const items = await resolverDestinosDosAvisos(authenticated(), org, "agent", [
      ...convs.map(ref_id => ({ kind: "handoff", ref_kind: "conversation", ref_id })),
      ...leads.map(ref_id => ({ kind: "other", ref_kind: "lead", ref_id })),
    ]);
    const expected = ["disponivel", mode === "own" ? "indisponivel" : "disponivel", "indisponivel", "indisponivel"];
    expect(items.map(i => i.destination.estado)).toEqual([...expected, ...expected]);
    for (const i of [2, 3, 6, 7]) expect(items[i]?.destination).not.toHaveProperty("href");
  });
});
