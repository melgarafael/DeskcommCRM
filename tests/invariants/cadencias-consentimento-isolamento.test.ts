import { beforeAll, describe, expect, it } from "vitest";
import { countAs, GOV_ORG, GOV_CONTACT_1, GOV_CONTACT_2, GOV_LEAD, GOV_AGENT_A, lastLine, seedGov, sql } from "./gov-helpers";
const CAD = "ca173800-0000-4000-8000-000000000001";
const INS = "ca173800-0000-4000-8000-000000000002";
const USER_B = "ca173800-0000-4000-8000-000000000004";
const OUTRA = "ca173800-0000-4000-8000-000000000003";
function abrir(org = GOV_ORG, passo = "email-1") { return lastLine(sql(`select public.fn_cadencia_registrar_abertura('${INS}','${org}','${passo}')::text;`)); }
function preparar() { sql(`update public.email_cadence_enrollments set rastreio_consentido=true, status='ativa',motivo_parada=null where id='${INS}'; update public.organizations set settings=jsonb_build_object('cadencias',jsonb_build_object('enabled',true)) where id='${GOV_ORG}';`); }
beforeAll(() => {
  seedGov();
  sql(`select public.fn_cadencias_provisionar();
    insert into public.modulos_instalados(modulo,estado) values('cadencias','ativo') on conflict(modulo) do update set estado='ativo';
    insert into public.organizations(id,slug,legal_name,display_name) values('${OUTRA}','cadencias-outra','Outra sintética','Outra') on conflict do nothing;
    insert into auth.users(id,email) values('${USER_B}','cadencias-b@invariant.test');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values('${USER_B}','${OUTRA}','agent',now());
    update public.crm_leads set contact_id='${GOV_CONTACT_1}' where id='${GOV_LEAD}';
    insert into public.email_cadences(id,organization_id,name) values('${CAD}','${GOV_ORG}','Sequência sintética');
    insert into public.email_cadence_enrollments(id,organization_id,cadence_id,lead_id,contact_id,ultimo_email_passo_id) values('${INS}','${GOV_ORG}','${CAD}','${GOV_LEAD}','${GOV_CONTACT_1}','email-1');`);
});
describe("abertura autorizada no banco, sem sessão de destinatário", () => {
  it("sem autorização não soma nem gera evento", () => {
    expect(abrir()).toBe("false");
    expect(sql(`select aberturas from public.email_cadence_enrollments where id='${INS}'`)).toBe("0");
    expect(sql(`select count(*) from public.email_cadence_events where enrollment_id='${INS}'`)).toBe("0");
  });
  it("consentimento e empresa ligados registram contagem e evento atomicamente", () => {
    preparar(); expect(abrir()).toBe("true");
    expect(sql(`select aberturas||':'||aberturas_ultimo_email from public.email_cadence_enrollments where id='${INS}'`)).toBe("1:1");
    expect(sql(`select count(*) from public.email_cadence_events where enrollment_id='${INS}' and tipo='aberto'`)).toBe("1");
  });
  it("abrir e-mail antigo não satisfaz ramo do e-mail atual", () => {
    expect(abrir(GOV_ORG,"email-antigo")).toBe("true");
    expect(sql(`select aberturas||':'||aberturas_ultimo_email from public.email_cadence_enrollments where id='${INS}'`)).toBe("2:1");
  });
  it("outra organização não altera nem lê a inscrição", () => {
    expect(abrir(OUTRA)).toBe("false");
    expect(countAs(GOV_AGENT_A,`select count(*) from public.email_cadence_enrollments where organization_id='${GOV_ORG}';`)).toBe(1);
    expect(countAs(USER_B,`select count(*) from public.email_cadence_enrollments where organization_id='${GOV_ORG}';`)).toBe(0);
  });
  it("string true não liga; desligar e descadastrar vetam o pixel", () => {
    sql(`update public.organizations set settings='{"cadencias":{"enabled":"true"}}'::jsonb where id='${GOV_ORG}';`); expect(abrir()).toBe("false");
    preparar(); sql(`update public.organizations set settings='{}'::jsonb where id='${GOV_ORG}';`); expect(abrir()).toBe("false");
    preparar(); sql(`update public.email_cadence_enrollments set status='parada',motivo_parada='descadastro',rastreio_consentido=false where id='${INS}';`); expect(abrir()).toBe("false");
  });
  it("descadastro de inscrição concluída cria supressão mesmo com empresa desligada e é idempotente", () => {
    preparar(); sql(`update public.email_cadence_enrollments set status='concluida' where id='${INS}'; update public.organizations set settings='{}'::jsonb where id='${GOV_ORG}';`);
    expect(sql(`select public.fn_cadencia_descadastrar('${INS}','${GOV_ORG}')`)).toBe("1");
    expect(sql(`select public.fn_cadencia_descadastrar('${INS}','${GOV_ORG}')`)).toBe("0");
    expect(sql(`select count(*) from public.email_cadence_events where enrollment_id='${INS}' and tipo='descadastrou'`)).toBe("1");
    expect(sql(`select motivo_parada from public.email_cadence_enrollments where id='${INS}'`)).toBe("descadastro");
  });
  it("redige o inscrito original mesmo se o negócio mudar de contato, sem redigir o vizinho", () => {
    preparar();
    const cadB = "ca173800-0000-4000-8000-000000000011";
    const insB = "ca173800-0000-4000-8000-000000000012";
    sql(`update public.crm_leads set contact_id='${GOV_CONTACT_2}' where id='${GOV_LEAD}' and organization_id='${GOV_ORG}';
      insert into public.email_cadences(id,organization_id,name) values('${cadB}','${GOV_ORG}','Sequência vizinha');
      insert into public.email_cadence_enrollments(id,organization_id,cadence_id,lead_id,contact_id) values('${insB}','${GOV_ORG}','${cadB}','${GOV_LEAD}','${GOV_CONTACT_2}');
      update public.email_cadence_events set metadata='{"codigo":"sintetico-a"}'::jsonb where enrollment_id='${INS}';
      insert into public.email_cadence_events(organization_id,cadence_id,enrollment_id,lead_id,tipo,metadata) values('${GOV_ORG}','${cadB}','${insB}','${GOV_LEAD}','inscrito','{"codigo":"sintetico-b"}'::jsonb);
      select public.fn_lgpd_cascade_redact_contact('${GOV_ORG}','${GOV_CONTACT_1}',gen_random_uuid());`);
    expect(sql(`select count(*) from public.email_cadence_events where enrollment_id='${insB}' and metadata->>'codigo'='sintetico-b'`)).toBe("1");
    expect(sql(`select status||':'||rastreio_consentido::text from public.email_cadence_enrollments where id='${INS}'`)).toBe("parada:false");
    expect(abrir()).toBe("false");
    expect(sql(`select count(*) from public.email_cadence_events where enrollment_id='${INS}' and metadata is not null`)).toBe("0");
  });
  it("RPC não é executável por anon nem authenticated", () => {
    for (const role of ["anon", "authenticated"]) expect(sql(`select has_function_privilege('${role}','public.fn_cadencia_registrar_abertura(uuid,uuid,text)','execute')::text`)).toBe("false");
  });
});
