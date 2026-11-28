import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import pg from "pg";

import { escolherAgenteDoNumero } from "@/lib/agent-engine/agent/agent-config";
import { haQuemAtendaASessao } from "@/lib/ai/agents/quem-atende-a-sessao";

/**
 * A CONEXÃO NOVA HERDA A CONFIGURAÇÃO, NÃO NASCE VAZIA (#4013).
 *
 * `conversations` é única por (organization_id, contact_id, channel_session_id).
 * Quando o MESMO telefone volta por OUTRA conexão — a empresa migrou da API
 * oficial para o QR, ou abriu uma conexão nova para o mesmo aparelho — cada
 * cliente ganha uma conversa nova numa conexão que nunca foi configurada:
 *
 *   1. sem agente de IA: `ai_agent_versions.channel_session_id` aponta para a
 *      conexão ANTIGA, então nem o seletor do turno nem o portão do dreno
 *      encontram quem atenda — a IA fica muda e o turno é pulado;
 *   2. sem regra de distribuição: `channel_routing_policies` só existe para a
 *      conexão antiga, e a nova distribui por nenhuma regra;
 *   3. em pré-go-live, que é o estado de FÁBRICA de `channel_sessions.metadata`
 *      (`ai_gate_mode = pre_go_live`, `ai_test_phone_numbers = []`): os clientes
 *      que a IA atendia na conexão antiga passam a ser barrados na nova.
 *
 * Medido numa instalação real (02/11/2026): o mesmo telefone em três conexões
 * (QR desligada com 25 conversas, API oficial desligada com 7, QR nova com 1) e
 * um cliente com três conversas com o mesmo vendedor, com a IA se comportando
 * de três formas diferentes conforme a conexão por onde ele escrevia.
 *
 * A correção NÃO funde conversas, NÃO migra histórico e NÃO apaga a antiga: a
 * conversa que NASCE herda as três peças da conversa mais recente do mesmo
 * contato na MESMA organização — e só o que falta. A troca de VENDEDOR já
 * tinha tratamento (`fn_conversa_que_continua`, 9054); esta é a troca de
 * CONEXÃO, com o mesmo vocabulário (mesma organização, mesmo contato, 1:1,
 * ordem por updated_at desc, id).
 *
 * Os sete lados opostos estão aqui: contato novo; conexão já configurada;
 * conversa de outra organização; três conexões com idempotência; agente
 * arquivado; conversa anterior encerrada; e "não cria dono" (é configuração,
 * não distribuição).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:invariants` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);

function sql(texto: string): string {
  return execFileSync("docker", ["exec", "-i", container as string, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-f", "-"], {
    input: texto,
    encoding: "utf8",
  }).trim();
}

/** Uma linha, uma coluna, texto cru — para conferir valor exato. */
function um(texto: string): string {
  return sql(texto).split("\n")[0]?.trim() ?? "";
}

const ORG = "d4013000-0000-4000-8000-000000000001";
const ORG_B = "d4013000-0000-4000-8000-000000000002";

/** Conexões. A antiga é a que tem a configuração; a nova é a que nasce vazia. */
const S1_OLD = "d4013000-0000-4000-8000-000000001001";
const S1_NEW = "d4013000-0000-4000-8000-000000001002";
const S2_NEW = "d4013000-0000-4000-8000-000000001003";
const S3_OLD = "d4013000-0000-4000-8000-000000001005";
const S3_OWN = "d4013000-0000-4000-8000-000000001006";
const S4_NEW = "d4013000-0000-4000-8000-000000001007";
const S4_B = "d4013000-0000-4000-8000-000000001008";
const S5_A = "d4013000-0000-4000-8000-000000001009";
const S5_B = "d4013000-0000-4000-8000-000000001010";
const S5_NEW = "d4013000-0000-4000-8000-000000001011";
const S6_OLD = "d4013000-0000-4000-8000-000000001012";
const S6_NEW = "d4013000-0000-4000-8000-000000001013";
const S7_OLD = "d4013000-0000-4000-8000-000000001014";
const S7_NEW = "d4013000-0000-4000-8000-000000001015";

const AG_X = "d4013000-0000-4000-8000-000000002002";
const AG_X1 = "d4013000-0000-4000-8000-000000002001";
const AG_X2 = "d4013000-0000-4000-8000-000000002003";
const AG_OWN = "d4013000-0000-4000-8000-000000002004";
const AG_ARCHIVED = "d4013000-0000-4000-8000-000000002005";
const AG_B = "d4013000-0000-4000-8000-000000002006";
const AG_X7 = "d4013000-0000-4000-8000-000000002007";

const V_X = "d4013000-0000-4000-8000-000000003002";
const V_OWN = "d4013000-0000-4000-8000-000000003004";

const U1 = "d4013000-0000-4000-8000-000000004001";
const U2 = "d4013000-0000-4000-8000-000000004002";

const C1 = "d4013000-0000-4000-8000-000000005001";
const C2 = "d4013000-0000-4000-8000-000000005002";
const C3 = "d4013000-0000-4000-8000-000000005003";
const C4 = "d4013000-0000-4000-8000-000000005004";
const C5 = "d4013000-0000-4000-8000-000000005005";
const C6 = "d4013000-0000-4000-8000-000000005006";
const C7 = "d4013000-0000-4000-8000-000000005007";

const POL1 = "d4013000-0000-4000-8000-000000006001";
const POL3 = "d4013000-0000-4000-8000-000000006003";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

let conv1 = "";
let conv2 = "";
let conv3 = "";
let conv4 = "";
let conv5 = "";
let conv6 = "";
let conv7 = "";

/** Estado medido ANTES do primeiro upsert — é o RED literal na conexão nova. */
let antesS1: { conversas: number; portao: boolean | null; agente: string | null } = {
  conversas: -1,
  portao: null,
  agente: null,
};

function seed(): void {
  sql(`
-- limpeza só do namespace deste invariante (o banco é recriado por arquivo)
delete from public.channel_routing_responsibles
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.channel_routing_policies
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.ai_agent_version_channels
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.conversations
 where organization_id in ('${ORG}', '${ORG_B}');
update public.ai_agents set published_version_id = null
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.ai_agent_versions
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.ai_agents
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.contacts
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.channel_sessions
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.user_organizations
 where organization_id in ('${ORG}', '${ORG_B}');
delete from public.organizations where id in ('${ORG}', '${ORG_B}');

insert into auth.users (id, email) values
  ('${U1}', 'heranca-4013-u1@invariant.test'),
  ('${U2}', 'heranca-4013-u2@invariant.test')
on conflict (id) do nothing;

insert into public.organizations (id, slug, legal_name, display_name) values
  ('${ORG}', 'heranca-4013', 'Heranca 4013 LTDA', 'Heranca 4013'),
  ('${ORG_B}', 'heranca-4013-b', 'Heranca 4013 B LTDA', 'Heranca 4013 B');

insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
  ('${U1}', '${ORG}', 'agent', now()),
  ('${U2}', '${ORG}', 'agent', now());

insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, metadata) values
  ('${S1_OLD}', '${ORG}', 'h4013-s1old', '\\x00', '{"ai_gate":"open","ai_gate_mode":"open"}'),
  ('${S1_NEW}', '${ORG}', 'h4013-s1new', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'),
  ('${S2_NEW}', '${ORG}', 'h4013-s2new', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'),
  ('${S3_OLD}', '${ORG}', 'h4013-s3old', '\\x00', '{"ai_gate":"open","ai_gate_mode":"open"}'),
  ('${S3_OWN}', '${ORG}', 'h4013-s3own', '\\x00', '{"ai_gate":"open","ai_gate_mode":"open"}'),
  ('${S4_NEW}', '${ORG}', 'h4013-s4new', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'),
  ('${S4_B}', '${ORG_B}', 'h4013-s4b', '\\x00', '{"ai_gate":"open","ai_gate_mode":"open"}'),
  ('${S5_A}', '${ORG}', 'h4013-s5a', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":["+5511900000501"]}'),
  ('${S5_B}', '${ORG}', 'h4013-s5b', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":["+5511900000502"]}'),
  ('${S5_NEW}', '${ORG}', 'h4013-s5new', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'),
  ('${S6_OLD}', '${ORG}', 'h4013-s6old', '\\x00', '{"ai_gate":"open","ai_gate_mode":"open"}'),
  ('${S6_NEW}', '${ORG}', 'h4013-s6new', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'),
  ('${S7_OLD}', '${ORG}', 'h4013-s7old', '\\x00', '{"ai_gate":"open","ai_gate_mode":"open"}'),
  ('${S7_NEW}', '${ORG}', 'h4013-s7new', '\\x00', '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}');

-- C4 e o contato da outra empresa têm o MESMO telefone: se a busca ignorasse a
-- organização, o agente da outra empresa apareceria aqui.
insert into public.contacts (id, organization_id, phone_number, display_name) values
  ('${C1}', '${ORG}', '+5511900000001', 'C1'),
  ('${C2}', '${ORG}', '+5511900000002', 'C2'),
  ('${C3}', '${ORG}', '+5511900000003', 'C3'),
  ('${C4}', '${ORG}', '+5511900000004', 'C4'),
  ('d4013000-0000-4000-8000-000000005014', '${ORG_B}', '+5511900000004', 'C4 da outra empresa'),
  ('${C5}', '${ORG}', '+5511900000005', 'C5'),
  ('${C6}', '${ORG}', '+5511900000006', 'C6'),
  ('${C7}', '${ORG}', '+5511900000007', 'C7');

insert into public.ai_agents (id, organization_id, name, system_prompt) values
  ('${AG_X1}', '${ORG}', 'Agente da conexao mais velha', 'x'),
  ('${AG_X}', '${ORG}', 'Agente da conexao antiga', 'x'),
  ('${AG_X2}', '${ORG}', 'Agente da conexao do meio', 'x'),
  ('${AG_OWN}', '${ORG}', 'Agente proprio da conexao nova', 'x'),
  ('${AG_ARCHIVED}', '${ORG}', 'Agente arquivado', 'x'),
  ('${AG_B}', '${ORG_B}', 'Agente da outra empresa', 'x'),
  ('${AG_X7}', '${ORG}', 'Agente da conversa encerrada', 'x');

insert into public.ai_agent_versions
  (id, organization_id, agent_id, version_number, system_prompt, provider, model, status, channel_session_id) values
  ('d4013000-0000-4000-8000-000000003001', '${ORG}', '${AG_X1}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S5_A}'),
  ('${V_X}', '${ORG}', '${AG_X}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S1_OLD}'),
  ('d4013000-0000-4000-8000-000000003003', '${ORG}', '${AG_X2}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S5_B}'),
  ('${V_OWN}', '${ORG}', '${AG_OWN}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S3_OWN}'),
  ('d4013000-0000-4000-8000-000000003005', '${ORG}', '${AG_ARCHIVED}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S6_OLD}'),
  ('d4013000-0000-4000-8000-000000003006', '${ORG_B}', '${AG_B}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S4_B}'),
  ('d4013000-0000-4000-8000-000000003007', '${ORG}', '${AG_X7}', 1, 'x', 'anthropic', 'claude-sonnet-4-6', 'published', '${S7_OLD}');

update public.ai_agents a set published_version_id = v.id
  from public.ai_agent_versions v
 where v.agent_id = a.id and v.organization_id = a.organization_id;

-- o agente que atende a conexao 6 esta ARQUIVADO: versao publicada, agente fora do ar
update public.ai_agents set archived_at = now() where id = '${AG_ARCHIVED}';

insert into public.channel_routing_policies
  (id, organization_id, channel_session_id, distribution_mode, default_assignee_user_id) values
  ('${POL1}', '${ORG}', '${S1_OLD}', 'round_robin', '${U1}'),
  ('${POL3}', '${ORG}', '${S3_OWN}', 'manual', null),
  ('d4013000-0000-4000-8000-000000006005', '${ORG}', '${S5_B}', 'load', null),
  ('d4013000-0000-4000-8000-000000006006', '${ORG}', '${S6_OLD}', 'round_robin', null),
  ('d4013000-0000-4000-8000-000000006007', '${ORG}', '${S7_OLD}', 'round_robin', null);

insert into public.channel_routing_responsibles (organization_id, policy_id, user_id) values
  ('${ORG}', '${POL1}', '${U1}'),
  ('${ORG}', '${POL1}', '${U2}'),
  ('${ORG}', '${POL3}', '${U2}'),
  ('${ORG}', 'd4013000-0000-4000-8000-000000006005', '${U2}'),
  ('${ORG}', 'd4013000-0000-4000-8000-000000006006', '${U2}'),
  ('${ORG}', 'd4013000-0000-4000-8000-000000006007', '${U2}');

-- as conversas anteriores: cada contato já falava por OUTRA conexão
insert into public.conversations
  (id, organization_id, contact_id, channel_session_id, status, updated_at) values
  ('d4013000-0000-4000-8000-000000007001', '${ORG}', '${C1}', '${S1_OLD}', 'open', now() - interval '2 hours'),
  ('d4013000-0000-4000-8000-000000007003', '${ORG}', '${C3}', '${S3_OLD}', 'open', now() - interval '2 hours'),
  ('d4013000-0000-4000-8000-000000007004', '${ORG_B}', 'd4013000-0000-4000-8000-000000005014', '${S4_B}', 'open', now() - interval '2 hours'),
  ('d4013000-0000-4000-8000-000000007051', '${ORG}', '${C5}', '${S5_A}', 'open', now() - interval '5 hours'),
  ('d4013000-0000-4000-8000-000000007052', '${ORG}', '${C5}', '${S5_B}', 'open', now() - interval '1 hour'),
  ('d4013000-0000-4000-8000-000000007006', '${ORG}', '${C6}', '${S6_OLD}', 'open', now() - interval '2 hours'),
  ('d4013000-0000-4000-8000-000000007007', '${ORG}', '${C7}', '${S7_OLD}', 'closed', now() - interval '2 hours');
`);
}

function upsert(org: string, contato: string, sessao: string): string {
  return um(`select public.fn_upsert_wa_conversation('${org}', '${contato}', '${sessao}');`);
}

beforeAll(async () => {
  seed();

  // ── RED literal, medido na conexão nova ANTES de qualquer conversa existir
  // nela: ninguém atende (portão fecha), o seletor não acha agente. É esse o
  // estado em que a conversa nascia e ficava.
  antesS1 = {
    conversas: Number(um(`select count(*) from public.conversations where channel_session_id = '${S1_NEW}';`)),
    portao: await haQuemAtendaASessao(pool, ORG, S1_NEW),
    agente: (await escolherAgenteDoNumero(pool, ORG, S1_NEW, C1)).config?.agentId ?? null,
  };

  // ── GREEN: a mensagem chega pela conexão nova, em cada cenário.
  conv1 = upsert(ORG, C1, S1_NEW);
  conv2 = upsert(ORG, C2, S2_NEW);
  conv3 = upsert(ORG, C3, S3_OWN);
  conv4 = upsert(ORG, C4, S4_NEW);
  conv5 = upsert(ORG, C5, S5_NEW);
  conv6 = upsert(ORG, C6, S6_NEW);
  conv7 = upsert(ORG, C7, S7_NEW);
});

afterAll(async () => {
  await pool.end();
});

describe("a conexão nova herda a configuração da conversa anterior (#4013)", () => {
  it("RED: antes da herança a conexão nova não tem ninguém que atenda", () => {
    expect(antesS1.conversas).toBe(0);
    expect(antesS1.portao).toBe(false);
    expect(antesS1.agente).toBeNull();
    // e a origem TEM agente publicado: o vazio é da conexão nova, não do produto
    expect(um(`select count(*) from public.ai_agent_versions where channel_session_id = '${S1_OLD}' and status = 'published';`)).toBe("1");
  });

  it("GREEN: o portão do dreno abre na conexão nova, com o agente da conversa anterior", async () => {
    expect(await haQuemAtendaASessao(pool, ORG, S1_NEW)).toBe(true);
    const escolha = await escolherAgenteDoNumero(pool, ORG, S1_NEW, C1);
    expect(escolha.config?.agentId).toBe(AG_X);
  });

  it("a conversa nova nasce com o agente publicado da conversa anterior", () => {
    expect(um(`select active_ai_agent_id from public.conversations where id = '${conv1}';`)).toBe(AG_X);
    // o vínculo versão↔número é o que o seletor e o portão leem; um só, aditivo
    expect(
      um(`select agent_version_id from public.ai_agent_version_channels where organization_id = '${ORG}' and channel_session_id = '${S1_NEW}';`),
    ).toBe(V_X);
    // a conexão antiga não perde o agente dela
    expect(um(`select count(*) from public.ai_agent_versions where channel_session_id = '${S1_OLD}' and status = 'published';`)).toBe("1");
  });

  it("a conversa nova nasce sem dono: herda configuração, não distribuição", () => {
    expect(
      um(`select coalesce(assigned_to_user_id::text, 'sem-dono') || '|' || status from public.conversations where id = '${conv1}';`),
    ).toBe("sem-dono|open");
    // nenhuma atribuição foi criada pela herança (nem evento, nem dono)
    expect(um(`select count(*) from public.conversation_assignment_events where conversation_id = '${conv1}';`)).toBe("0");
  });

  it("herda a regra de distribuição inteira: modo, destino padrão e responsáveis", () => {
    expect(
      um(`select distribution_mode || '|' || coalesce(default_assignee_user_id::text, '-') from public.channel_routing_policies where channel_session_id = '${S1_NEW}';`),
    ).toBe(`round_robin|${U1}`);
    expect(
      um(`select count(*) from public.channel_routing_responsibles r join public.channel_routing_policies p on p.id = r.policy_id where p.channel_session_id = '${S1_NEW}';`),
    ).toBe("2");
  });

  it("herda o pré-go-live: a conexão nova sai do estado de fábrica", () => {
    expect(um(`select metadata ->> 'ai_gate_mode' from public.channel_sessions where id = '${S1_NEW}';`)).toBe("open");
    expect(um(`select metadata ->> 'ai_gate' from public.channel_sessions where id = '${S1_NEW}';`)).toBe("open");
  });

  it("lado oposto (a): contato sem conversa anterior continua exatamente como hoje", () => {
    expect(um(`select coalesce(active_ai_agent_id::text, '-') from public.conversations where id = '${conv2}';`)).toBe("-");
    expect(um(`select count(*) from public.channel_routing_policies where channel_session_id = '${S2_NEW}';`)).toBe("0");
    expect(um(`select count(*) from public.ai_agent_version_channels where channel_session_id = '${S2_NEW}';`)).toBe("0");
    expect(um(`select metadata ->> 'ai_gate_mode' from public.channel_sessions where id = '${S2_NEW}';`)).toBe("pre_go_live");
    // e a função diz por quê, em vez de inventar fonte
    expect(
      um(`select public.fn_conexao_nova_herda_configuracao('${ORG}', '${conv2}')::text like '%sem_conversa_anterior_em_outra_conexao%';`),
    ).toBe("t");
  });

  it("lado oposto (b): conexão que já tem configuração própria não é sobrescrita", async () => {
    // a conversa não ganha agente de fora: quem atende é o agente DELA
    expect(um(`select coalesce(active_ai_agent_id::text, '-') from public.conversations where id = '${conv3}';`)).toBe("-");
    expect(um(`select id from public.channel_routing_policies where channel_session_id = '${S3_OWN}';`)).toBe(POL3);
    expect(um(`select distribution_mode from public.channel_routing_policies where channel_session_id = '${S3_OWN}';`)).toBe("manual");
    expect(um(`select count(*) from public.channel_routing_responsibles r join public.channel_routing_policies p on p.id = r.policy_id where p.channel_session_id = '${S3_OWN}';`)).toBe("1");
    expect(um(`select metadata ->> 'ai_gate_mode' from public.channel_sessions where id = '${S3_OWN}';`)).toBe("open");
    // nenhum vínculo além do dela
    expect(
      um(`select count(*) from public.ai_agent_version_channels where channel_session_id = '${S3_OWN}' and agent_version_id <> '${V_OWN}';`),
    ).toBe("0");
    // e a conexão continua funcionando pelo agente próprio
    expect(await haQuemAtendaASessao(pool, ORG, S3_OWN)).toBe(true);
    expect((await escolherAgenteDoNumero(pool, ORG, S3_OWN, C3)).config?.agentId).toBe(AG_OWN);
  });

  it("lado oposto (c): conversa de outra organização nunca é fonte (mesmo telefone)", () => {
    // na conexão nova, dentro da organização certa, não há fonte: nada é herdado
    expect(um(`select coalesce(active_ai_agent_id::text, '-') from public.conversations where id = '${conv4}';`)).toBe("-");
    expect(um(`select count(*) from public.ai_agent_version_channels where channel_session_id = '${S4_NEW}';`)).toBe("0");
    expect(um(`select count(*) from public.channel_routing_policies where channel_session_id = '${S4_NEW}';`)).toBe("0");
    expect(um(`select metadata ->> 'ai_gate_mode' from public.channel_sessions where id = '${S4_NEW}';`)).toBe("pre_go_live");
    // o agente da outra empresa segue onde estava, atendendo só a conexão dela
    expect(um(`select count(*) from public.ai_agent_version_channels where organization_id = '${ORG_B}' and channel_session_id = '${S4_B}';`)).toBe("0");
    expect(
      um(`select count(*) from public.ai_agent_versions where organization_id = '${ORG_B}' and channel_session_id = '${S4_B}' and status = 'published';`),
    ).toBe("1");
    expect(
      um(`select count(*) from public.conversations where organization_id = '${ORG}' and channel_session_id = '${S4_NEW}';`),
    ).toBe("1");
  });

  it("lado oposto (d): com três conexões a herança vem da mais recente, e rodar duas vezes não muda nada", async () => {
    expect(um(`select active_ai_agent_id from public.conversations where id = '${conv5}';`)).toBe(AG_X2);
    expect(um(`select distribution_mode from public.channel_routing_policies where channel_session_id = '${S5_NEW}';`)).toBe("load");
    // o pré-go-live da MAIS RECENTE (a lista de teste da S5_B, não a da S5_A)
    expect(
      um(`select metadata -> 'ai_test_phone_numbers' ->> 0 from public.channel_sessions where id = '${S5_NEW}';`),
    ).toBe("+5511900000502");

    const segunda = await pool.query<{ r: Record<string, unknown> }>(
      `select public.fn_conexao_nova_herda_configuracao($1, $2) as r`,
      [ORG, conv5],
    );
    expect(segunda.rows[0]?.r).toMatchObject({
      herdou_agente: false,
      herdou_politica: false,
      herdou_pre_go_live: false,
    });
    expect(
      um(`select active_ai_agent_id || '|' || (select count(*) from public.ai_agent_version_channels where channel_session_id = '${S5_NEW}') || '|' || (select count(*) from public.channel_routing_policies where channel_session_id = '${S5_NEW}') from public.conversations where id = '${conv5}';`),
    ).toBe(`${AG_X2}|1|1`);
    expect(um(`select metadata ->> 'ai_gate_mode' from public.channel_sessions where id = '${S5_NEW}';`)).toBe("pre_go_live");
  });

  it("lado oposto (e): agente arquivado não é herdado e não deixa a conversa quebrada", async () => {
    // nada aponta para o agente fora do ar...
    expect(um(`select coalesce(active_ai_agent_id::text, '-') from public.conversations where id = '${conv6}';`)).toBe("-");
    expect(um(`select count(*) from public.ai_agent_version_channels where channel_session_id = '${S6_NEW}';`)).toBe("0");
    // ...a conversa abre normalmente, sem agente (como hoje) e sem portão aberto
    expect(um(`select status from public.conversations where id = '${conv6}';`)).toBe("open");
    expect(await haQuemAtendaASessao(pool, ORG, S6_NEW)).toBe(false);
    expect((await escolherAgenteDoNumero(pool, ORG, S6_NEW, C6)).config).toBeNull();
    // o resto da configuração é herdado mesmo assim: só o agente não veio
    expect(um(`select distribution_mode from public.channel_routing_policies where channel_session_id = '${S6_NEW}';`)).toBe("round_robin");
    expect(um(`select metadata ->> 'ai_gate_mode' from public.channel_sessions where id = '${S6_NEW}';`)).toBe("open");
  });

  it("lado oposto (f): conversa anterior ENCERRADA ainda serve de fonte", () => {
    expect(um(`select status from public.conversations where id = 'd4013000-0000-4000-8000-000000007007';`)).toBe("closed");
    expect(um(`select active_ai_agent_id from public.conversations where id = '${conv7}';`)).toBe(AG_X7);
    expect(um(`select distribution_mode from public.channel_routing_policies where channel_session_id = '${S7_NEW}';`)).toBe("round_robin");
  });

  it("lado oposto (g): a herança não mexe em dono, fila nem histórico da conversa antiga", () => {
    // a conversa antiga segue aberta, com o dono que tinha e com a própria conexão
    expect(
      um(`select coalesce(assigned_to_user_id::text, '-') || '|' || status || '|' || channel_session_id from public.conversations where id = 'd4013000-0000-4000-8000-000000007001';`),
    ).toBe(`-|open|${S1_OLD}`);
    // nenhuma conversa foi fundida ou apagada: as duas existem, uma por conexão
    expect(um(`select count(*) from public.conversations where contact_id = '${C1}' and organization_id = '${ORG}';`)).toBe("2");
    expect(um(`select count(*) from public.conversations where contact_id = '${C5}' and organization_id = '${ORG}';`)).toBe("3");
    // e a configuração antiga continua na conexão antiga
    expect(um(`select id from public.channel_routing_policies where channel_session_id = '${S1_OLD}';`)).toBe(POL1);
  });

  it("só a conversa que NASCE herda: a existente não é reconfigurada pelo upsert", () => {
    // o dono limpou o agente da conversa nova; mensagem nova não devolve a herança
    sql(`update public.conversations set active_ai_agent_id = null where id = '${conv1}';`);
    expect(upsert(ORG, C1, S1_NEW)).toBe(conv1);
    expect(um(`select coalesce(active_ai_agent_id::text, '-') from public.conversations where id = '${conv1}';`)).toBe("-");
  });
});
