import { sql as executeSql } from "./gov-helpers";
import { describe, expect, it } from "vitest";

// Local-only integration: no URL/credentials, no ports and no route to external services.
const org = "ac160000-0000-4000-8000-000000000001";
const a = "ac160000-0000-4000-8000-000000000002";
const b = "ac160000-0000-4000-8000-000000000003";
const manager = "ac160000-0000-4000-8000-000000000004";
const neighbor = "ac160000-0000-4000-8000-000000000005";
const ca = "ac160000-0000-4000-8000-000000000006";
const cb = "ac160000-0000-4000-8000-000000000007";
const pa = "ac160000-0000-4000-8000-000000000008";
const pb = "ac160000-0000-4000-8000-000000000009";
const sa = "ac160000-0000-4000-8000-000000000010";
const sb = "ac160000-0000-4000-8000-000000000011";
const contactA = "ac160000-0000-4000-8000-000000000012";
const contactB = "ac160000-0000-4000-8000-000000000013";
const leadA = "ac160000-0000-4000-8000-000000000014";
const leadB = "ac160000-0000-4000-8000-000000000015";
const convB = "ac160000-0000-4000-8000-000000000016";
const shared = "ac160000-0000-4000-8000-000000000017";
const convA = "ac160000-0000-4000-8000-000000000018";
function auth(user = a) {
  return `set local role authenticated; select set_config('request.jwt.claims','{"sub":"${user}"}',true);`;
}
const seed = `
insert into auth.users(id,email) values ('${a}','acl-a@synthetic.invalid'),('${b}','acl-b@synthetic.invalid'),('${manager}','acl-manager@synthetic.invalid');
insert into public.organizations(id,slug,legal_name,display_name,settings) values
('${org}','acl-contract','Synthetic','Synthetic','{"visibility_mode":"own"}'),('${neighbor}','acl-neighbor','Synthetic','Synthetic','{}');
insert into public.user_organizations(organization_id,user_id,role,accepted_at) values ('${org}','${a}','agent',now()),('${org}','${b}','agent',now()),('${org}','${manager}','manager',now());
insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status) values ('${ca}','${org}','acl-contract-a','\\x00','WORKING'),('${cb}','${org}','acl-contract-b','\\x00','WORKING');
insert into public.crm_pipelines(id,organization_id,name,slug) values ('${pa}','${org}','Pipeline A','acl-a'),('${pb}','${org}','Pipeline B','acl-b');
insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position) values ('${sa}','${org}','${pa}','Open A','open-a',1),('${sb}','${org}','${pb}','Open B','open-b',1);
insert into public.contacts(id,organization_id,name,created_by_user_id) values ('${contactA}','${org}','Manual A','${a}'),('${contactB}','${org}','Manual B','${b}'),('${shared}','${org}','Shared','${a}');
insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,owner_user_id) values ('${leadA}','${org}','${pa}','${sa}','${shared}','Own negotiation','${a}'),('${leadB}','${org}','${pb}','${sb}','${shared}','Other negotiation','${b}');
insert into public.conversations(id,organization_id,contact_id,channel_session_id,assigned_to_user_id,status,assignee_kind) values ('${convA}','${org}','${shared}','${ca}','${a}','claimed','user'),('${convB}','${org}','${contactB}','${cb}','${b}','closed','user');
insert into public.messages(organization_id,conversation_id,contact_id,channel_session_id,type,direction,body,media_storage_path) values ('${org}','${convB}','${contactB}','${cb}','text','inbound','Hidden synthetic','${org}/hidden.dat');
update public.conversations set status='closed',assigned_to_user_id='${b}',assignee_kind='user' where id='${convB}';
insert into public.member_access_scopes(organization_id,user_id,pipeline_ids,channel_ids) values ('${org}','${a}',array['${pa}'::uuid],array['${ca}'::uuid]);
`;
function sql(script: string) { return executeSql(`begin;\n${seed}\n${script}\nrollback;`); }
function assert(expression: string) {
  return `do $$begin if not (${expression}) then raise exception 'contract_failed';end if;end$$;`;
}
function denied(statement: string) {
  return `do $$begin begin ${statement}; raise exception 'expected_denial';exception when insufficient_privilege then null;end;end$$;`;
}
describe("Escopos opt-in — PostgreSQL real com JWTs sintéticos", () => {
  it("AND: dono próprio não ultrapassa funil/canal; contato e negociação de colega invisíveis", () => {
    sql(
      `${auth()} ${assert(`(select count(*)=1 from public.crm_pipelines) and (select count(*)=1 from public.channel_sessions) and (select count(*)=1 from public.crm_leads) and (select count(*)=2 from public.contacts) and (select count(*)=0 from public.messages)`)}`,
    );
  });
  it("contato compartilhado não concede negociação/conversa/nota alheia", () => {
    sql(
      `update public.conversations set contact_id='${shared}' where id='${convB}'; insert into public.conversation_notes(organization_id,conversation_id,body)values('${org}','${convB}','Private B'); ${auth()} ${assert(`exists(select 1 from public.contacts where id='${shared}') and not exists(select 1 from public.crm_leads where id='${leadB}') and not exists(select 1 from public.conversation_notes)`)}`,
    );
  });
  it("UUID conhecido não permite RPC de transferência/claim de conversa alheia", () => {
    sql(
      `${auth()} ${assert(`(select count(*)=0 from public.fn_conversation_assign('${org}','${convB}','${a}','transfer',null,false))`)} reset role; ${assert(`exists(select 1 from public.conversations where id='${convB}' and status='closed' and assigned_to_user_id='${b}')`)}`,
    );
  });
  it("abertura manual nasce própria sob own, canal correto e nenhuma mensagem", () => {
    sql(
      `${auth()} select public.fn_open_conversation_manual('${org}','${contactA}','${ca}'); ${assert(`exists(select 1 from public.conversations where contact_id='${contactA}' and assigned_to_user_id=auth.uid() and status='claimed' and channel_session_id='${ca}') and (select count(*)=0 from public.messages)`)}`,
    );
  });
  it("duas aberturas manuais sequenciais reutilizam id e somente um evento de atribuição", () => {
    sql(
      `${auth()} select public.fn_open_conversation_manual('${org}','${contactA}','${ca}'); select public.fn_open_conversation_manual('${org}','${contactA}','${ca}'); ${assert(`(select count(*)=1 from public.conversations where contact_id='${contactA}') and (select count(*)=1 from public.conversation_assignment_events where reason='claim')`)}`,
    );
  });
  it("recusa contato/canal não autorizado e não reabre conversa de colega", () => {
    sql(
      `${auth()} ${denied(`perform public.fn_open_conversation_manual('${org}','${contactB}','${cb}')`)} ${denied(`perform public.fn_open_conversation_manual('${org}','${contactA}','${cb}')`)} reset role; ${assert(`exists(select 1 from public.conversations where id='${convB}' and status='closed')`)}`,
    );
  });
  it("carteira alheia recusa abertura sem alterar carteira/cards", () => {
    sql(
      `select public.fn_definir_carteira_do_cliente('${org}','${manager}','${contactA}','${b}','manual'); ${auth()} ${denied(`perform public.fn_open_conversation_manual('${org}','${contactA}','${ca}')`)} reset role; ${assert(`not exists(select 1 from public.conversations where contact_id='${contactA}') and exists(select 1 from public.contacts where id='${contactA}' and carteira_user_id='${b}')`)}`,
    );
  });
  it("RPC excluir contato oculto não apaga histórico antes da recusa", () => {
    sql(
      `${auth()} ${denied(`perform public.fn_apagar_contato_com_historico('${contactB}','${org}')`)} reset role; ${assert(`exists(select 1 from public.messages where conversation_id='${convB}') and exists(select 1 from public.conversations where id='${convB}')`)}`,
    );
  });
  it("não aceita autoria falsificada ou alteração de autoria para conquistar contato", () => {
    sql(
      `${auth()} ${denied(`insert into public.contacts(organization_id,name,created_by_user_id) values('${org}','Fake creator','${b}')`)} ${denied(`update public.contacts set created_by_user_id='${b}' where id='${contactA}'`)}`,
    );
  });
  it("membro não altera a própria configuração; arrays vazios negam", () => {
    sql(
      `${auth()} update public.member_access_scopes set channel_ids=null where organization_id='${org}' and user_id='${a}'; ${assert(`exists(select 1 from public.member_access_scopes where user_id='${a}' and channel_ids is not null)`)} reset role; update public.member_access_scopes set channel_ids='{}',pipeline_ids='{}' where user_id='${a}'; ${auth()} ${assert(`(select count(*)=0 from public.channel_sessions) and (select count(*)=0 from public.crm_pipelines)`)}`,
    );
  });
  it("gestor e membro sem opt-in preservam leitura legado; vizinho não dá grants", () => {
    sql(
      `${auth(manager)} ${assert(`(select count(*)=3 from public.contacts) and (select count(*)=2 from public.crm_leads)`)} ${assert(`not public.fn_acl_channel('${neighbor}','${ca}')`)} reset role; delete from public.member_access_scopes; ${auth()} ${assert(`(select count(*)=3 from public.contacts)`)}`,
    );
  });
  it("revogação de membership corta acesso mesmo com grants persistentes", () => {
    sql(
      `update public.user_organizations set revoked_at=now() where organization_id='${org}' and user_id='${a}'; ${auth()} ${assert(`(select count(*)=0 from public.contacts) and (select count(*)=0 from public.conversations)`)}`,
    );
  });
  it("Storage direto recusa arquivo de conversa oculta", () => {
    sql(`${auth()} ${assert(`not public.fn_acl_storage('whatsapp-media','${org}/hidden.dat')`)}`);
  });
  it("entrada automática do serviço não assume humano nem envia", () => {
    sql(
      `select public.fn_service_begin('${org}','${contactA}','${ca}'); ${assert(`exists(select 1 from public.conversations where contact_id='${contactA}' and assigned_to_user_id is null and assignee_kind is null)`)}`,
    );
  });
  it("contato criado por A perde acesso após atribuição exclusiva a B", () => {
    sql(
      `insert into public.crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,owner_user_id) values('${org}','${pb}','${sb}','${contactA}','Transferred','${b}'); ${auth()} ${assert(`not exists(select 1 from public.contacts where id='${contactA}')`)}`,
    );
  });
  it("não aceita referência forjada ao anexo/avatares de colega", () => {
    sql(
      `${auth()} ${denied(`insert into public.conversation_notes(organization_id,conversation_id,body,media_storage_path) values('${org}','${convA}','Forged','${org}/${convB}/private.pdf')`)} ${denied(`update public.contacts set avatar_storage_path='${org}/avatars/${contactB}.jpg' where id='${contactA}'`)}`,
    );
  });
  it("trocar o contato da conversa própria não fabrica acesso ao contato alheio", () => {
    sql(
      `${auth()} ${denied(`update public.conversations set contact_id='${contactB}' where id='${convA}'`)} ${assert(`not exists(select 1 from public.contacts where id='${contactB}')`)}`,
    );
  });
  it("conversa livre em carteira alheia também recusa claim quando a fila é visível", () => {
    sql(`update public.organizations set settings='{"visibility_mode":"own_and_unassigned"}' where id='${org}';
    select public.fn_definir_carteira_do_cliente('${org}','${manager}','${contactA}','${b}','manual');
    select public.fn_service_begin('${org}','${contactA}','${ca}');
    ${auth()} ${denied(`perform public.fn_conversation_assign('${org}',(select id from public.conversations where contact_id='${contactA}'),'${a}','claim',null,true)`)}
    reset role; ${assert(`exists(select 1 from public.conversations where contact_id='${contactA}' and assigned_to_user_id is null)`)}`);
  });
  it("outro tenant continua invisível mesmo com UUID conhecido", () => {
    sql(`insert into public.contacts(organization_id,name)values('${neighbor}','Neighbor sentinel');
    ${auth()} ${assert(`not exists(select 1 from public.contacts where organization_id='${neighbor}')`)}
    ${denied(`perform public.fn_open_conversation_manual('${neighbor}','${contactA}','${ca}')`)}`);
  });
  it("permitir o canal não amplia acesso ao colega no mesmo canal", () => {
    sql(`update public.conversations set channel_session_id='${ca}' where id='${convB}';
    ${auth()} ${assert(`not exists(select 1 from public.conversations where id='${convB}')`)}
    ${denied(`perform public.fn_conversation_assign('${org}','${convB}','${a}','transfer',null,false)`)}`);
  });
  it("UPDATE direto não contorna a carteira protegida no claim", () => {
    sql(`update public.organizations set settings='{"visibility_mode":"own_and_unassigned"}' where id='${org}';
    select public.fn_definir_carteira_do_cliente('${org}','${manager}','${contactA}','${b}','manual');
    select public.fn_service_begin('${org}','${contactA}','${ca}');
    ${auth()} ${denied(`update public.conversations set assigned_to_user_id='${a}' where contact_id='${contactA}'`)}
    reset role; ${assert(`exists(select 1 from public.conversations where contact_id='${contactA}' and assigned_to_user_id is null)`)}`);
  });

  it("roteiro de conversa alheia fica oculto inclusive no contato compartilhado", () => {
    sql(`insert into public.followup_flow_versions(id,organization_id,graph)
    values('fa160000-0000-4000-8000-000000000001','${org}','{}');
    insert into public.followup_flow_pointers(id,organization_id,name,status,active_version_id,surface)
    values('fa160000-0000-4000-8000-000000000002','${org}','Synthetic script','active','fa160000-0000-4000-8000-000000000001','atendimento');
    insert into public.followup_enrollments(id,organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status)
    values('fa160000-0000-4000-8000-000000000003','${org}','fa160000-0000-4000-8000-000000000002','fa160000-0000-4000-8000-000000000001','${shared}','${convB}','start','completed');
    ${auth()} ${assert(`exists(select 1 from public.contacts where id='${shared}') and not exists(select 1 from public.followup_enrollments)`)}
    reset role; ${auth(manager)} ${assert(`exists(select 1 from public.followup_enrollments)`)}`);
  });
  it("revogar canal retira destinatário do push sem enviar notificação", () => {
    sql(`insert into public.push_subscriptions(organization_id,user_id,endpoint,p256dh,auth)
    values('${org}','${a}','https://synthetic.invalid/push','fake','fake');
    ${assert(`exists(select 1 from public.fn_push_inscricoes_que_veem_a_conversa('${org}','${convA}'))`)}
    update public.member_access_scopes set channel_ids='{}' where organization_id='${org}' and user_id='${a}';
    ${assert(`not exists(select 1 from public.fn_push_inscricoes_que_veem_a_conversa('${org}','${convA}'))`)}`);
  });
});
