import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import { ProspectingError } from "@/lib/prospecting/provider";
import { campaignConfigSchema, prospectingInputSchema, type Prospect } from "@/lib/prospecting/schema";
import { auditarSite } from "@/lib/prospecting/site-fetch";
import {
  instrucaoDeAbordagemFria,
  montarDadosDeAbordagem,
  montarEstrategia,
  pontuarCandidato,
  type OfertaDaCampanha,
} from "@/lib/prospecting/estrategia-site";
import { blocoVozVendedor, lerPersonalizacao, personalizacaoDaOrganizacao } from "@/lib/prospecting/personalizar";
import { gerarAbordagemDeFormulario } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { env } from "@/lib/env";
import {
  activateCampaign,
  adjustPace,
  configureCredential,
  createSearch,
  descartarDesmarcadas,
  selecionarNaFila,
  validateConfig,
  withProspectingLock,
  type Campaign,
} from "@/lib/prospecting/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "no-store" };
const ACOES_ABERTAS_AO_TOKEN = new Set<string>(["configure", "search", "pause"]);
/**
 * Espelho SQL de `pontuarCandidato` (oferta `site` + automação via
 * `c.config->'ofertas'->>0`). Ordenação com paginação; o TS exibe badge+motivo.
 */
const ORDENACAO_POR_SCORE = `(least(greatest(coalesce((p.data->>'rating')::float, 0) - 4.0, 0), 1) * 40
  + least(coalesce((p.data->>'reviews')::int, 0), case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 150 else 100 end)
    * case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 0.4 else 0.3 end
  + case coalesce(p.data->'site'->>'classe', '')
      when 'sem-site' then case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 20 else 30 end
      when 'agregador' then case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 20 else 30 end
      when 'site-ruim' then case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 14 else 22 end
      when 'fora-do-ar' then case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 16 else 25 end
      when 'ssl-invalido' then case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 16 else 25 end
      when 'site-ok' then case when coalesce(c.config->'ofertas'->>0, 'site') like '%automacao%' then 14 else 10 end
      else 0 end) desc, p.created_at desc`;
function failure(error: unknown, requestId: string) {
  return fail(
    "prospecting_unavailable",
    error instanceof ProspectingError
      ? error.message
      : "Não foi possível concluir a operação. Verifique a configuração e tente novamente.",
    error instanceof ProspectingError ? error.status : 500,
    { requestId, headers },
  );
}
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:read",
  });
  if (!auth.ok) return auth.response;
  const ordenar = req.nextUrl.searchParams.get("ordenar");
  if (ordenar !== null && ordenar !== "score")
    return fail("validation_failed", "Ordenação inválida: use 'score' ou omita.", 422, {
      requestId,
      headers,
    });
  try {
    const db = getRequestPool();
    const org = auth.organizationId;
    const ordemCandidatos =
      ordenar === "score" ? ORDENACAO_POR_SCORE : "p.created_at desc";
    const [settings, campaigns, candidates, agents, channels, stages, organizacao] = await Promise.all([
      db.query("select organization_id from prospecting_settings where organization_id=$1", [org]),
      db.query(
        "select id,name,search,config,status,search_status,run_id,cost_usd,result_count,skipped_count,error,next_send_at,created_at from prospecting_campaigns where organization_id=$1 order by created_at desc limit 50",
        [org],
      ),
      db.query(
        `select p.id,p.campaign_id,p.data,p.status,p.selected,p.error,p.lead_id,p.conversation_id,p.attempted_at,m.status as message_status,case when l.stage_id::text=c.config->>'qualified_stage_id' then 'qualified' when v.last_inbound_at is not null then 'replied' else p.status end as progress from prospecting_candidates p join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id left join crm_leads l on l.organization_id=p.organization_id and l.id=p.lead_id left join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id left join messages m on m.organization_id=p.organization_id and m.id=p.message_id where p.organization_id=$1 order by ${ordemCandidatos} limit 5000`,
        [org],
      ),
      db.query(
        "select id,name from ai_agents where organization_id=$1 and published_version_id is not null and archived_at is null and paused_at is null and operation_mode='automatic' order by name",
        [org],
      ),
      db.query(
        "select id,display_name,phone_number,provider,status from channel_sessions where organization_id=$1 and archived_at is null order by created_at",
        [org],
      ),
      db.query(
        "select s.id,s.name,s.pipeline_id,p.name as pipeline_name from crm_stages s join crm_pipelines p on p.id=s.pipeline_id and p.organization_id=s.organization_id where s.organization_id=$1 and not s.is_archived and not s.is_won and not s.is_lost order by p.name,s.position",
        [org],
      ),
      db.query("select settings from organizations where id=$1", [org]),
    ]);
    const personalizacao = lerPersonalizacao(
      (organizacao.rows[0] as { settings?: unknown } | undefined)?.settings,
    );
    return ok(
      {
        configured: !!settings.rows.length,
        campaigns: campaigns.rows,
        candidates: candidates.rows,
        personalizacao,
        agents: agents.rows,
        channels: channels.rows.filter((c) => {
          try {
            return capabilitiesOf(c.provider as ChannelProvider).freeformOutsideWindow;
          } catch {
            return false;
          }
        }),
        stages: stages.rows,
      },
      { requestId, headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(req: NextRequest) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await resolveAuthDual(req, {
    requestId,
    resource: "prospecting",
    role: "admin",
    scope: "mcp:write",
  });
  if (!auth.ok) return auth.response;
  const teto = await tetoDeEscritaDoToken(auth, "prospecting", requestId);
  if (teto) return teto;

  const parsed = prospectingInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail(
      "validation_failed",
      "Confira os campos: público, região, limites e configuração da campanha.",
      422,
      { requestId, headers },
    );
  const body = parsed.data;
  // Lista de PERMISSÃO, não de negação: iniciar e retomar campanha ENVIAM
  // mensagem a quem nunca falou com a empresa, e a #1875 pede o envio sob
  // controle humano. Ação nova da prospecção nasce fechada ao token até alguém
  // decidir abri-la aqui.
  if (auth.via === "token" && !ACOES_ABERTAS_AO_TOKEN.has(body.action))
    return fail(
      "forbidden",
      "Por token, a prospecção só configura, pesquisa e pausa. Iniciar ou retomar campanha exige a tela: o envio fica sob controle de uma pessoa.",
      403,
      { requestId, headers },
    );
  const org = auth.organizationId;
  try {
    const pool = getRequestPool();
    const admin = createAdminClient();
    let result: unknown;
    let auditMetadata: Record<string, unknown> = { operation: body.action };
    if (body.action === "configure") {
      await configureCredential(pool, admin, org, body.api_key);
      result = { configured: true };
    } else if (body.action === "search")
      result = await createSearch(pool, admin, org, body.request_id, body.search);
    else if (body.action === "start")
      result = await activateCampaign(pool, admin, org, body.id, body.config);
    else if (body.action === "pause") {
      // Pause does not wait for the worker lock; the delivery guard sees it before sending.
      const changed = await pool.query(
        "update prospecting_campaigns set status='paused',updated_at=now() where organization_id=$1 and id=$2 and status='running' returning id",
        [org, body.id],
      );
      if (!changed.rows.length)
        throw new ProspectingError("Campanha em execução não encontrada.", 404);
      result = { paused: true };
    } else if (body.action === "adjust_pace") {
      const { previous, next } = await adjustPace(pool, org, body.id, {
        daily_limit: body.daily_limit,
        interval_minutes: body.interval_minutes,
      });
      result = next;
      // O histórico precisa dizer DE QUANTO PARA QUANTO — só o nome da ação não diz.
      auditMetadata = { operation: body.action, previous, next };
    } else if (body.action === "select") {
      result = await withProspectingLock(pool, org, async (db) => {
        const campaign = (
          await db.query(
            "select id from prospecting_campaigns where organization_id=$1 and id=$2 and status='draft'",
            [org, body.id],
          )
        ).rows[0];
        if (!campaign)
          throw new ProspectingError("A campanha não está em preparação para selecionar empresas.", 409);
        const { rows } = await db.query<{ id: string }>(
          "update prospecting_candidates set selected=$3,updated_at=now() where organization_id=$1 and campaign_id=$2 and status='new' and id=any($4::uuid[]) returning id",
          [org, body.id, body.selected, body.candidate_ids],
        );
        return { selected: body.selected, candidates_id: rows.map((r) => r.id) };
      });
    } else if (body.action === "select_in_queue") {
      const fila = await selecionarNaFila(pool, org, body.id, body.candidate_ids, body.selected);
      result = fila;
      // Quantas empresas de fato mudaram (o servidor ignora as que não podiam mudar).
      auditMetadata = {
        operation: body.action,
        selected: body.selected,
        changed: fila.changed_ids.length,
      };
    } else if (body.action === "discard_unselected") {
      const descarte = await descartarDesmarcadas(pool, org, body.id);
      result = descarte;
      // O histórico precisa dizer QUANTAS linhas saíram: apagar é o único gesto desta rota
      // que não tem volta, e "alguém excluiu" sem número não deixa conferir nada depois.
      auditMetadata = { operation: body.action, discarded: descarte.discarded };
    } else if (body.action === "reanalisar_site") {
      const reanalise = await withProspectingLock(pool, org, async (db) => {
        const alvos = (
          await db.query<{ id: string; website: string | null }>(
            "select id, data->>'website' as website from prospecting_candidates where organization_id=$1 and campaign_id=$2 and id=any($3::uuid[])",
            [org, body.id, body.candidate_ids],
          )
        ).rows;
        const agoraIso = new Date().toISOString();
        const classes: Record<string, number> = {};
        let reenriquecidos = 0;
        for (const alvo of alvos) {
          if (!alvo.website || alvo.website.trim() === "") continue;
          try {
            const veredito = await auditarSite(alvo.website, agoraIso);
            const atualizado = await db.query(
              "update prospecting_candidates set data = data || jsonb_build_object('site', $4::jsonb), updated_at = now() where organization_id=$1 and campaign_id=$2 and id=$3",
              [org, body.id, alvo.id, JSON.stringify(veredito)],
            );
            if ((atualizado.rowCount ?? 0) > 0) {
              reenriquecidos++;
              classes[veredito.classe] = (classes[veredito.classe] ?? 0) + 1;
            }
          } catch {
            continue;
          }
        }
        return { reenriquecidos, classes };
      });
      result = reanalise;
      auditMetadata = {
        operation: body.action,
        reenriquecidos: reanalise.reenriquecidos,
        classes: reanalise.classes,
      };
    } else if (body.action === "prever_abordagem") {
      // Somente leitura: gera a copy sem enviar e sem auditar (sem mutação).
      const linhas = await pool.query(
        "select pc.id, pc.data, pc.status, pc.contact_id, pc.campaign_id, c.config, c.search from prospecting_candidates pc join prospecting_campaigns c on c.organization_id=pc.organization_id and c.id=pc.campaign_id where pc.organization_id=$1 and pc.campaign_id=$2 and pc.id=$3",
        [org, body.id, body.candidate_id],
      );
      const linha = linhas.rows[0] as
        | {
            id: string;
            data: Prospect;
            status: string;
            contact_id: string | null;
            config: unknown;
            search: { niche?: string };
          }
        | undefined;
      if (!linha) throw new ProspectingError("Candidato não encontrado.", 404);
      if (!linha.data.site)
        throw new ProspectingError(
          "Auditoria pendente para este candidato. Aguarde o tick ou use Reanalisar site.",
          409,
        );
      if (!linha.config)
        throw new ProspectingError("Configure o agente da campanha para pré-visualizar.", 422);
      const cfg = campaignConfigSchema.parse(linha.config);
      if (!cfg.agent_id)
        throw new ProspectingError("Configure o agente da campanha para pré-visualizar.", 422);
      const ofertas = (cfg.ofertas ?? ["site"]) as OfertaDaCampanha[];
      // Mesmos fios do envio (voz + vocabulário da org): a prévia só vale se
      // for byte a byte o que o tick mandaria.
      const personalizacao = await personalizacaoDaOrganizacao(pool, org);
      const gerado = await gerarAbordagemDeFormulario(pool, llmEdgeConfigFromEnv(env), {
        tenantId: org,
        agentId: cfg.agent_id,
        leadId: linha.contact_id ?? linha.id,
        instrucao: instrucaoDeAbordagemFria(
          cfg.instruction,
          cfg.qualification,
          blocoVozVendedor(personalizacao) || undefined,
        ),
        origem: "Pesquisa de empresas",
        origemDaAbordagem: "prospeccao_fria",
        dados: montarDadosDeAbordagem(linha.data, linha.data.site),
      });
      if (!gerado.ok)
        throw new ProspectingError(`A IA não produziu uma abordagem: ${gerado.reason}.`, 422);
      const estrategia = montarEstrategia({
        classe: linha.data.site.classe,
        problemas: linha.data.site.problemas,
        checklist: linha.data.site.checklist,
        nota: linha.data.rating,
        numAvaliacoes: linha.data.reviews,
        temInstagram: /instagram/i.test((linha.data.socials ?? []).join(",")),
        ofertas,
        nicho: linha.search?.niche ?? linha.data.category ?? "",
        sobrescritaVocabulario: personalizacao.vocabulario ?? null,
        status: linha.status,
        followUpsEnviados: 0,
      });
      result = {
        mensagem: gerado.texto,
        estrategia,
        score: pontuarCandidato(linha.data.rating, linha.data.reviews, linha.data.site.classe, ofertas[0] ?? "site"),
      };
    } else {
      result = await withProspectingLock(pool, org, async (db) => {
        const c = (
          await db.query<Campaign>(
            "select * from prospecting_campaigns where organization_id=$1 and id=$2 and status='paused'",
            [org, body.id],
          )
        ).rows[0];
        if (!c?.config) throw new ProspectingError("Campanha pausada não encontrada.", 404);
        await validateConfig(db, org, c.config);
        if (
          (
            await db.query(
              "select id from prospecting_campaigns where organization_id=$1 and status='running'",
              [org],
            )
          ).rows.length
        )
          throw new ProspectingError("Pause a outra campanha antes de retomar.", 409);
        await db.query(
          "update prospecting_campaigns set status='running',error=null,next_send_at=greatest(next_send_at,now()+interval '1 minute'),updated_at=now() where organization_id=$1 and id=$2",
          [org, body.id],
        );
        return { resumed: true };
      });
    }
    const resourceId = "id" in body ? body.id : null;
    // Prévia é somente leitura: sem mutação, sem audit (a regra do cron vazio
    // vale para rota de leitura; o custo aparece em `llm_calls`).
    if (body.action === "prever_abordagem") return ok(result, { requestId, headers });
    await audit({
      action: "prospecting.changed",
      organizationId: org,
      actorUserId: auth.actor.type === "user" ? auth.actor.id : null,
      actorApiTokenId: auth.apiTokenId ?? null,
      resourceType: "prospecting",
      resourceId,
      metadata: auditMetadata,
      requestId,
    });
    return ok(result, { requestId, headers });
  } catch (error) {
    return failure(error, requestId);
  }
}
