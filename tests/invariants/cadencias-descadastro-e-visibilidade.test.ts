/**
 * Cadências (migration 9251): o descadastro vale por CONTATO e sobrevive ao
 * negócio e à cadência apagados; as rotas de inscrição e retirada só alcançam o
 * negócio que a sessão enxerga; e a leitura das inscrições e dos eventos segue
 * a visibilidade do negócio. Postgres real: as rotas rodam de verdade, com o
 * client da sessão como `authenticated` + JWT (a RLS decide) e o admin como
 * service_role.
 */
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/cadencias/[id]/inscricoes/route";
import { DELETE } from "@/app/api/v1/cadencias/[id]/inscricoes/[inscricaoId]/route";
import { countAs, GOV_AGENT_A, GOV_AGENT_B, GOV_CONTACT_2, GOV_CONTACT_3, GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";
import { adminEmConexao, novaConexaoDeCadencias, sessaoEmConexao } from "../support/cadencias-pg";

const estado = vi.hoisted(() => ({ admin: null as unknown, sessao: null as unknown, usuario: "" }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => estado.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => estado.sessao }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => ({ ok: true, user: { id: estado.usuario, idioma: "pt-BR" }, org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "agent" } }) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const CAD = "ca173802-0000-4000-8000-000000000001";
const LEAD_A = "ca173802-0000-4000-8000-0000000000a1"; // de GOV_AGENT_A
const LEAD_B = "ca173802-0000-4000-8000-0000000000b1"; // de GOV_AGENT_B
const admin = novaConexaoDeCadencias(); const sessao = novaConexaoDeCadencias();

const n = (consulta: string) => Number(sql(consulta));
function inscrever(lead: string): string {
  return sql(`select public.fn_cadencia_inscrever('${GOV_ORG}','${CAD}','${lead}','${GOV_MANAGER}',false)->>'id';`);
}
function tentarInscrever(lead: string): string {
  try { return inscrever(lead); } catch (erro) { return String((erro as { stderr?: string }).stderr ?? erro); }
}
function pedido(corpo: unknown) {
  return new Request("http://synthetic.test/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }) as NextRequest;
}

beforeAll(async () => {
  seedGov();
  sql(`select public.fn_cadencias_provisionar();
    insert into public.modulos_instalados(modulo,estado) values('cadencias','ativo') on conflict(modulo) do update set estado='ativo';
    update public.organizations set settings='{"cadencias":{"enabled":true},"visibility_mode":"own"}'::jsonb where id='${GOV_ORG}';
    update public.contacts set email=id||'@synthetic.test' where id in ('${GOV_CONTACT_2}','${GOV_CONTACT_3}');
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,owner_user_id) values
      ('${LEAD_A}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','${GOV_CONTACT_2}','Negócio de A','${GOV_AGENT_A}'),
      ('${LEAD_B}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','${GOV_CONTACT_3}','Negócio de B','${GOV_AGENT_B}');
    insert into public.email_cadences(id,organization_id,name,status) values('${CAD}','${GOV_ORG}','Sequência sintética','ativa');`);
  await admin.connect(); await sessao.connect();
  estado.admin = adminEmConexao(admin);
  estado.sessao = sessaoEmConexao(sessao, () => estado.usuario);
});
afterAll(async () => { await admin.end(); await sessao.end(); });

describe("rotas de inscrição conferem se a sessão enxerga o negócio (agent, modo 'own')", () => {
  it("inscrever negócio de colega: 404 e nada gravado; o próprio negócio: 201", async () => {
    estado.usuario = GOV_AGENT_A;
    const alheio = await POST(pedido({ lead_id: LEAD_B }), { params: Promise.resolve({ id: CAD }) });
    expect(alheio.status).toBe(404);
    expect(n(`select count(*) from public.email_cadence_enrollments where lead_id='${LEAD_B}'`)).toBe(0);
    expect(n(`select count(*) from public.email_cadence_events where lead_id='${LEAD_B}'`)).toBe(0);

    const proprio = await POST(pedido({ lead_id: LEAD_A }), { params: Promise.resolve({ id: CAD }) });
    expect(proprio.status).toBe(201);
    expect(n(`select count(*) from public.email_cadence_enrollments where lead_id='${LEAD_A}' and status='ativa'`)).toBe(1);
  });

  it("retirar inscrição de negócio de colega: 404 e nada gravado; a própria: 200", async () => {
    const insB = inscrever(LEAD_B);
    const insA = sql(`select id from public.email_cadence_enrollments where lead_id='${LEAD_A}'`);
    estado.usuario = GOV_AGENT_A;
    const alheia = await DELETE(new Request("http://synthetic.test/api", { method: "DELETE" }), { params: Promise.resolve({ id: CAD, inscricaoId: insB }) });
    expect(alheia.status).toBe(404);
    expect(sql(`select status from public.email_cadence_enrollments where id='${insB}'`)).toBe("ativa");
    expect(n(`select count(*) from public.email_cadence_events where enrollment_id='${insB}' and tipo='parada'`)).toBe(0);

    const propria = await DELETE(new Request("http://synthetic.test/api", { method: "DELETE" }), { params: Promise.resolve({ id: CAD, inscricaoId: insA }) });
    expect(propria.status).toBe(200);
    expect(sql(`select status||':'||motivo_parada from public.email_cadence_enrollments where id='${insA}'`)).toBe("parada:manual");
  });
});

describe("leitura das inscrições e dos eventos segue a visibilidade do negócio", () => {
  it("cada agent lê só as linhas do próprio negócio; o manager lê as duas", () => {
    for (const tabela of ["email_cadence_enrollments", "email_cadence_events"]) {
      const de = (lead: string) => `select count(*) from public.${tabela} where lead_id='${lead}';`;
      expect(n(de(LEAD_A)), `${tabela}: a fixture precisa de linha de A`).toBeGreaterThan(0);
      expect(n(de(LEAD_B)), `${tabela}: a fixture precisa de linha de B`).toBeGreaterThan(0);
      expect(countAs(GOV_AGENT_A, de(LEAD_A)), `${tabela}: A lê o próprio`).toBe(n(de(LEAD_A)));
      expect(countAs(GOV_AGENT_A, de(LEAD_B)), `${tabela}: A não lê o de B`).toBe(0);
      expect(countAs(GOV_AGENT_B, de(LEAD_B)), `${tabela}: B lê o próprio`).toBe(n(de(LEAD_B)));
      expect(countAs(GOV_AGENT_B, de(LEAD_A)), `${tabela}: B não lê o de A`).toBe(0);
      expect(countAs(GOV_MANAGER, `select count(*) from public.${tabela} where lead_id in ('${LEAD_A}','${LEAD_B}');`)).toBe(n(de(LEAD_A)) + n(de(LEAD_B)));
    }
  });

  it("a supressão é só do servidor: RLS ligada e nenhum privilégio de sessão", () => {
    expect(sql(`select relrowsecurity::text from pg_class where oid='public.email_cadence_suppressions'::regclass`)).toBe("true");
    for (const papel of ["anon", "authenticated"]) {
      expect(sql(`select has_table_privilege('${papel}','public.email_cadence_suppressions','select,insert,update,delete')::text`)).toBe("false");
    }
  });
});

describe("descadastro vale por contato e sobrevive ao negócio e à cadência apagados", () => {
  it("descadastrar, apagar o negócio, tentar reinscrever: recusa", () => {
    const ins = sql(`select id from public.email_cadence_enrollments where lead_id='${LEAD_B}'`);
    expect(sql(`select public.fn_cadencia_descadastrar('${ins}','${GOV_ORG}')`)).toBe("1");
    expect(sql(`select origem from public.email_cadence_suppressions where organization_id='${GOV_ORG}' and contact_id='${GOV_CONTACT_3}'`)).toBe("link");

    sql(`delete from public.crm_leads where id='${LEAD_B}';`);
    expect(n(`select count(*) from public.email_cadence_enrollments where contact_id='${GOV_CONTACT_3}'`), "a inscrição caiu com o negócio").toBe(0);

    const novo = "ca173802-0000-4000-8000-0000000000b2";
    sql(`insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values('${novo}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','${GOV_CONTACT_3}','Mesmo contato, negócio novo');`);
    expect(tentarInscrever(novo)).toContain("cadencia_descadastrado");

    // E a cadência apagada também não leva a supressão.
    sql(`delete from public.email_cadences where id='${CAD}';
      insert into public.email_cadences(id,organization_id,name,status) values('${CAD}','${GOV_ORG}','Sequência sintética','ativa');`);
    expect(tentarInscrever(novo)).toContain("cadencia_descadastrado");
    expect(n(`select count(*) from public.email_cadence_enrollments where contact_id='${GOV_CONTACT_3}'`)).toBe(0);
  });

  it("controle: contato sem descadastro inscreve normalmente", () => {
    expect(tentarInscrever(LEAD_A).length).toBe(36);
  });

  it("backfill: descadastro legado na inscrição vira supressão do contato, uma vez só", () => {
    sql(`delete from public.email_cadence_suppressions where contact_id='${GOV_CONTACT_2}';
      update public.email_cadence_enrollments set status='parada',motivo_parada='descadastro' where lead_id='${LEAD_A}';
      select public.fn_cadencias_provisionar(); select public.fn_cadencias_provisionar();`);
    expect(sql(`select count(*)||':'||min(origem) from public.email_cadence_suppressions where organization_id='${GOV_ORG}' and contact_id='${GOV_CONTACT_2}'`)).toBe("1:backfill");
  });
});
