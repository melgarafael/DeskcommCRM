import { audit } from "@/lib/audit";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { loadChannelKnobs, loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";
import {
  decidePacing,
  janelaDeEnvioAberta,
  proximaAberturaDaJanela,
} from "@/lib/agent-engine/pacing/engine";
import { gerarAbordagemDeFormulario } from "@/lib/agent-engine/agent/abordagem-de-formulario";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { comSaida } from "./rodape-de-saida";
import {
  proximoEnvioDaEsteiraFria,
  tetoDiarioDaEsteiraFria,
} from "./ritmo-da-esteira-fria";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { decidirPreGoLiveDoCanalViaSupabase } from "@/lib/ai/elegibilidade/consulta-pre-go-live";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { assertProspectingDelivery } from "./guard";
import { campaignConfigSchema } from "./schema";
import { ProspectingError } from "./provider";
import {
  withProspectingLock,
  synchronizeSearch,
  validateConfig,
  type Campaign,
  type Candidate,
} from "./store";

export async function sendNextCandidate(
  pool: pg.Pool,
  db: pg.PoolClient,
  admin: SupabaseClient,
  c: Campaign,
) {
  const cfg = campaignConfigSchema.parse(c.config);
  await validateConfig(db, c.organization_id, cfg);
  if (new Date(c.next_send_at).getTime() > Date.now()) return;
  const { knobs, numberActivatedAt } = await loadChannelKnobs(
    db,
    c.organization_id,
    cfg.channel_session_id,
  );
  const now = new Date();
  const nextWindow = janelaDeEnvioAberta(now, knobs) ? null : proximaAberturaDaJanela(now, knobs);
  if (nextWindow) {
    await db.query(
      "update prospecting_campaigns set next_send_at=$3 where organization_id=$1 and id=$2",
      [c.organization_id, c.id, nextWindow],
    );
    return;
  }
  const pacingState = await loadPacingState(db, c.organization_id, cfg.channel_session_id, {
    now,
    timezone: knobs.timezone,
    numberActivatedAt,
  });
  const channel = (
    await db.query(
      "select daily_message_limit from channel_sessions where organization_id=$1 and id=$2",
      [c.organization_id, cfg.channel_session_id],
    )
  ).rows[0];
  if (!channel) throw new ProspectingError("Conexão de saída indisponível.");
  const pacing = decidePacing({
    now,
    knobs,
    state: pacingState,
    crmDailyLimit: channel.daily_message_limit,
  });
  if (!pacing.allow || pacing.waitMs > 0) {
    const next = pacing.allow ? new Date(now.getTime() + pacing.waitMs) : pacing.nextAllowedAt;
    await db.query(
      "update prospecting_campaigns set next_send_at=$3 where organization_id=$1 and id=$2",
      [c.organization_id, c.id, next],
    );
    return;
  }
  // Count attempts, including failures/unknown delivery: a timeout must not release quota.
  const { rows: counts } = await db.query<{
    campaign: number;
    total: number;
    retry_at: Date | null;
    last_attempt: Date | null;
  }>(
    "select count(*) filter(where campaign_id=$2)::int as campaign,count(*)::int as total,max(attempted_at) as last_attempt,min(attempted_at)+interval '24 hours' as retry_at from prospecting_candidates where organization_id=$1 and attempted_at>now()-interval '24 hours'",
    [c.organization_id, c.id],
  );
  const count = counts[0]!;
  // O TETO DO WARM-UP DESTA ESTEIRA. Os degraus da casa (20 no primeiro dia)
  // foram calibrados para a esteira de RESPOSTA, onde cada saída tem uma entrada
  // correspondente. Vinte PRIMEIRAS abordagens saindo de um número novo, todas
  // para quem nunca falou com a empresa, é o retrato do que a plataforma pune —
  // e quem perde o número é o cliente que instalou.
  const idadeEmDias = numberActivatedAt
    ? Math.floor((now.getTime() - new Date(numberActivatedAt).getTime()) / 86_400_000)
    : 0; // sem data registrada = degrau mais conservador, como o motor da casa faz
  const tetoFrio = tetoDiarioDaEsteiraFria(knobs, idadeEmDias);
  if (tetoFrio !== null && count.total >= tetoFrio) {
    await db.query(
      "update prospecting_campaigns set next_send_at=$3 where organization_id=$1 and id=$2",
      [c.organization_id, c.id, count.retry_at],
    );
    return;
  }
  if (count.campaign >= cfg.daily_limit || count.total >= 50) {
    await db.query(
      "update prospecting_campaigns set next_send_at=$3 where organization_id=$1 and id=$2",
      [c.organization_id, c.id, count.retry_at],
    );
    return;
  }
  if (count.last_attempt) {
    const next = new Date(new Date(count.last_attempt).getTime() + cfg.interval_minutes * 60000);
    if (next > now) {
      await db.query(
        "update prospecting_campaigns set next_send_at=$3 where organization_id=$1 and id=$2",
        [c.organization_id, c.id, next],
      );
      return;
    }
  }
  const p = (
    await db.query<Candidate>(
      "select * from prospecting_candidates where organization_id=$1 and campaign_id=$2 and status='queued' order by created_at,id limit 1",
      [c.organization_id, c.id],
    )
  ).rows[0];
  if (!p) {
    await db.query(
      "update prospecting_campaigns set status='completed',updated_at=now() where organization_id=$1 and id=$2 and status='running'",
      [c.organization_id, c.id],
    );
    return;
  }
  // O idioma da instalação decide a PALAVRA de saída. Uma consulta por envio, no
  // mesmo caminho que já faz várias — e o envio é limitado a 1 por vez pelo
  // ritmo anti-banimento, então não há volume aqui para otimizar.
  const locale =
    (
      await db.query<{ locale: string | null }>(
        "select locale from organizations where id=$1",
        [c.organization_id],
      )
    ).rows[0]?.locale ?? null;
  const preflight = await decidirPreGoLiveDoCanalViaSupabase(admin, {
    organizationId: c.organization_id,
    channelSessionId: cfg.channel_session_id,
    contactPhoneNumber: p.phone ?? "",
  });
  if (!preflight.permite)
    throw new ProspectingError(`O canal ainda não permite esta abordagem: ${preflight.motivo}.`);
  const boundary = parseServiceBoundary(p.service_boundary);
  if (!boundary || !p.contact_id || !p.conversation_id)
    // DO CANDIDATO: este não tem contato/conversa resolvidos. O próximo pode ter.
    throw new ProspectingError(
      "Destino da abordagem incompleto para este candidato.",
      422,
      "candidato",
    );
  await db.query("begin");
  try {
    await db.query(
      "update prospecting_candidates set status='sending',attempted_at=now(),updated_at=now() where organization_id=$1 and id=$2",
      [c.organization_id, p.id],
    );
    // O agendamento leva JITTER: o intervalo exato (`now + N minutos`, sempre o
    // mesmo número de milissegundos) é cadência de robô, que é justamente o que
    // a detecção de automação procura. A doutrina da casa manda throttle+jitter
    // em todo envio; aqui faltava. O jitter só ATRASA, nunca adianta, para não
    // furar o intervalo mínimo que o operador configurou.
    await db.query(
      "update prospecting_campaigns set next_send_at=$3 where organization_id=$1 and id=$2",
      [
        c.organization_id,
        c.id,
        proximoEnvioDaEsteiraFria(new Date(), cfg.interval_minutes, knobs),
      ],
    );
    // Reserve the shared channel budget before the external effect, including uncertain attempts.
    await recordSend(db, c.organization_id, cfg.channel_session_id, now);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  const guard = {
    organizationId: c.organization_id,
    candidateId: p.id,
    conversationId: p.conversation_id,
  };
  try {
    await assertProspectingDelivery(admin, guard);
    await assertServiceBoundarySupabase(admin, boundary);
    const agent = (
      await db.query(
        "select published_version_id,operation_revision from ai_agents where organization_id=$1 and id=$2 and operation_mode='automatic' and paused_at is null and archived_at is null",
        [c.organization_id, cfg.agent_id],
      )
    ).rows[0];
    if (!agent?.published_version_id)
      throw new ProspectingError("Agente pausado ou sem versão publicada.");
    const generated = await gerarAbordagemDeFormulario(pool, llmEdgeConfigFromEnv(env), {
      tenantId: c.organization_id,
      agentId: cfg.agent_id,
      leadId: p.contact_id,
      instrucao: `${cfg.instruction}\nFaça uma primeira abordagem curta e transparente. Os dados vieram de pesquisa pública, não de um formulário preenchido pela pessoa. Não invente familiaridade, resultados ou interesse. Uma pergunta por vez. Critérios a confirmar durante a conversa: ${cfg.qualification}`,
      origem: "Pesquisa de empresas",
      // NÃO é `automacao`: a pessoa não entrou em funil nenhum. O prompt do
      // ramo frio é o único que proíbe afirmar preenchimento — ver blocoDeModo.
      origemDaAbordagem: "prospeccao_fria",
      dados: {
        Empresa: p.data.name,
        Segmento: p.data.category ?? "",
        Endereço: p.data.address ?? "",
        Site: p.data.website ?? "",
        Avaliação: String(p.data.rating ?? ""),
        Redes: p.data.socials.join(", "),
      },
    });
    if (!generated.ok)
      // DO CANDIDATO: o modelo não produziu texto para ESTES dados.
      throw new ProspectingError(
        `A IA não produziu uma abordagem: ${generated.reason}.`,
        422,
        "candidato",
      );
    await assertProspectingDelivery(admin, guard);
    const authorization = await autorizarContatoParaIA(admin, {
      organizationId: c.organization_id,
      contactId: p.contact_id,
      reason: `campanha:${c.id}`,
    });
    if (!authorization.ok)
      throw new ProspectingError("Não foi possível preparar o atendimento da resposta.");
    const message = await sendMessageHandler(
      admin,
      {
        organization_id: c.organization_id,
        actor: { type: "ai_agent", id: p.id, agent_id: cfg.agent_id, role: "ai_operator" },
        requestId: `prospecting:${p.id}`,
        serviceBoundary: boundary,
        internalMessageId: p.message_id,
        proactiveContext: { organizationId: c.organization_id, contactId: p.contact_id },
        prospectingDelivery: guard,
        agentOperation: {
          organizationId: c.organization_id,
          agentId: cfg.agent_id,
          versionId: agent.published_version_id,
          revision: String(agent.operation_revision),
        },
      },
      {
        conversation_id: p.conversation_id,
        type: "text",
        // A SAÍDA vai junto da primeira mensagem, e é montada aqui — não pedida
        // ao modelo. Sem ela, a saída que a pessoa usa é "Denunciar spam", que
        // é invisível ao sistema e queima o número do CLIENTE que instalou.
        // O idioma sai de `organizations.locale`: um rodapé em português numa
        // instalação em espanhol oferece uma palavra que a pessoa não responde,
        // e o detector de opt-out só reconhece a palavra ISOLADA.
        body: comSaida(generated.texto, locale),
      },
    );
    const sent = ["sent", "delivered", "read"].includes(message.status);
    if (!sent) {
      // This lane never auto-retries an uncertain send. The Inbox keeps the evidence.
      await db.query(
        "update messages set status='failed' where organization_id=$1 and id=$2 and status in ('queued','sending')",
        [c.organization_id, p.message_id],
      );
    }
    await db.query(
      "update prospecting_candidates set status=$3,error=$4,updated_at=now() where organization_id=$1 and id=$2",
      [
        c.organization_id,
        p.id,
        sent ? "sent" : "failed",
        sent ? null : "Envio não confirmado. Consulte a conversa antes de reenviar.",
      ],
    );

    /*
     * A TRILHA DA ABORDAGEM FRIA — quem foi abordado, por qual campanha, quando.
     *
     * Esta é a única linha do produto que fala PRIMEIRO com alguém que nunca
     * falou com a empresa, e o titular pode perguntar "por que vocês me
     * escreveram?". Sem esta entrada, a resposta não existe em lugar nenhum:
     * `prospecting_candidates.status` guarda o ESTADO atual (e é reescrito no
     * próximo passo), não o fato de que a mensagem saiu naquele instante.
     *
     * Auditado quando houve EFEITO — a tentativa, bem ou malsucedida —, nunca
     * rodada de cron vazia: o tick sem candidato não passa por aqui, que é a
     * regra do CLAUDE.md ("rodada de cron que não fez nada NÃO é mutação").
     * `sent` entra no metadata em vez de virar duas ações: a pergunta que a
     * trilha responde é "houve abordagem para este contato", e a recusa do
     * transporte é parte dessa história, não outra.
     *
     * Sem PII: nem telefone, nem o texto gerado. Os ponteiros bastam para
     * chegar à conversa, e o texto vive nela.
     */
    void audit({
      action: "prospecting.approach_sent",
      organizationId: c.organization_id,
      bypassedRls: true,
      resourceType: "prospecting_candidate",
      resourceId: p.id,
      metadata: {
        campaign_id: c.id,
        contact_id: p.contact_id,
        conversation_id: p.conversation_id,
        agent_id: cfg.agent_id,
        channel_session_id: cfg.channel_session_id,
        sent,
      },
      requestId: `prospecting:${p.id}`,
    });
  } catch (error) {
    await db.query(
      "update prospecting_candidates set status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2",
      [
        c.organization_id,
        p.id,
        error instanceof ProspectingError
          ? error.message
          : "A abordagem foi interrompida. Verifique o agente, a conexão e o histórico.",
      ],
    );
    throw error;
  }
}

export async function tickProspecting(pool: pg.Pool, admin: SupabaseClient) {
  const { rows: organizations } = await pool.query<{ organization_id: string }>(
    "select organization_id from prospecting_campaigns where status='running' or search_status in ('starting','running') group by organization_id order by min(updated_at) limit 20",
  );
  const deadline = Date.now() + 180000;
  let processed = 0;
  for (const { organization_id: org } of organizations) {
    if (Date.now() >= deadline) break;
    try {
      await withProspectingLock(pool, org, async (db) => {
        await db.query(
          "update prospecting_campaigns set search_status='unknown',error='Busca sem confirmação. Consulte o histórico no provedor antes de repetir.',updated_at=now() where organization_id=$1 and search_status='starting' and created_at<now()-interval '2 minutes'",
          [org],
        );
        await db.query(
          "update prospecting_candidates set status='failed',error='Execução interrompida; envio não será repetido automaticamente.',updated_at=now() where organization_id=$1 and status='sending' and attempted_at<now()-interval '10 minutes'",
          [org],
        );
        const searches = (
          await db.query<Campaign>(
            "select * from prospecting_campaigns where organization_id=$1 and search_status='running' order by created_at limit 2",
            [org],
          )
        ).rows;
        for (const c of searches) {
          try {
            await synchronizeSearch(db, admin, c);
          } catch (error) {
            await db.query(
              "update prospecting_campaigns set error=$3,updated_at=now() where organization_id=$1 and id=$2",
              [
                org,
                c.id,
                error instanceof ProspectingError
                  ? error.message
                  : "Falha ao consultar os resultados. A próxima rodada tentará novamente.",
              ],
            );
          }
        }
        const c = (
          await db.query<Campaign>(
            "select * from prospecting_campaigns where organization_id=$1 and status='running'",
            [org],
          )
        ).rows[0];
        if (c) {
          try {
            await sendNextCandidate(pool, db, admin, c);
          } catch (error) {
            // DE QUEM É A FALHA decide se a fila para.
            //
            // Antes, QUALQUER exceção pausava a campanha inteira: um número
            // inválido numa lista de mil, um contato que virou bloqueado entre a
            // busca e o envio, uma instabilidade de um segundo no provedor — e a
            // lista só voltava se alguém abrisse a tela e retomasse à mão. É o
            // oposto do que a casa faz em todo lugar: item ruim marca o ITEM.
            const doCandidato =
              error instanceof ProspectingError && error.escopo === "candidato";
            const motivo =
              error instanceof ProspectingError
                ? error.message
                : "Falha inesperada no envio. Confira o histórico antes de retomar.";

            if (doCandidato) {
              // Marca o candidato e SEGUE: a próxima rodada pega o próximo.
              // `attempted_at` já foi gravado antes do envio, então ele não
              // volta para a fila sozinho.
              await db.query(
                "update prospecting_candidates set status='failed',error=$3,updated_at=now() where organization_id=$1 and campaign_id=$2 and status='sending'",
                [org, c.id, motivo],
              );
              logger.warn("[prospecting] candidato falhou; a campanha segue", {
                organization_id: org,
                campaign_id: c.id,
                error: motivo,
              });
            } else {
              // Vale para todos: pausar é o certo, e o erro fica na campanha
              // para a tela explicar a quem for retomar.
              await db.query(
                "update prospecting_campaigns set status='paused',error=$3,updated_at=now() where organization_id=$1 and id=$2",
                [org, c.id, motivo],
              );
            }
          }
        }
        await db.query(
          "update prospecting_campaigns set updated_at=now() where organization_id=$1 and (status='running' or search_status='running')",
          [org],
        );
        processed++;
      });
    } catch (error) {
      if (!(error instanceof ProspectingError && error.status === 409))
        logger.error("[prospecting] rodada falhou", {
          organization_id: org,
          // Era a constante "prospecting_tick_failed". O erro estava capturado
          // na variável e descartado na hora de escrever: o log existia e não
          // dizia nada além de "falhou" — o que é quase pior que não logar,
          // porque parece cobertura. Agora vai a causa.
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }
  return { processed };
}
