import type pg from "pg";
import { ZodError } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { loadActiveRouter } from "@/lib/agent-engine/agent/router-config";
import { loadPublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { createLeadSchema } from "@/lib/schemas/leads";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import {
  campaignConfigSchema,
  normalizeProspect,
  RAZAO_NAO_SELECIONADA,
  razaoDeAbordarSelecionado,
  type CampaignConfig,
  type CampaignPace,
  type SearchInput,
  type Prospect,
} from "./schema";
import { ProspectingError } from "./provider";
import {
  provedorDaOrganizacao,
  validarCredencialDaOrganizacao,
} from "./provedor";

export interface Campaign {
  id: string;
  organization_id: string;
  name: string;
  search: SearchInput;
  config: CampaignConfig | null;
  status: string;
  search_status: string;
  run_id: string | null;
  dataset_id: string | null;
  next_send_at: Date;
  created_at: Date;
  error: string | null;
}
export interface Candidate {
  id: string;
  organization_id: string;
  campaign_id: string;
  data: Prospect;
  status: string;
  selected: boolean;
  phone: string | null;
  contact_id: string | null;
  lead_id: string | null;
  conversation_id: string | null;
  service_boundary: unknown;
  message_id: string;
}
/** Session-scoped PostgreSQL lock shared by commands and worker; no process-local lock. */
export async function withProspectingLock<T>(
  pool: pg.Pool,
  org: string,
  fn: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  let locked = false;
  try {
    locked =
      (
        await db.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,0)) as locked",
          [`prospecting:${org}`],
        )
      ).rows[0]?.locked === true;
    if (!locked)
      throw new ProspectingError(
        "Uma operação está em andamento. Tente novamente em alguns segundos.",
        409,
      );
    return await fn(db);
  } finally {
    try {
      if (locked)
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [`prospecting:${org}`]);
    } finally {
      db.release();
    }
  }
}
export async function credential(db: pg.Pool | pg.PoolClient, admin: SupabaseClient, org: string) {
  const { rows } = await db.query<{ credential_encrypted: Buffer }>(
    "select credential_encrypted from prospecting_settings where organization_id=$1",
    [org],
  );
  const encrypted = rows[0]?.credential_encrypted;
  if (!encrypted)
    throw new ProspectingError("Configure a chave de busca antes de extrair empresas.");
  const key = await decryptWebhookSecret(admin, encrypted.toString("hex"));
  if (!key)
    throw new ProspectingError(
      "Não foi possível abrir a chave de busca. Salve a configuração novamente.",
    );
  return key;
}
export async function configureCredential(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  key: string,
) {
  // A régua é a DO PROVEDOR ESCOLHIDO (#1758). Sem escolha nenhuma, `apify`
  // responde com a MESMA validação de sempre — `users/me`, mesma URL, mesmo
  // erro — então quem não pediu nada não muda de comportamento.
  await validarCredencialDaOrganizacao(pool, org, key);
  const encrypted = await encryptWebhookSecret(admin, key);
  if (!encrypted)
    throw new ProspectingError("A cifra de credenciais da instalação não está disponível.");
  await pool.query(
    "insert into prospecting_settings(organization_id,credential_encrypted) values ($1,$2::bytea) on conflict(organization_id) do update set credential_encrypted=excluded.credential_encrypted,updated_at=now()",
    [org, encrypted],
  );
}
export async function createSearch(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  requestId: string,
  search: SearchInput,
) {
  return withProspectingLock(pool, org, async (db) => {
    const prior = await db.query<Campaign>(
      "select * from prospecting_campaigns where organization_id=$1 and request_id=$2",
      [org, requestId],
    );
    if (prior.rows[0]) return prior.rows[0];
    const key = await credential(db, admin, org);
    // O provedor é ESCOLHA desta organização (#1758) e resolve-se ANTES de
    // qualquer escrita: escolha desconhecida falha fechado sem deixar campanha
    // órfã no banco. As outras organizações resolvem as suas próprias — a
    // escolha de uma não vaza para a outra.
    const provedor = await provedorDaOrganizacao(db, org);
    const { rows } = await db.query<Campaign>(
      "insert into prospecting_campaigns(organization_id,request_id,name,search) values($1,$2,$3,$4) returning *",
      [org, requestId, search.name, search],
    );
    const campaign = rows[0]!;
    try {
      const run = await provedor.startSearch(key, search);
      await db.query(
        "update prospecting_campaigns set run_id=$3,dataset_id=$4,search_status='running',updated_at=now() where organization_id=$1 and id=$2",
        [org, campaign.id, run.id, run.defaultDatasetId ?? null],
      );
    } catch (error) {
      await db.query(
        "update prospecting_campaigns set search_status='unknown',error=$3,updated_at=now() where organization_id=$1 and id=$2",
        [
          org,
          campaign.id,
          error instanceof ProspectingError
            ? error.message
            : "Não foi possível confirmar a busca. Confira as execuções no provedor antes de repetir.",
        ],
      );
    }
    return (
      await db.query<Campaign>(
        "select * from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, campaign.id],
      )
    ).rows[0]!;
  });
}
export async function synchronizeSearch(db: pg.PoolClient, admin: SupabaseClient, c: Campaign) {
  if (!c.run_id) return;
  const key = await credential(db, admin, c.organization_id);
  // A escolha ATUAL desta organização (#1758), relida a cada tick — e não
  // necessariamente o provedor que lançou esta execução: nada aqui guarda quem
  // lançou. Trocar de provedor com uma busca em andamento faz o novo ler um id
  // que não é dele. Rotear pelo provedor que lançou fica para a fatia que
  // trouxer um provedor real (#2174).
  const provedor = await provedorDaOrganizacao(db, c.organization_id);
  const run = await provedor.readSearch(key, c.run_id);
  if (["FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    await db.query(
      "update prospecting_campaigns set search_status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2",
      [c.organization_id, c.id, `A busca terminou com estado ${run.status}.`],
    );
    return;
  }
  if (run.status !== "SUCCEEDED") return;
  const dataset = run.defaultDatasetId ?? c.dataset_id;
  if (!dataset) throw new ProspectingError("Busca concluída sem resultado disponível.");
  const items = await provedor.readResults(key, dataset, c.search.limit);
  let inserted = 0;
  await db.query("begin");
  try {
    for (const item of items) {
      const p = normalizeProspect(item);
      if (!p) continue;
      const result = await db.query(
        "insert into prospecting_candidates(organization_id,campaign_id,place_id,phone,data) values($1,$2,$3,$4,$5) on conflict do nothing",
        [c.organization_id, c.id, p.key, p.phone, p],
      );
      inserted += result.rowCount ?? 0;
    }
    await db.query(
      "update prospecting_campaigns set search_status='succeeded',dataset_id=$3,cost_usd=$4,result_count=$5,skipped_count=$6,error=null,updated_at=now() where organization_id=$1 and id=$2",
      [
        c.organization_id,
        c.id,
        dataset,
        run.usageTotalUsd ?? null,
        inserted,
        items.length - inserted,
      ],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
export async function validateConfig(db: pg.PoolClient, org: string, input: CampaignConfig) {
  const config = campaignConfigSchema.parse(input);
  const agent = (
    await db.query(
      "select v.tool_ids,v.pipeline_ids from ai_agents a join ai_agent_versions v on v.id=a.published_version_id and v.organization_id=a.organization_id where a.organization_id=$1 and a.id=$2 and v.status='published' and a.archived_at is null and a.paused_at is null and a.operation_mode='automatic'",
      [org, config.agent_id],
    )
  ).rows[0];
  if (!agent) throw new ProspectingError("Escolha um agente publicado e em operação automática.");
  if (
    !agent.tool_ids?.includes("crm_move_lead_stage") ||
    !agent.pipeline_ids?.includes(config.pipeline_id)
  )
    throw new ProspectingError(
      "Publique o agente com a ferramenta de mover negócios e acesso ao funil escolhido.",
    );
  const channel = (
    await db.query<{ provider: ChannelProvider; status: string }>(
      "select provider,status from channel_sessions where organization_id=$1 and id=$2 and archived_at is null",
      [org, config.channel_session_id],
    )
  ).rows[0];
  if (
    !channel ||
    channel.status !== "WORKING" ||
    !capabilitiesOf(channel.provider).freeformOutsideWindow
  )
    throw new ProspectingError(
      "Escolha uma conexão ativa que permita iniciar conversas de texto. Canais que exigem modelo aprovado ainda não participam desta campanha.",
    );
  const router = await loadActiveRouter(db as unknown as pg.Pool, org, config.channel_session_id);
  if (router) {
    if (!router.sticky || !router.members.some((m) => m.agentId === config.agent_id))
      throw new ProspectingError(
        "Inclua o agente no roteador deste canal e ative a continuidade do agente antes de iniciar.",
      );
  } else {
    const bound = await loadPublishedAgentConfig(
      db as unknown as pg.Pool,
      org,
      config.channel_session_id,
    );
    if (bound?.agentId !== config.agent_id)
      throw new ProspectingError(
        "Publique o agente no canal escolhido para que ele também atenda às respostas.",
      );
  }
  const stages = (
    await db.query<{ id: string }>(
      "select id from crm_stages where organization_id=$1 and pipeline_id=$2 and id=any($3::uuid[]) and not is_archived and not is_won and not is_lost",
      [org, config.pipeline_id, [config.stage_id, config.qualified_stage_id]],
    )
  ).rows;
  if (config.stage_id === config.qualified_stage_id || stages.length !== 2)
    throw new ProspectingError(
      "Escolha duas etapas abertas e diferentes do mesmo funil: entrada e qualificados.",
    );
  return config;
}
/**
 * TRIAGEM DE UMA EMPRESA: ela merece virar contato? Decide só olhando; não escreve nada.
 *
 * Mora fora de `activateCampaign` porque agora há DOIS momentos em que a pergunta é
 * feita: ao iniciar (sempre — a contagem da fila precisa ser honesta desde o primeiro
 * minuto) e, no modo `on_send`, de novo na hora do envio, porque entre uma coisa e
 * outra o telefone pode ter virado contato do CRM por outro caminho. Atendimento que
 * já existe nunca é atropelado por prospecção.
 *
 * `contatoDaCampanha` é o contato que ESTA campanha já criou numa execução
 * interrompida (mesma origem, mesma campanha, mesmo lugar) — reaproveitado em vez de
 * duplicado, que é o que torna a preparação idempotente.
 */
export async function triarCandidato(
  db: pg.PoolClient,
  org: string,
  campaignId: string,
  p: Candidate,
): Promise<{ motivo: string } | { contatoDaCampanha: string | null }> {
  if (!p.phone) return { motivo: "Sem telefone brasileiro válido." };
  const known = await db.query(
    "select id from contacts where organization_id=$1 and phone_number=any($2::text[])",
    [org, phoneLookupVariants(p.phone)],
  );
  let contactId = p.contact_id;
  if (known.rows.length && !contactId) {
    const owned = await db.query(
      "select id from contacts where organization_id=$1 and id=$2 and source='prospecting' and source_metadata->>'campaign_id'=$3 and source_metadata->>'place_id'=$4",
      [org, known.rows[0].id, campaignId, p.data.key],
    );
    if (owned.rows[0]) contactId = owned.rows[0].id;
  }
  if (known.rows.length && !contactId)
    return { motivo: "Contato já existe no CRM; atendimento preservado." };
  return { contatoDaCampanha: contactId };
}

/**
 * A PEGADA DE UMA EMPRESA NO CRM: contato, negócio no funil e conversa.
 *
 * Era o corpo do laço de `activateCampaign`, que criava isso para TODA a fila no
 * instante de "Iniciar". Foi separada para o modo `on_send` poder criar a pegada de
 * uma empresa só quando chega a vez dela de ser abordada. Medido numa campanha real:
 * 47 empresas esperando, todas na etapa de entrada do funil há dois dias sem uma
 * mensagem enviada — o funil dizia "Abordado" de quem ninguém tinha abordado.
 *
 * Idempotente por construção (contato da campanha reaproveitado, negócio procurado
 * por `external_id`): uma execução que caiu no meio recomeça sem duplicar nada.
 * Devolve a linha do candidato já `queued`, com contato, negócio, conversa e fronteira.
 */
export async function criarPegadaDoCandidato(
  db: pg.PoolClient,
  admin: SupabaseClient,
  org: string,
  c: Pick<Campaign, "id" | "name">,
  config: CampaignConfig,
  p: Candidate,
  contatoDaCampanha: string | null,
): Promise<Candidate> {
  // A triagem já recusou quem não tem telefone; esta guarda só diz isso ao compilador,
  // que não enxerga a triagem daqui (no laço original o `continue` já estreitava o tipo).
  if (!p.phone) throw new ProspectingError("Sem telefone brasileiro válido.", 422, "candidato");
  const ctx = {
    organization_id: org,
    actor: { type: "webhook_source" as const, id: c.id },
    requestId: `rule:${c.id}`,
  };
  // O negócio é VALIDADO antes de qualquer escrita: `normalizeProspect` aceita um nome de
  // uma letra, e o negócio exige duas. Sem isto o contato nascia, o negócio recusava, e a
  // empresa ficava com um contato sem negócio nem conversa.
  const negocioBase = createLeadSchema.parse({
    pipeline_id: config.pipeline_id,
    stage_id: config.stage_id,
    title: p.data.name,
    owner_agent_id: config.agent_id,
    source: "prospecting",
    description: `Campanha: ${c.name}\nQualificação: ${config.qualification}`.slice(0, 2000),
  });
  let contactId = contatoDaCampanha ?? p.contact_id;
  if (!contactId) {
    const contact = await createContactHandler(admin, ctx, {
      name: p.data.name,
      display_name: p.data.name,
      phone_number: p.phone,
      source: "prospecting",
      source_metadata: { campaign_id: c.id, place_id: p.data.key, maps_url: p.data.maps_url },
      consent: { legitimate_interest: { ref: config.legal_basis_ref } },
    });
    contactId = String(contact.contact.id);
    await db.query(
      "update prospecting_candidates set contact_id=$3 where organization_id=$1 and id=$2",
      [org, p.id, contactId],
    );
  }
  let leadId = p.lead_id;
  if (!leadId) {
    const existing = await db.query(
      "select id from crm_leads where organization_id=$1 and source='prospecting' and external_id=$2",
      [org, p.id],
    );
    leadId = existing.rows[0]?.id ?? null;
  }
  if (!leadId) {
    const lead = await createLeadHandler(admin, ctx, {
      ...negocioBase,
      contact_id: contactId,
      external_id: p.id,
    });
    leadId = String(lead.id);
    await db.query(
      "update prospecting_candidates set lead_id=$3 where organization_id=$1 and id=$2",
      [org, p.id, leadId],
    );
  }
  await db.query(
    "update prospecting_candidates set contact_id=$3,lead_id=$4 where organization_id=$1 and id=$2",
    [org, p.id, contactId, leadId],
  );
  const boundary = await beginServiceAtOrigin(admin, org, contactId, config.channel_session_id);
  await db.query(
    "update conversations set active_ai_agent_id=$3,metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('prospecting_campaign_id',$4::text) where organization_id=$1 and id=$2",
    [org, boundary.conversation_id, config.agent_id, c.id],
  );
  const { rows } = await db.query<Candidate>(
    "update prospecting_candidates set status='queued',conversation_id=$3,service_boundary=$4,error=null,updated_at=now() where organization_id=$1 and id=$2 returning *",
    [org, p.id, boundary.conversation_id, boundary],
  );
  return rows[0] as Candidate;
}

/**
 * Modo `on_send`: prepara a empresa NA HORA de abordá-la. Devolve a linha pronta, ou
 * `null` quando ela saiu da fila (pulada ou falhada) e o envio deve passar à próxima.
 *
 * O erro de uma empresa é DELA: uma recusa 4xx dos cadastros (telefone que o CRM não
 * aceita, por exemplo) marca só essa empresa como `failed`, com o motivo. Sem isso o
 * candidato continuaria `queued` e travaria a fila rodada após rodada — e o `catch` do
 * envio só sabe marcar quem já está `sending`. Falha de infraestrutura (banco, rede)
 * continua subindo: ela pausa a campanha com o motivo, como sempre pausou.
 */
export async function prepararCandidatoNoEnvio(
  db: pg.PoolClient,
  admin: SupabaseClient,
  c: Pick<Campaign, "id" | "name" | "organization_id">,
  config: CampaignConfig,
  p: Candidate,
): Promise<Candidate | null> {
  const org = c.organization_id;
  const triagem = await triarCandidato(db, org, c.id, p);
  if ("motivo" in triagem) {
    await db.query(
      "update prospecting_candidates set status='skipped',error=$3,updated_at=now() where organization_id=$1 and id=$2 and status='queued'",
      [org, p.id, triagem.motivo],
    );
    return null;
  }
  try {
    return await criarPegadaDoCandidato(db, admin, org, c, config, p, triagem.contatoDaCampanha);
  } catch (error) {
    if (error instanceof ZodError) {
      // Dados da empresa que o cadastro não aceita (nome curto demais, por exemplo). A
      // validação roda ANTES de qualquer escrita, então não sobra contato órfão.
      await db.query(
        "update prospecting_candidates set status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2 and status='queued'",
        [
          org,
          p.id,
          "Os dados desta empresa não passam na validação do cadastro (por exemplo, nome curto demais).",
        ],
      );
      return null;
    }
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status !== "number" || status < 400 || status >= 500) throw error;
    const detalhe = error instanceof Error ? error.message.slice(0, 300) : "";
    await db.query(
      "update prospecting_candidates set status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2 and status='queued'",
      [org, p.id, `Não foi possível colocar esta empresa no funil.${detalhe ? ` ${detalhe}` : ""}`],
    );
    return null;
  }
}
/**
 * Põe na fila as empresas que sobraram da busca, no instante de iniciar.
 *
 * Primeiro a escolha do operador (desmarcada nunca entra), depois a triagem (sem
 * telefone, ou já é contato do CRM). O que acontece com quem passa depende de
 * `config.funnel_entry`: `on_start` cria contato, negócio e conversa AGORA, para a fila
 * inteira; `on_send` só enfileira, e cada empresa nasce no CRM na vez dela de ser
 * abordada (`prepararCandidatoNoEnvio`).
 */
export async function enfileirarCandidatos(
  db: pg.PoolClient,
  admin: SupabaseClient,
  org: string,
  c: Pick<Campaign, "id" | "name">,
  config: CampaignConfig,
  candidates: Candidate[],
) {
  const id = c.id;
  for (const p of candidates) {
    const selectionReason = razaoDeAbordarSelecionado(p.selected);
    if (selectionReason) {
      await db.query(
        "update prospecting_candidates set status='skipped',error=$3 where organization_id=$1 and id=$2",
        [org, p.id, selectionReason],
      );
      continue;
    }
    const triagem = await triarCandidato(db, org, id, p);
    if ("motivo" in triagem) {
      await db.query(
        "update prospecting_candidates set status='skipped',error=$3 where organization_id=$1 and id=$2",
        [org, p.id, triagem.motivo],
      );
      continue;
    }
    if (config.funnel_entry === "on_send") {
      // O contato, o negócio e a conversa NASCEM NO ENVIO (`prepararCandidatoNoEnvio`):
      // aqui a empresa só entra na fila. O funil mostra quem foi abordado, e desmarcar
      // uma empresa que ainda não foi abordada não deixa nada para desfazer.
      await db.query(
        "update prospecting_candidates set status='queued',error=null,updated_at=now() where organization_id=$1 and id=$2",
        [org, p.id],
      );
      continue;
    }
    await criarPegadaDoCandidato(db, admin, org, c, config, p, triagem.contatoDaCampanha);
  }
}
export async function activateCampaign(
  pool: pg.Pool,
  admin: SupabaseClient,
  org: string,
  id: string,
  input: CampaignConfig,
) {
  return withProspectingLock(pool, org, async (db) => {
    const config = await validateConfig(db, org, input);
    const c = (
      await db.query<Campaign>(
        "select * from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, id],
      )
    ).rows[0];
    if (!c) throw new ProspectingError("Campanha não encontrada.", 404);
    if (c.status !== "draft" || c.search_status !== "succeeded")
      throw new ProspectingError(
        "Aguarde a busca terminar; uma campanha já iniciada deve ser retomada.",
        409,
      );
    if (
      (
        await db.query(
          "select id from prospecting_campaigns where organization_id=$1 and status='running'",
          [org],
        )
      ).rows.length
    )
      throw new ProspectingError("Pause a campanha atual antes de iniciar outra.", 409);
    if (c.config && JSON.stringify(campaignConfigSchema.parse(c.config)) !== JSON.stringify(config))
      throw new ProspectingError(
        "A preparação já começou. Retome com a mesma configuração da campanha.",
        409,
      );
    await db.query(
      "update prospecting_campaigns set config=$3 where organization_id=$1 and id=$2",
      [org, id, config],
    );
    // Activation is the authorized origin. In `on_start` the service boundary of every company
    // is captured here; in `on_send` each company's is captured when its turn comes
    // (`prepararCandidatoNoEnvio`), still under this campaign's own authority.
    const candidates = (
      await db.query<Candidate>(
        "select * from prospecting_candidates where organization_id=$1 and campaign_id=$2 and status='new' order by created_at,id",
        [org, id],
      )
    ).rows;
    await enfileirarCandidatos(db, admin, org, c, config, candidates);
    await db.query(
      "update prospecting_campaigns set config=$3,status='running',next_send_at=now()+interval '1 minute',error=null,updated_at=now() where organization_id=$1 and id=$2",
      [org, id, config],
    );
    return { started: true };
  });
}

/**
 * DESMARCAR UMA EMPRESA QUE JÁ ESTÁ NA FILA: ela vira "Não abordado", com o motivo do
 * operador, e o envio (que só pega `queued`) nunca mais a alcança.
 *
 * Só `queued`: `sending`, `sent` e `failed` já tiveram tentativa e não voltam atrás por
 * um clique. Em `on_send` a empresa ainda nem existe no CRM, então não há nada a desfazer;
 * em `on_start` o contato e o negócio já foram criados ao iniciar e FICAM onde estão — o
 * produto não tem como ocultar nem apagar negócio, e inventar isso aqui seria escrever
 * código irreversível por conta do botão de uma tela.
 */
export const FILA_DESMARCAR_SQL =
  "update prospecting_candidates set selected=false,status='skipped',error=$4,updated_at=now() where organization_id=$1 and campaign_id=$2 and id=any($3::uuid[]) and status='queued' returning id";

/**
 * MARCAR DE NOVO: só devolve à fila quem o OPERADOR tirou (`selected=false`, `skipped` e o
 * motivo exato dele). "Sem telefone brasileiro válido" e "Contato já existe no CRM" são
 * `skipped` por outra razão e NÃO voltam por aqui — marcar a caixa não pode ressuscitar
 * quem o produto recusou de propósito.
 *
 * `$5` é "a campanha cria a empresa só no envio": nesse modo qualquer desmarcada pode voltar
 * (será preparada na vez dela); no modo antigo só volta quem JÁ tem conversa criada, porque
 * a empresa desmarcada antes de iniciar nunca ganhou contato nem negócio, e criá-los num
 * clique de "marcar" seria refazer a ativação por baixo da tela.
 */
export const FILA_REMARCAR_SQL =
  "update prospecting_candidates set selected=true,status='queued',error=null,updated_at=now() where organization_id=$1 and campaign_id=$2 and id=any($3::uuid[]) and status='skipped' and selected=false and error=$4 and ($5::boolean or conversation_id is not null) returning id";

export async function selecionarNaFila(
  pool: pg.Pool,
  org: string,
  campaignId: string,
  candidateIds: string[],
  selected: boolean,
) {
  return withProspectingLock(pool, org, async (db) => {
    const c = (
      await db.query<{ status: string; config: Record<string, unknown> | null }>(
        "select status, config from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, campaignId],
      )
    ).rows[0];
    if (!c) throw new ProspectingError("Campanha não encontrada.", 404);
    // Pausada: o envio só roda em `running`, então ninguém está no meio de uma abordagem.
    if (c.status !== "paused" || !c.config)
      throw new ProspectingError("Pause a campanha antes de mudar quem está na fila.", 409);
    const soNoEnvio = c.config.funnel_entry === "on_send";
    const { rows } = selected
      ? await db.query<{ id: string }>(FILA_REMARCAR_SQL, [
          org,
          campaignId,
          candidateIds,
          RAZAO_NAO_SELECIONADA,
          soNoEnvio,
        ])
      : await db.query<{ id: string }>(FILA_DESMARCAR_SQL, [
          org,
          campaignId,
          candidateIds,
          RAZAO_NAO_SELECIONADA,
        ]);
    return { selected, changed_ids: rows.map((r) => r.id) };
  });
}

/**
 * EXCLUIR AS DESMARCADAS: apaga a LINHA DA BUSCA de quem o operador tirou, para a lista não
 * crescer com quem ele nunca vai abordar.
 *
 * Três guardas, todas no `where`:
 * - sem contato, negócio nem conversa: o que já virou registro do CRM não é daqui;
 * - `suppression_salt is null`: a linha de quem exerceu opt-out ou exclusão é a TOMBA que o
 *   gatilho `prospecting_refuse_erased` consulta para barrar a reimportação — apagá-la
 *   reabriria a porta que a anonimização fechou;
 * - só o que o operador marcou: `new` desmarcada (rascunho) ou `skipped` com o motivo dele.
 *
 * O telefone dessas linhas é o que impede a mesma empresa de reaparecer como "nova" numa
 * busca futura (índice único por organização + `on conflict do nothing`). Excluir é decidir
 * que ela PODE voltar — por isso a tela pede confirmação e diz isso.
 */
export const DESCARTAR_DESMARCADAS_SQL =
  "delete from prospecting_candidates where organization_id=$1 and campaign_id=$2 and selected=false and (status='new' or (status='skipped' and error=$3)) and contact_id is null and lead_id is null and conversation_id is null and suppression_salt is null returning id";

export async function descartarDesmarcadas(pool: pg.Pool, org: string, campaignId: string) {
  return withProspectingLock(pool, org, async (db) => {
    const c = (
      await db.query<{ status: string }>(
        "select status from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, campaignId],
      )
    ).rows[0];
    if (!c) throw new ProspectingError("Campanha não encontrada.", 404);
    if (c.status !== "draft" && c.status !== "paused")
      throw new ProspectingError("Pause a campanha antes de excluir as desmarcadas.", 409);
    const { rows } = await db.query<{ id: string }>(DESCARTAR_DESMARCADAS_SQL, [
      org,
      campaignId,
      RAZAO_NAO_SELECIONADA,
    ]);
    return { discarded: rows.length };
  });
}

/**
 * O ajuste do ritmo é UM `update`, e as três guardas moram na própria cláusula
 * `where`, não só no `if` que vem antes dela:
 *
 * - `organization_id = $1`: a organização vem da sessão, nunca do corpo;
 * - `status = 'paused'`: com a campanha rodando, o envio pode estar no meio de uma
 *   abordagem, e trocar o intervalo ali seria trocar a régua no meio da medida;
 * - `config is not null`: `null || jsonb` é `null`, e o merge apagaria a
 *   configuração inteira de uma campanha que ainda não foi iniciada.
 *
 * `||` entre jsonb troca só as duas chaves e preserva as demais — conexão, agente,
 * funil, base legal e instrução não são tocados, por construção e não por cuidado.
 *
 * `next_send_at = least(next_send_at, now())` existe porque a hora do próximo envio
 * foi gravada com o ritmo ANTIGO — ou com o fim da janela de 24 horas, quando o
 * limite do dia estourou — e o envio sai cedo enquanto ela está no futuro. Sem isto,
 * baixar o intervalo (ou subir o limite) só valeria depois de esperar o ritmo velho,
 * que é o contrário do que a tela promete. Antecipar é seguro: janela, ritmo do
 * canal, teto da esteira fria, limite do dia e intervalo desde o último envio são
 * RECALCULADOS a cada rodada do envio, e quem não puder enviar só reagenda.
 * Aumentar o intervalo também vale na hora, porque o envio compara com o último envio.
 */
export const AJUSTE_DE_RITMO_SQL =
  "update prospecting_campaigns set config = config || jsonb_build_object('daily_limit', $3::int, 'interval_minutes', $4::int), next_send_at = least(next_send_at, now()), updated_at = now() where organization_id = $1 and id = $2 and status = 'paused' and config is not null returning id";

/**
 * Troca o limite por dia e o intervalo de uma campanha PAUSADA.
 *
 * O envio lê `campaignConfigSchema.parse(c.config)` a cada rodada, então o valor
 * novo vale já na próxima rodada depois de "Retomar", que revalida a configuração
 * gravada.
 * Devolve também o ritmo ANTERIOR, para a auditoria dizer "de quanto para quanto":
 * lido cru, sem `parse`, para que uma campanha cuja configuração antiga já não
 * passa no schema atual ainda possa ser consertada por aqui.
 */
export async function adjustPace(pool: pg.Pool, org: string, id: string, pace: CampaignPace) {
  return withProspectingLock(pool, org, async (db) => {
    const c = (
      await db.query<{ status: string; config: Record<string, unknown> | null }>(
        "select status, config from prospecting_campaigns where organization_id=$1 and id=$2",
        [org, id],
      )
    ).rows[0];
    if (!c) throw new ProspectingError("Campanha não encontrada.", 404);
    if (c.status !== "paused" || !c.config)
      throw new ProspectingError("Pause a campanha antes de ajustar o ritmo.", 409);
    const changed = await db.query(AJUSTE_DE_RITMO_SQL, [
      org,
      id,
      pace.daily_limit,
      pace.interval_minutes,
    ]);
    // Alguém retomou entre o select e o update: o `where` recusou, e é isso que vale.
    if (!changed.rows.length)
      throw new ProspectingError("Pause a campanha antes de ajustar o ritmo.", 409);
    return {
      previous: {
        daily_limit: c.config.daily_limit ?? null,
        interval_minutes: c.config.interval_minutes ?? null,
      },
      next: { daily_limit: pace.daily_limit, interval_minutes: pace.interval_minutes },
    };
  });
}
