/**
 * Cadências (migration 9251): o descadastro vale pelo ENDEREÇO (hash por
 * organização) e pelo contato, e sobrevive ao negócio, à cadência e ao contato
 * apagados, à troca de e-mail e à fusão; o link resolve pelo destinatário do
 * envio; as rotas de inscrição e retirada só alcançam o
 * negócio que a sessão enxerga; e a leitura das inscrições e dos eventos segue
 * a visibilidade do negócio. Postgres real: as rotas rodam de verdade, com o
 * client da sessão como `authenticated` + JWT (a RLS decide) e o admin como
 * service_role.
 */
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/v1/cadencias/[id]/inscricoes/route";
import { DELETE } from "@/app/api/v1/cadencias/[id]/inscricoes/[inscricaoId]/route";
import { POST as DESCADASTRAR } from "@/app/api/v1/webhooks/cadencia-descadastro/[token]/route";
import { signCadenciaLink } from "@/lib/cadencias/token";
import { countAs, GOV_AGENT_A, GOV_AGENT_B, GOV_CONTACT_2, GOV_CONTACT_3, GOV_MANAGER, GOV_ORG, GOV_PIPELINE, GOV_STAGE, lastLine, seedGov, sql } from "./gov-helpers";
import { adminEmConexao, novaConexaoDeCadencias, sessaoEmConexao } from "../support/cadencias-pg";

const estado = vi.hoisted(() => ({ admin: null as unknown, sessao: null as unknown, usuario: "" }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => estado.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => estado.sessao }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: async () => ({ ok: true, user: { id: estado.usuario, idioma: "pt-BR" }, org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "agent" } }) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => true }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/rate-limit", () => ({ tokenFailureLimited: async () => false, registrarFalhaDeToken: async () => undefined }));

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
  vi.stubEnv("INTERNAL_SECRET", "segredo-sintetico-do-descadastro");
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
afterAll(async () => { await admin.end(); await sessao.end(); vi.unstubAllEnvs(); });

const ID = (sufixo: string) => `ca173802-0000-4000-8000-${sufixo.padStart(12, "0")}`;
function contato(id: string, email: string) {
  sql(`insert into public.contacts(id,organization_id,display_name,email) values('${id}','${GOV_ORG}','Pessoa sintética','${email}');`);
}
function negocio(id: string, dono: string) {
  sql(`insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values('${id}','${GOV_ORG}','${GOV_PIPELINE}','${GOV_STAGE}','${dono}','Negócio sintético');`);
}
/** A reserva de produção: o destinatário nasce como nasce antes de um envio real. */
function reservar(inscricao: string): string {
  return lastLine(sql(`update public.email_cadence_enrollments set processamento_id=gen_random_uuid(),envio_pendente_passo_id=null where id='${inscricao}';
    select public.fn_cadencia_reservar_destinatario('${GOV_ORG}','${inscricao}',(select processamento_id from public.email_cadence_enrollments where id='${inscricao}'),'email-1')->>'destinatario_id';`));
}
function tentarReservar(inscricao: string): string {
  try { return reservar(inscricao); } catch (erro) { return String((erro as { stderr?: string }).stderr ?? erro); }
}
function descadastrar(destinatario: string): string {
  return sql(`select public.fn_cadencia_descadastrar('${destinatario}')->>'suprimido_agora'`);
}
const suprimidoPeloEndereco = (email: string) =>
  n(`select count(*) from public.email_cadence_suppressions where organization_id='${GOV_ORG}' and email_hash=public.fn_cadencia_hash_do_email('${GOV_ORG}','${email}')`);
async function clicar(destinatario: string) {
  const token = signCadenciaLink({ destinatario_id: destinatario }, "descadastro");
  return DESCADASTRAR(new Request("http://synthetic.test/api", { method: "POST" }) as NextRequest, { params: Promise.resolve({ token }) });
}

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

  it("a supressão e o destinatário são só do servidor: RLS ligada e nenhum privilégio de sessão", () => {
    for (const tabela of ["email_cadence_suppressions", "email_cadence_recipients"]) {
      expect(sql(`select relrowsecurity::text from pg_class where oid='public.${tabela}'::regclass`)).toBe("true");
      for (const papel of ["anon", "authenticated"]) {
        expect(sql(`select has_table_privilege('${papel}','public.${tabela}','select,insert,update,delete')::text`), `${tabela}/${papel}`).toBe("false");
      }
    }
  });
});

describe("descadastro vale pelo endereço e pelo contato, e o link resolve pelo destinatário do envio", () => {
  it("P6: negócio apagado antes do clique — o link grava a supressão e a reinscrição é recusada; controle: destinatário inexistente não afirma sucesso", async () => {
    const ins = sql(`select id from public.email_cadence_enrollments where lead_id='${LEAD_B}'`);
    const destinatario = reservar(ins);
    sql(`delete from public.crm_leads where id='${LEAD_B}';`);
    expect(n(`select count(*) from public.email_cadence_enrollments where contact_id='${GOV_CONTACT_3}'`), "a inscrição caiu com o negócio").toBe(0);

    const resposta = await clicar(destinatario);
    expect(resposta.status).toBe(200);
    expect(await resposta.text()).toContain("não vai mais receber");
    expect(sql(`select count(*)||':'||min(origem) from public.email_cadence_suppressions where organization_id='${GOV_ORG}' and contact_id='${GOV_CONTACT_3}'
      and email_hash=public.fn_cadencia_hash_do_email('${GOV_ORG}',(select email from public.contacts where id='${GOV_CONTACT_3}'))`)).toBe("1:link");

    const novo = ID("b2");
    negocio(novo, GOV_CONTACT_3);
    expect(tentarInscrever(novo)).toContain("cadencia_descadastrado");
    // E a cadência apagada também não leva a supressão.
    sql(`delete from public.email_cadences where id='${CAD}';
      insert into public.email_cadences(id,organization_id,name,status) values('${CAD}','${GOV_ORG}','Sequência sintética','ativa');`);
    expect(tentarInscrever(novo)).toContain("cadencia_descadastrado");
    expect(n(`select count(*) from public.email_cadence_enrollments where contact_id='${GOV_CONTACT_3}'`)).toBe(0);

    const antes = n(`select count(*) from public.email_cadence_suppressions`);
    const inexistente = await clicar(ID("ff"));
    expect(inexistente.status).toBe(404);
    expect(await inexistente.text()).not.toContain("não vai mais receber");
    expect(n(`select count(*) from public.email_cadence_suppressions`)).toBe(antes);
  });

  it("controle: contato sem descadastro inscreve normalmente", () => {
    expect(tentarInscrever(LEAD_A).length).toBe(36);
  });

  it("P1: contato apagado pela rota não leva a supressão — o mesmo endereço em contato novo é recusado; controle: outro endereço inscreve", () => {
    contato(ID("1001"), "p1@synthetic.test"); negocio(ID("1101"), ID("1001"));
    expect(descadastrar(reservar(inscrever(ID("1101"))))).toBe("true");
    sql(`select public.fn_apagar_contato_com_historico('${ID("1001")}','${GOV_ORG}');`);
    expect(n(`select count(*) from public.contacts where id='${ID("1001")}'`), "o contato saiu").toBe(0);
    expect(n(`select count(*) from public.email_cadence_suppressions where organization_id='${GOV_ORG}' and contact_id is null
      and email_hash=public.fn_cadencia_hash_do_email('${GOV_ORG}','p1@synthetic.test')`)).toBe(1);

    contato(ID("1002"), "P1@Synthetic.TEST"); negocio(ID("1102"), ID("1002"));
    expect(tentarInscrever(ID("1102"))).toContain("cadencia_descadastrado");

    contato(ID("1003"), "p1-outro@synthetic.test"); negocio(ID("1103"), ID("1003"));
    expect(tentarInscrever(ID("1103")).length).toBe(36);
  });

  it("P2: fusão — o endereço do absorvido fica só na lápide e segue suprimido; controle: outro endereço inscreve", () => {
    contato(ID("2001"), "p2@synthetic.test"); negocio(ID("2101"), ID("2001"));
    contato(ID("2002"), "p2-principal@synthetic.test");
    expect(descadastrar(reservar(inscrever(ID("2101"))))).toBe("true");
    sql(`select public.fn_mesclar_contatos('${GOV_ORG}','${ID("2002")}',array['${ID("2001")}']::uuid[]);`);
    expect(sql(`select email||':'||(is_merged_into is not null)::text from public.contacts where id='${ID("2001")}'`), "o endereço ficou na lápide").toBe("p2@synthetic.test:true");
    expect(sql(`select email from public.contacts where id='${ID("2002")}'`), "o principal manteve o próprio endereço").toBe("p2-principal@synthetic.test");

    contato(ID("2003"), "p2@synthetic.test"); negocio(ID("2103"), ID("2003"));
    expect(tentarInscrever(ID("2103"))).toContain("cadencia_descadastrado");

    contato(ID("2004"), "p2-outro@synthetic.test"); negocio(ID("2104"), ID("2004"));
    expect(tentarInscrever(ID("2104")).length).toBe(36);
  });

  it("P3: troca de e-mail — o contato segue recusado pelo ponteiro, o endereço antigo pelo hash, na inscrição e na reserva; controle: endereço limpo inscreve e reserva", () => {
    contato(ID("3001"), "p3@synthetic.test"); negocio(ID("3101"), ID("3001"));
    contato(ID("3002"), "p3-e@synthetic.test"); negocio(ID("3102"), ID("3002"));
    const ativaDeE = inscrever(ID("3102"));
    expect(descadastrar(reservar(inscrever(ID("3101"))))).toBe("true");

    sql(`update public.contacts set email='p3-novo@synthetic.test' where id='${ID("3001")}';`);
    negocio(ID("3103"), ID("3001"));
    expect(tentarInscrever(ID("3103")), "o mesmo contato, com e-mail novo").toContain("cadencia_descadastrado");
    // Inscrição ativa do mesmo contato que não passou pela inscrição (linha legada): a reserva recusa.
    sql(`insert into public.email_cadence_enrollments(organization_id,cadence_id,lead_id,contact_id) values('${GOV_ORG}','${CAD}','${ID("3103")}','${ID("3001")}');`);
    expect(tentarReservar(sql(`select id from public.email_cadence_enrollments where lead_id='${ID("3103")}'`))).toContain("cadencia_descadastrado");

    // Outro contato assume o endereço antigo: a reserva da inscrição que ele já tinha recusa pelo hash.
    sql(`update public.contacts set email='p3@synthetic.test' where id='${ID("3002")}';`);
    expect(tentarReservar(ativaDeE)).toContain("cadencia_descadastrado");
    negocio(ID("3104"), ID("3002"));
    expect(tentarInscrever(ID("3104"))).toContain("cadencia_descadastrado");

    contato(ID("3003"), "p3-f@synthetic.test"); negocio(ID("3105"), ID("3003"));
    expect(tentarReservar(inscrever(ID("3105"))).length).toBe(36);
  });

  it("backfill: descadastro legado na inscrição vira supressão com o hash do e-mail, a supressão sem hash ganha o hash, uma vez só; controle: inscrição sem descadastro não vira supressão", () => {
    contato(ID("4001"), "backfill-sem-hash@synthetic.test");
    sql(`delete from public.email_cadence_suppressions where contact_id='${GOV_CONTACT_2}';
      insert into public.email_cadence_suppressions(organization_id,contact_id,origem) values('${GOV_ORG}','${ID("4001")}','link');
      update public.email_cadence_enrollments set status='parada',motivo_parada='descadastro' where lead_id='${LEAD_A}';
      select public.fn_cadencias_provisionar(); select public.fn_cadencias_provisionar();`);
    expect(sql(`select count(*)||':'||min(origem) from public.email_cadence_suppressions where organization_id='${GOV_ORG}' and contact_id='${GOV_CONTACT_2}'
      and email_hash=public.fn_cadencia_hash_do_email('${GOV_ORG}',(select email from public.contacts where id='${GOV_CONTACT_2}'))`)).toBe("1:backfill");
    expect(sql(`select count(*)||':'||count(email_hash) from public.email_cadence_suppressions where contact_id='${ID("4001")}'`)).toBe("1:1");
    expect(suprimidoPeloEndereco("backfill-sem-hash@synthetic.test")).toBe(1);
    expect(n(`select count(*) from public.email_cadence_suppressions where contact_id='${ID("1003")}'`), "o contato de controle do P1 segue inscrito, sem supressão").toBe(0);
  });
});

describe("o endereço atual do contato suprimido ganha hash: o ponteiro some quando o contato é apagado", () => {
  it("R7: descadastra com a, o operador troca para b e apaga o contato — b em contato novo é recusado; controle: outro endereço inscreve", () => {
    contato(ID("7001"), "r7-a@synthetic.test"); negocio(ID("7101"), ID("7001"));
    expect(descadastrar(reservar(inscrever(ID("7101"))))).toBe("true");
    sql(`update public.contacts set email='r7-b@synthetic.test' where id='${ID("7001")}';`);
    expect(suprimidoPeloEndereco("r7-b@synthetic.test"), "a troca grava o hash do endereço novo").toBe(1);
    negocio(ID("7102"), ID("7001"));
    expect(tentarInscrever(ID("7102")), "o mesmo contato, com b").toContain("cadencia_descadastrado");

    sql(`select public.fn_apagar_contato_com_historico('${ID("7001")}','${GOV_ORG}');`);
    expect(n(`select count(*) from public.contacts where id='${ID("7001")}'`), "o contato saiu").toBe(0);
    contato(ID("7002"), "R7-B@synthetic.test"); negocio(ID("7103"), ID("7002"));
    expect(tentarInscrever(ID("7103"))).toContain("cadencia_descadastrado");

    contato(ID("7003"), "r7-c@synthetic.test"); negocio(ID("7104"), ID("7003"));
    expect(tentarInscrever(ID("7104")).length).toBe(36);
  });

  it("R8: troca de a para b ANTES do clique, contato apagado — b e a em contato novo são recusados; controle: a troca de contato sem descadastro não grava nada", async () => {
    contato(ID("8001"), "r8-a@synthetic.test"); negocio(ID("8101"), ID("8001"));
    const destinatario = reservar(inscrever(ID("8101")));
    sql(`update public.contacts set email='r8-b@synthetic.test' where id='${ID("8001")}';`);
    expect(suprimidoPeloEndereco("r8-b@synthetic.test"), "sem descadastro, a troca não suprime").toBe(0);

    const resposta = await clicar(destinatario);
    expect(resposta.status).toBe(200);
    expect(suprimidoPeloEndereco("r8-a@synthetic.test"), "o endereço que recebeu").toBe(1);
    expect(suprimidoPeloEndereco("r8-b@synthetic.test"), "o endereço atual").toBe(1);
    expect(n(`select count(*) from public.email_cadence_suppressions where contact_id='${ID("8001")}'`)).toBe(2);
    expect(descadastrar(destinatario), "clique repetido não grava de novo").toBe("false");

    sql(`select public.fn_apagar_contato_com_historico('${ID("8001")}','${GOV_ORG}');`);
    contato(ID("8002"), "r8-b@synthetic.test"); negocio(ID("8102"), ID("8002"));
    expect(tentarInscrever(ID("8102"))).toContain("cadencia_descadastrado");
    contato(ID("8003"), "r8-a@synthetic.test"); negocio(ID("8103"), ID("8003"));
    expect(tentarInscrever(ID("8103"))).toContain("cadencia_descadastrado");

    contato(ID("8004"), "r8-c@synthetic.test"); negocio(ID("8104"), ID("8004"));
    expect(tentarInscrever(ID("8104")).length).toBe(36);
  });

  it("apagar: supressão só pelo ponteiro (a forma sem hash que o esquema admite) — apagar o contato grava o hash do endereço corrente; controle: antes de apagar, o endereço não tinha hash", () => {
    contato(ID("9001"), "r9@synthetic.test");
    sql(`insert into public.email_cadence_suppressions(organization_id,contact_id,origem) values('${GOV_ORG}','${ID("9001")}','link');`);
    expect(suprimidoPeloEndereco("r9@synthetic.test")).toBe(0);

    sql(`delete from public.contacts where id='${ID("9001")}';`);
    expect(sql(`select count(*)||':'||count(contact_id)||':'||min(origem) from public.email_cadence_suppressions where organization_id='${GOV_ORG}'
      and email_hash=public.fn_cadencia_hash_do_email('${GOV_ORG}','r9@synthetic.test')`)).toBe("1:0:link");
    contato(ID("9003"), "r9@synthetic.test"); negocio(ID("9103"), ID("9003"));
    expect(tentarInscrever(ID("9103"))).toContain("cadencia_descadastrado");

    contato(ID("9004"), "r9-outro@synthetic.test"); negocio(ID("9104"), ID("9004"));
    expect(tentarInscrever(ID("9104")).length).toBe(36);
  });

  it("controle: apagar a organização com contato suprimido apaga tudo em cascata, sem o gatilho gravar órfão", () => {
    const outra = ID("9e01"), pessoa = ID("9e02");
    sql(`insert into public.organizations(id,slug,legal_name,display_name) values('${outra}','cadencias-r9e','Outra R9','Outra R9');
      insert into public.contacts(id,organization_id,display_name,email) values('${pessoa}','${outra}','Pessoa','r9e@synthetic.test');
      insert into public.email_cadence_suppressions(organization_id,email_hash,contact_id,origem)
        values('${outra}',public.fn_cadencia_hash_do_email('${outra}','r9e-antigo@synthetic.test'),'${pessoa}','link');
      delete from public.organizations where id='${outra}';`);
    expect(n(`select count(*) from public.email_cadence_suppressions where organization_id='${outra}'`)).toBe(0);
  });
});
