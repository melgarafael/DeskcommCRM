import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
/**
 * Handoff orchestrator — central point que executa a transição bot→humano
 * para os 4 gatilhos OR-lógicos (G1/G2/G3/G4) do EPIC-06.
 *
 * Efeitos colaterais (atomic-ish; falhas não-críticas são logadas e ignoradas):
 *   1. UPDATE conversations
 *        SET status='pending',
 *            bot_silenced_until='infinity',
 *            last_handoff_at=now(),
 *            last_handoff_reason=<reason>,
 *            active_ai_agent_id=null, active_intent=null, active_agent_set_at=null
 *      (idempotente: se outro handoff aconteceu nos últimos 5s com mesma reason,
 *       skip — tratamento de race G2 vs G3 vs G4 simultâneos.)
 *   2. INSERT em crm_lead_activities (timeline) se houver lead_id
 *   2.5. Move o lead para a etapa `crm_stages.slug='chamar-humano'` do
 *        pipeline dele, se o tenant tiver criado essa etapa (opt-in — ver
 *        `lib/leads/handoff-stage-move.ts`). Pipeline sem essa etapa: no-op.
 *   3. emit_event('ai.handoff_triggered') no event_log
 *   4. Realtime broadcast no channel 'org:<org>:queue' (event 'handoff_pending')
 *   5. api_audit_log action='ai.handoff_triggered'
 *   5.5. passagens_de_atendimento INSERT — a linha de fato da passagem, montada
 *        pela MESMA função pura do outro motor (lib/escalacao/briefing-da-passagem)
 *   6. agent_inbox_items kind='handoff', ref_kind='conversation' — insere ou
 *      ACRESCENTA no item aberto (a segunda passagem não é mais descartada)
 *
 * IMPORTANTE: nunca propaga exceção pro caller. O worker chamador segue feliz.
 *
 * Service-role bypassa RLS — filtro `organization_id` programático em toda query.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";

import { avisarLeadDoCrm, type DesfechoDoAvisoDoCrm } from "./aviso-ao-lead";
import {
  checkpointDoBanco,
  montarBriefingDaPassagem,
  type CheckpointParaBriefing,
} from "@/lib/escalacao/briefing-da-passagem";
import {
  corpoCurtoDoAviso,
  registrarPassagem,
  type DesfechoDoAvisoDaPassagem,
  type MotivoDaPassagem,
  type OrigemDaPassagem,
} from "@/lib/escalacao/passagem";
import { CHAVES_DO_CLIMA, type MotorDoClima } from "@/lib/ai/decisao/metadados-do-clima";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";

export type HandoffReason =
  | "requested_human"
  | "low_sentiment"
  | "low_confidence"
  | "critical_stage"
  | "legal_mention"
  | "refund_mention"
  /**
   * O teto de gasto com IA parou o atendimento automático. NÃO é pedido do lead —
   * quem lê `last_handoff_reason` precisa distinguir, porque a primeira frase que
   * o humano digita depende disso.
   *
   * O literal vem de `HANDOFF_REASON_ORCAMENTO` (`lib/agent-engine/edge/llm/orcamento.ts`),
   * a MESMA constante que o engine grava: dois caminhos param a IA pelo mesmo
   * motivo, e duas grafias fariam quem filtra por uma achar metade das conversas.
   */
  | "orcamento_de_ia";

export interface TriggerHandoffInput {
  serviceBoundary?: ServiceBoundary;
  conversationId: string;
  organizationId: string;
  reason: HandoffReason;
  /**
   * POR ONDE a passagem entrou. **Obrigatória**, e é escolha: são seis
   * chamadores, todos nossos, e sem ela a linha de `passagens_de_atendimento`
   * nasceria dizendo "motor B" e nada mais — o que não responde "que parte do
   * sistema decidiu isto?" quando alguém duvida do número.
   */
  origem: OrigemDaPassagem;
  /**
   * O que quem acionou DECLAROU — só a ferramenta (nativa ou MCP) tem isto.
   *
   * Não é o briefing inteiro de propósito: o contexto acumulado (checkpoint
   * durável + o que o cliente disse e ainda não foi respondido) este motor lê
   * sozinho, para TODOS os seus chamadores. Enquanto cada call site montasse o
   * seu, seis deles montariam nada — que é o estado de hoje.
   */
  declarado?: {
    tentativas?: ReadonlyArray<{ o_que: string; desfecho?: string }>;
    cliente_quer?: string | null;
  };
  /** Texto livre de quem acionou (o `reason` de um agente MCP, por exemplo). */
  motivoTexto?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TriggerHandoffResult {
  triggered: boolean;
  reason: string;
  /**
   * O desfecho REAL do aviso ao cliente. `null` quando não houve passagem.
   *
   * Sai daqui porque quem chama precisa dele para NÃO mandar o agente externo
   * avisar de novo: a tool MCP dizia "avise o cliente" depois de o orquestrador
   * já ter avisado, e o cliente recebia a mesma coisa duas vezes.
   */
  aviso?: DesfechoDoAvisoDoCrm | null;
}

/**
 * `HandoffReason` é subconjunto de `MOTIVOS_DA_PASSAGEM` — os sete motivos deste
 * motor estão todos lá, mais `suspected_optout` e `caso_escalado`, que são do
 * outro. A função existe para que a inclusão seja checada por alguém (o
 * compilador, aqui) em vez de por um `as`: se um motivo novo entrar em
 * `HandoffReason` sem par no vocabulário do banco, o `satisfies` reprova ANTES
 * de virar um `23514` num INSERT de caminho pouco exercitado.
 */
const MOTIVO_DA_PASSAGEM = {
  requested_human: "requested_human",
  low_sentiment: "low_sentiment",
  low_confidence: "low_confidence",
  critical_stage: "critical_stage",
  legal_mention: "legal_mention",
  refund_mention: "refund_mention",
  orcamento_de_ia: "orcamento_de_ia",
} satisfies Record<HandoffReason, MotivoDaPassagem>;

function motivoDaPassagem(reason: HandoffReason): MotivoDaPassagem {
  return MOTIVO_DA_PASSAGEM[reason];
}

/**
 * O desfecho do aviso reduzido ao que a LINHA guarda: `porque` (o código técnico
 * do erro de envio) fica no log, porque a coluna é lida por uma tela que traduz.
 */
function desfechoDaPassagem(aviso: DesfechoDoAvisoDoCrm): DesfechoDoAvisoDaPassagem {
  if (aviso.avisado) return { avisado: true };
  return {
    avisado: false,
    ...(aviso.motivoCodigo !== undefined ? { motivoCodigo: aviso.motivoCodigo } : {}),
  };
}

/**
 * O idioma da ORGANIZAÇÃO — ninguém está logado quando um worker escreve. Nunca
 * lança: o corpo do aviso em português é infinitamente melhor que aviso nenhum.
 */
async function idiomaDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<Idioma> {
  try {
    const { data } = await admin
      .from("organizations")
      .select("locale")
      .eq("id", organizationId)
      .maybeSingle();
    return normalizarIdioma((data as { locale?: string | null } | null)?.locale ?? null);
  } catch {
    return "pt-BR";
  }
}

const IDEMPOTENCY_WINDOW_MS = 5_000;
// Postgres `infinity` literal — bot must never reassume after handoff (IA-06).
const SILENCE_INFINITY = "infinity";

export async function triggerHandoff(
  input: TriggerHandoffInput,
): Promise<TriggerHandoffResult> {
  try {
    const admin = createAdminClient();
    const guard = async () => {
      if (input.serviceBoundary) {
        if (input.serviceBoundary.organization_id !== input.organizationId || input.serviceBoundary.conversation_id !== input.conversationId) throw new Error("service_scope_mismatch");
        await assertServiceBoundarySupabase(admin, input.serviceBoundary);
      }
    };
    await guard();

    // Idempotency check: se um handoff aconteceu há <5s pra esta conversa COM
    // a mesma reason, é provavelmente uma race entre G2/G3/G4 disparando em
    // paralelo. Skip silenciosamente.
    const { data: convNow } = await admin
      .from("conversations")
      .select(
        "id, organization_id, contact_id, last_handoff_at, last_handoff_reason, last_outbound_at",
      )
      .eq("id", input.conversationId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();

    if (!convNow) {
      return { triggered: false, reason: "conversation_not_found" };
    }

    type ConvNowRow = {
      id: string;
      organization_id: string;
      last_handoff_at: string | null;
      last_handoff_reason: string | null;
    };
    const c = convNow as unknown as ConvNowRow;

    if (c.last_handoff_at) {
      const since = Date.now() - new Date(c.last_handoff_at).getTime();
      if (since < IDEMPOTENCY_WINDOW_MS && c.last_handoff_reason === input.reason) {
        return { triggered: false, reason: "idempotent_5s" };
      }
    }

    // GATE DE ELEGIBILIDADE — só se passa bot→humano uma conversa que a IA
    // PODERIA estar atendendo agora. Se `decidirElegibilidade` já diz não —
    // porque o gate `allowlist` barra o contato (cliente antigo irritado →
    // `low_sentiment` do worker de sentimento), OU porque já está de forma
    // duradoura silenciada/em handoff/com dono humano —, NÃO há o que passar: disparar
    // mandaria "um humano vai te atender" (às vezes de novo) e mexeria no
    // estado de uma conversa que não é da IA. Fail-closed: erro de leitura →
    // não dispara (o evento re-tenta).
    try {
      const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        agora: new Date(),
        ttlMs: ttlDaAutorizacaoMs(process.env),
      });
      if (elegib !== null && !elegib.permite) {
        return { triggered: false, reason: `nao_elegivel:${elegib.motivo}` };
      }
    } catch (err) {
      logger.warn("[handoff] elegibilidade indeterminada — handoff não disparado", {
        conversation_id: input.conversationId,
        detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
      });
      return { triggered: false, reason: "elegibilidade_indeterminada" };
    }

    const nowIso = new Date().toISOString();

    // Step 0 — AVISA O LEAD. Antes de tudo, e este é o passo que faltava.
    //
    // Medido em produção (conversa `b934ba2d`, 2026-08-26): o agente PERGUNTOU o
    // e-mail do cliente, o worker de sentimento disparou este caminho entre a
    // pergunta e a resposta, e o cliente respondeu para o vazio. A passagem
    // funcionava; a pessoa do outro lado é que não existia para o código.
    //
    // Precisa do `contact_id` — é a semente da variante do texto. Sem ele
    // (conversa órfã, que a UI não mostra) seguimos sem avisar: o handoff é mais
    // importante que o aviso, e a falta vira linha no item da Central abaixo.
    const contactId = (convNow as unknown as { contact_id?: string | null }).contact_id ?? null;
    const aviso =
      contactId === null
        ? { avisado: false, porque: "conversa_sem_contato" }
        : await avisarLeadDoCrm(admin, {
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            contactId,
            reason: input.reason,
            serviceBoundary: input.serviceBoundary,
          });

    // Step 1 — flip conversation to pending + silence bot indefinitely.
    // We use 'infinity' (Postgres timestamp special) so any later comparison
    // `bot_silenced_until > now()` is always true. supabase-js sends as text
    // and Postgres parses correctly for timestamptz columns.
    await guard();
    const { error: updErr } = await admin
      .from("conversations")
      .update({
        status: "pending",
        bot_silenced_until: SILENCE_INFINITY,
        last_handoff_at: nowIso,
        last_handoff_reason: input.reason,
        status_changed_at: nowIso,
        // Fase 3 (review T5, finding 4): zera a aderência ao agente do router — se o
        // bot for reativado, o router decide de novo (não reassume por inércia).
        active_ai_agent_id: null,
        active_intent: null,
        active_agent_set_at: null,
      })
      .eq("id", input.conversationId)
      .eq("organization_id", input.organizationId);

    if (updErr) {
      logger.warn("[handoff-orchestrator] conversation update failed", {
        conversation_id: input.conversationId,
        error: updErr.message,
      });
      return { triggered: false, reason: "orchestrator_error" };
    }

    // Step 2 — timeline activity (best-effort; missing leadId is OK).
    if (input.leadId) {
      await guard();
      const { error: actErr } = await admin.from("crm_lead_activities").insert({
        organization_id: input.organizationId,
        lead_id: input.leadId,
        type: "handoff_triggered",
        source_module: "ai",
        payload: {
          conversation_id: input.conversationId,
          reason: input.reason,
        },
        metadata: {
          actor_kind: "system",
          reason: input.reason,
          ...(input.metadata ?? {}),
        },
      });
      if (actErr) {
        logger.warn("[handoff-orchestrator] activity insert failed", {
          lead_id: input.leadId,
          error: actErr.message,
        });
      }

      // Step 2.5 — best-effort: move o card para a etapa "chamar humano" do
      // pipeline dele, quando o tenant configurou uma (ver docstring do
      // arquivo). Nunca bloqueia nem derruba o handoff em si.
      await guard();
      await moverLeadParaEtapaDeHandoff(admin, {
        organizationId: input.organizationId,
        leadId: input.leadId,
        reason: input.reason,
        serviceBoundary: input.serviceBoundary,
      }).catch((err) => {
        logger.warn("[handoff-orchestrator] moverLeadParaEtapaDeHandoff failed", {
          lead_id: input.leadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Step 3 — durable event for any downstream consumer.
    const { error: emitErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "ai.handoff_triggered",
      p_entity_kind: "conversation",
      p_entity_id: input.conversationId,
      p_payload: {
        conversation_id: input.conversationId,
        organization_id: input.organizationId,
        reason: input.reason,
        lead_id: input.leadId ?? null,
        metadata: input.metadata ?? {},
      },
      p_metadata: { source: "handoff-orchestrator" },
      p_organization_id: input.organizationId,
    } as never);
    if (emitErr) {
      logger.warn("[handoff-orchestrator] emit_event failed", {
        conversation_id: input.conversationId,
        error: (emitErr as { message?: string }).message ?? String(emitErr),
      });
    }

    // Step 4 — Realtime broadcast so the agent UI lights up immediately.
    try {
      const channel = admin.channel(`org:${input.organizationId}:queue`);
      await channel.send({
        type: "broadcast",
        event: "handoff_pending",
        payload: {
          conversation_id: input.conversationId,
          reason: input.reason,
        },
      });
      await admin.removeChannel(channel);
    } catch (err) {
      logger.warn("[handoff-orchestrator] realtime broadcast failed", {
        conversation_id: input.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 5 — audit log (fire-and-forget; never blocks).
    const { error: auditErr } = await admin.from("api_audit_log").insert({
      action: "ai.handoff_triggered",
      organization_id: input.organizationId,
      resource_type: "conversation",
      resource_id: input.conversationId,
      metadata: {
        reason: input.reason,
        lead_id: input.leadId ?? null,
        ...(input.metadata ?? {}),
      },
    });
    if (auditErr) {
      logger.warn("[handoff-orchestrator] audit insert failed", {
        conversation_id: input.conversationId,
        error: auditErr.message,
      });
    }

    // O AVISO na Central faltava neste motor, e a falta era grave: ele devolvia a
    // conversa à fila (`status='pending'`) e silenciava a IA, mas não abria item
    // nenhum em `agent_inbox_items` — só `performHumanHandoff` abria. O
    // invariante 4 do Sistema Vivo quebrado nos dois sentidos ao mesmo tempo: o
    // cliente sem resposta E o time sem sinal de que havia alguém esperando.
    //
    // A chave do dedup é a MESMA de `performHumanHandoff` — e as DUAS mudaram
    // juntas nesta entrega: `ref_kind='conversation'`, `ref_id=<conversa>`,
    // `status='open'`. Com `contact`, um cliente com duas conversas abertas
    // rendia um aviso só, e a segunda ficava invisível; e o destino do aviso era
    // a ficha do contato, não o lugar onde se responde.
    if (contactId !== null) {
      const idiomaDaOrg = await idiomaDaOrganizacao(admin, input.organizationId);
      // D11: o worker de clima diz qual motor mediu (`sentiment_engine`).
      const percebidoPeloJev =
        input.reason === "low_sentiment" &&
        input.metadata?.[CHAVES_DO_CLIMA.motor] === ("jev" satisfies MotorDoClima);
      // Step 5.5 — A LINHA DE FATO. Este motor abria o aviso da Central SEM
      // resumo nenhum: quem assumia uma conversa escalada por sentimento
      // recebia "Motivo: low_sentiment" e mais nada. Agora o contexto é uma
      // linha de `passagens_de_atendimento`, montada pela MESMA função do outro
      // motor — e é o que impede as duas telas de divergirem de novo.
      //
      // Dentro do `guard()` que já existe, como os efeitos acima.
      await guard();
      const briefing = montarBriefingDaPassagem({
        checkpoint: await checkpointDuravel(admin, input.organizationId, contactId),
        pendentesDoCliente: await falasPendentes(
          admin,
          input.organizationId,
          input.conversationId,
          (convNow as unknown as { last_outbound_at?: string | null }).last_outbound_at ?? null,
        ),
        ...(input.declarado !== undefined ? { declaradoPeloModelo: input.declarado } : {}),
        motivo: {
          codigo: motivoDaPassagem(input.reason),
          texto: input.motivoTexto ?? null,
          percebidoPeloJev,
        },
      });
      const gravou = await registrarPassagem(admin, {
        organizationId: input.organizationId,
        contactId,
        conversationId: input.conversationId,
        motor: "crm",
        origem: input.origem,
        motivoCodigo: motivoDaPassagem(input.reason),
        briefing,
        aviso: desfechoDaPassagem(aviso),
      });
      if (!gravou.gravada) {
        logger.warn("[handoff-orchestrator] passagem não registrada", {
          conversation_id: input.conversationId,
          error: gravou.erro,
        });
      }

      // Step 6 — o aviso na CENTRAL, para uma pessoa de verdade puxar a conversa.
      //
      // Dois consertos no mesmo bloco, os mesmos do motor A:
      //   1. `ref_kind` é `conversation` — o dedup por CONTATO fazia um cliente
      //      com duas conversas abertas render um aviso só;
      //   2. a segunda passagem ENRIQUECE o item aberto em vez de ser descartada
      //      em silêncio. É o defeito medido: o sentimento chegava primeiro (sem
      //      contexto), o pedido explícito chegava depois e sumia.
      //
      // Continua sendo select-then-update/insert, com a corrida que o repo já
      // declara: um índice único teria de incluir `status`, que é mutável, e
      // isso quebraria reabrir item resolvido.
      try {
        const corpo = corpoCurtoDoAviso(
          {
            motivoCodigo: motivoDaPassagem(input.reason),
            aviso: desfechoDaPassagem(aviso),
            percebidoPeloJev,
          },
          (texto) => traduzir(texto, idiomaDaOrg),
        );
        const { data: aberto } = await admin
          .from("agent_inbox_items")
          .select("id, body")
          .eq("organization_id", input.organizationId)
          .eq("kind", "handoff")
          .eq("ref_kind", "conversation")
          .eq("ref_id", input.conversationId)
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const alvo = aberto as { id: string; body: string | null } | null;
        const { error: inboxErr } = alvo
          ? await admin
              .from("agent_inbox_items")
              .update({ body: `${alvo.body ?? ""}\n\n${corpo}`, severity: "critical" })
              .eq("organization_id", input.organizationId)
              .eq("id", alvo.id)
          : await admin.from("agent_inbox_items").insert({
              organization_id: input.organizationId,
              kind: "handoff",
              severity: "critical",
              // No idioma da ORGANIZAÇÃO, como o corpo: o título da Central sai
              // como foi gravado (nunca passa por t() na tela).
              title: traduzir("Atendimento automático parou — assumir a conversa", idiomaDaOrg),
              body: corpo,
              ref_kind: "conversation",
              ref_id: input.conversationId,
            });
        if (inboxErr) {
          logger.warn("[handoff-orchestrator] inbox item insert failed", {
            conversation_id: input.conversationId,
            error: inboxErr.message,
          });
        }
      } catch (err) {
        // Fire-and-forget como os passos 2..5: o aviso é o alerta, não a ação.
        logger.warn("[handoff-orchestrator] inbox item skipped", {
          conversation_id: input.conversationId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
    }

    return { triggered: true, reason: input.reason, aviso };
  } catch (err) {
    logger.warn("[handoff-orchestrator] unexpected error", {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { triggered: false, reason: "orchestrator_error" };
  }
}

/**
 * O checkpoint durável do contato, do jeito que a montagem do briefing o lê.
 *
 * É a MESMA linha que o motor de conversa usa (`latestCheckpoint`), pela outra
 * porta: aqui não há `pg.Pool`. Nunca lança — contexto a menos nunca pode virar
 * passagem a menos.
 */
async function checkpointDuravel(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  contactId: string,
): Promise<CheckpointParaBriefing | null> {
  try {
    const { data } = await admin
      .from("lead_checkpoints")
      .select("commitments, objections, next_action, rolling_summary, declaracao")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    return checkpointDoBanco(data);
  } catch {
    return null;
  }
}

/**
 * O que o cliente escreveu e ainda não foi respondido — as palavras DELE.
 *
 * O recorte é "inbound depois do último outbound", que é a definição operacional
 * de pendente sem precisar do estado do turno (este motor não tem turno). Teto
 * de cinco: é citação para uma pessoa ler, não transcrição.
 */
async function falasPendentes(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  conversationId: string,
  desde: string | null,
): Promise<string[]> {
  try {
    let consulta = admin
      .from("messages")
      .select("body, created_at")
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(5);
    if (desde !== null) consulta = consulta.gt("created_at", desde);
    const { data } = await consulta;
    return ((data ?? []) as Array<{ body: string | null }>)
      .map((m) => (m.body ?? "").trim())
      .filter((b) => b !== "")
      .reverse();
  } catch {
    return [];
  }
}
