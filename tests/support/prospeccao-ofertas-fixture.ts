import { randomUUID } from "node:crypto";
import type pg from "pg";

import { campaignConfigSchema, type OfertaDaCampanha, type Prospect } from "../../lib/prospecting/schema";

export const TEXTO_DO_PAR = "Hoje só tenho Linktree. Consulte a análise da minha empresa e me explique o que vocês oferecem.";
export const TRES_OFERTAS: OfertaDaCampanha[] = ["site", "automacao_crm", "automacao_n8n"];
export const COMPLEMENTO_TRES = "Além do site, o atendimento automatizado responde quem chama fora de hora e as automações tiram o trabalho repetido, sem trocar ninguém da equipe.";
export const COMPLEMENTO_SEM_SITE = "O atendimento automatizado responde quem chama fora de hora e as automações tiram o trabalho repetido, sem trocar ninguém da equipe.";

/**
 * Recursos exclusivos desta prova; não muda o agente/canal padrão do seed.
 *
 * A credencial também é da prova, fixada na versão. Sem ela o resolvedor pega a
 * `anthropic` validada mais recente da org — e a org do seed é dividida com a
 * suíte: as specs j20-elegibilidade-* deixam lá uma com bytes de enfeite, e o
 * turno morria no CI com "Invalid authentication tag length: 1" (run
 * 42422904244), enquanto a spec sozinha passava. Aqui ela nasce com enfeite
 * também; quem roda o turno (`tests/e2e/helpers/ofertas-no-turno.ts`) a cifra
 * com a chave da suíte antes do turno.
 */
export async function criarFixtureDeOfertas(
  pool: pg.Pool,
  org: string,
  ofertas: OfertaDaCampanha[] = TRES_OFERTAS,
) {
  const ids = {
    org, agent: randomUUID(), version: randomUUID(), channel: randomUUID(),
    contact: randomUUID(), pipeline: randomUUID(), stage: randomUUID(),
    qualifiedStage: randomUUID(), campaign: randomUUID(), candidate: randomUUID(), historicalMessage: randomUUID(),
    credential: randomUUID(),
  };
  const nome = `Ofertas QA ${ids.campaign.slice(0, 8)}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: pessoas } = await client.query<{ user_id: string }>(
      "select user_id from user_organizations where organization_id=$1 and role='admin' and accepted_at is not null order by user_id limit 1",
      [org],
    );
    const criador = pessoas[0]?.user_id ?? null;
    await client.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,display_name,status,webhook_secret_encrypted) values($1,$2,$3,'Canal da prova de ofertas','WORKING',decode('00','hex'))",
      [ids.channel, org, `ofertas-qa-${ids.channel}`],
    );
    await client.query(
      "insert into channel_knobs(organization_id,channel_session_id,window_start_hour,window_end_hour,resposta_start_hour,resposta_end_hour,timezone,allow_sunday,throttle_ms,jitter_max_ms) values($1,$2,0,24,0,24,'UTC',true,0,0)",
      [org, ids.channel],
    );
    await client.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,$3,$4)", [ids.pipeline, org, nome, `ofertas-${ids.pipeline.slice(0, 8)}`]);
    for (const [id, slug, posicao] of [[ids.stage, "novo", 10], [ids.qualifiedStage, "qualificado", 20]] as const) {
      await client.query(
        "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,$4,$4,$5)",
        [id, org, ids.pipeline, slug, posicao],
      );
    }
    await client.query(
      "insert into ai_agents(id,organization_id,name,kind,system_prompt,operation_mode,created_by) values($1,$2,$3,'mcp_agent','Responda usando as informações confirmadas da conversa.','automatic',$4)",
      [ids.agent, org, nome, criador],
    );
    await client.query(
      `insert into ai_provider_credentials(id,organization_id,provider,label,api_key_encrypted,api_key_iv,api_key_tag,api_key_last4,validated_at)
       values($1,$2,'anthropic',$3,decode('00','hex'),decode('00','hex'),decode('00','hex'),'qa00',now())`,
      [ids.credential, org, nome],
    );
    await client.query(
      `insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,tool_ids,pipeline_ids,created_by,credential_id)
       values($1,$2,$3,1,'Responda usando as informações confirmadas da conversa.','anthropic','test-model',$4,'published',$5,$6,$7,$8)`,
      [ids.version, org, ids.agent, ids.channel, ["crm_get_prospecting_site_audit"], [ids.pipeline], criador, ids.credential],
    );
    await client.query("update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3", [ids.version, org, ids.agent]);
    const telefone = `+55119${String(parseInt(ids.contact.slice(0, 8), 16)).padStart(8, "0").slice(-8)}`;
    await client.query(
      "insert into contacts(id,organization_id,name,display_name,phone_number) values($1,$2,$3,$3,$4)",
      [ids.contact, org, nome, telefone],
    );
    const { rows } = await client.query<{ boundary: { conversation_id: string } }>(
      "select fn_service_begin($1,$2,$3) as boundary", [org, ids.contact, ids.channel],
    );
    const conversation = rows[0]?.boundary.conversation_id;
    if (!conversation) throw new Error("A fixture não abriu sua conversa própria.");
    await client.query(
      `update conversations set channel_session_id=$3,active_ai_agent_id=$4,assignee_kind='ai',
         assigned_to_user_id=null,bot_silenced_until=null where organization_id=$1 and id=$2`,
      [org, conversation, ids.channel, ids.agent],
    );
    const config = campaignConfigSchema.parse({
      agent_id: ids.agent, channel_session_id: ids.channel, pipeline_id: ids.pipeline,
      stage_id: ids.stage, qualified_stage_id: ids.qualifiedStage,
      instruction: "Converse com empresas que responderam à campanha.",
      qualification: "Confirmar como a empresa atende os pedidos de seus clientes.",
      legal_basis_ref: "fixture-sintetica-de-qa", ofertas,
    });
    await client.query(
      `insert into prospecting_campaigns(id,organization_id,request_id,name,search,config,status,search_status)
       values($1,$2,$3,$4,$5::jsonb,$6::jsonb,'paused','succeeded')`,
      [ids.campaign, org, randomUUID(), nome, JSON.stringify({ niche: "Clínicas", location: "Sorocaba, SP" }), JSON.stringify(config)],
    );
    // Representa abordagem anterior; não executa primeira abordagem nem transporte.
    await client.query(
      `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,created_at)
       values($1,$2,$3,$4,$5,'text','outbound','sent','Olá. Este é o histórico sintético da prova. Se não quiser mensagens, diga SAIR.','automation',now()-interval '1 minute',now()-interval '1 minute')`,
      [ids.historicalMessage, org, conversation, ids.channel, ids.contact],
    );
    const dados: Prospect = {
      key: ids.candidate, name: nome, phone: telefone,
      website: "https://links.example.test/prova", category: "Clínicas",
      address: "Rua QA, 1", maps_url: null, rating: null, reviews: 0, socials: [], emails: [],
      site: {
        ver: 1, classe: "agregador", problemas: [], checklist: { tem: [], falta: [] },
        final_url: "https://links.example.test/prova", http_status: 200, tempo_ms: 10,
        conteudo_resumo: null, pagespeed: null, verificado_em: new Date().toISOString(),
        provisorio: false, tentativas: 0,
      },
    };
    await client.query(
      `insert into prospecting_candidates(id,organization_id,campaign_id,place_id,data,status,contact_id,conversation_id,message_id,automatic_sends,exit_offered_at,exit_offer_message_id)
       values($1,$2,$3,$8,$4::jsonb,'sent',$5,$6,$7,1,now()-interval '1 minute',$7)`,
      [ids.candidate, org, ids.campaign, JSON.stringify(dados), ids.contact, conversation, ids.historicalMessage, ids.candidate],
    );
    await client.query("COMMIT");
    return { ...ids, conversation, nome };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type FixtureDeOfertas = Awaited<ReturnType<typeof criarFixtureDeOfertas>>;

export async function mudarOfertas(pool: pg.Pool, f: FixtureDeOfertas, ofertas: OfertaDaCampanha[]) {
  const result = await pool.query(
    "update prospecting_campaigns set config=jsonb_set(config,'{ofertas}',$3::jsonb) where organization_id=$1 and id=$2",
    [f.org, f.campaign, JSON.stringify(ofertas)],
  );
  if (result.rowCount !== 1) throw new Error("A fixture perdeu sua campanha ao mudar as ofertas.");
}

/** O chamador conserva a org/usuário do seed; só UUIDs desta fixture saem. */
export async function limparFixtureDeOfertas(pool: pg.Pool, f: FixtureDeOfertas) {
  const fim = Date.now() + 10_000;
  const client = await pool.connect();
  try {
    const executar = async (text: string, values: string[]) => {
      const restante = fim - Date.now();
      if (restante <= 0) throw new Error("A limpeza própria de ofertas excedeu o prazo.");
      await client.query("select set_config('statement_timeout',$1,false)", [String(Math.min(restante, 5000))]);
      await client.query(text, values);
    };
    await executar("delete from job_queue where organization_id=$1 and payload->>'conversation_id'=$2", [f.org, f.conversation]);
    await executar("delete from ai_agent_runs where organization_id=$1 and agent_id=$2", [f.org, f.agent]);
    await executar("delete from prospecting_candidates where organization_id=$1 and campaign_id=$2", [f.org, f.campaign]);
    await executar("delete from prospecting_campaigns where organization_id=$1 and id=$2", [f.org, f.campaign]);
    await executar("delete from conversations where organization_id=$1 and id=$2", [f.org, f.conversation]);
    await executar("delete from contacts where organization_id=$1 and id=$2", [f.org, f.contact]);
    await executar("update ai_agents set published_version_id=null where organization_id=$1 and id=$2", [f.org, f.agent]);
    await executar("delete from ai_agents where organization_id=$1 and id=$2", [f.org, f.agent]);
    await executar("delete from ai_provider_credentials where organization_id=$1 and id=$2", [f.org, f.credential]);
    await executar("delete from channel_sessions where organization_id=$1 and id=$2", [f.org, f.channel]);
    await executar("delete from crm_pipelines where organization_id=$1 and id=$2", [f.org, f.pipeline]);
  } finally {
    // A conexão exclusiva sai com seu timeout; não o deixa no pool compartilhado.
    client.release(true);
  }
}
