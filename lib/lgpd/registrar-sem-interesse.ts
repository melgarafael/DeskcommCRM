/**
 * GRAVAR E DESFAZER o "não tem interesse" (decisão D3): a recusa de marketing, a
 * auditoria `lgpd.consent_changed` e o negócio da prospecção encerrado.
 *
 * Dois escritores chamam daqui, e só daqui:
 *
 * - o botão da ficha (`app/api/v1/contacts/[id]/sem-interesse/route.ts`);
 * - a conversa de prospecção, quando o cliente escreve a frase
 *   (`lib/channels/pos-entrada.ts`).
 *
 * ═══ Que follow-up morre ═══
 *
 * A inscrição de follow-up da prospecção (`lib/followup/encerrar-pela-recusa.ts`): sem
 * isso, a resposta do cliente acordava a retomada e o próximo toque saía logo depois
 * do "não". O follow-up de atendimento fica.
 *
 * ═══ Que negócio fecha ═══
 *
 * Só o que nasceu da PROSPECÇÃO (`crm_leads.source = 'prospecting'`), aberto. Um
 * negócio de atendimento em curso (o pedido, a consulta, o orçamento que o cliente
 * pediu) não fecha porque ele não quer receber ofertas — é o oposto do PARAR, que
 * encerra tudo. Desfazer a recusa NÃO reabre o negócio: reabrir é gesto do quadro.
 *
 * Admin client: o filtro por organização é programático em toda consulta (CLAUDE.md,
 * anti-pattern 10) e a organização sempre vem de quem chama, de fonte confiável.
 *
 * ═══ Gravação sem atropelar ═══
 *
 * O `consent` é um mapa de finalidades, e a gravação reescreve o objeto inteiro. Para
 * não apagar uma escrita de outra finalidade que chegue entre a leitura e a gravação, o
 * UPDATE só casa com o `updated_at` lido (o gatilho `trg_contacts_updated_at` o muda a
 * cada escrita); quando não casa, relê e tenta de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/api/handlers/types";
import { encerrarFollowupsDaProspeccao } from "@/lib/followup/encerrar-pela-recusa";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { logger } from "@/lib/logger";
import {
  consentComSemInteresse,
  consentSemASemInteresse,
  ehRecusaSemInteresse,
  MOTIVO_SEM_INTERESSE,
  motivoDePerdaSemInteresse,
  type OrigemDoSemInteresse,
} from "@/lib/lgpd/sem-interesse";

export interface PedidoDeSemInteresse {
  organizationId: string;
  contactId: string;
  origem: OrigemDoSemInteresse;
  actor: Actor;
  requestId: string;
  /** A conversa em que a frase chegou (só no gatilho da conversa). */
  conversationId?: string;
  /** A campanha de prospecção daquela conversa (só no gatilho da conversa). */
  campanhaId?: string;
}

/** O que a recusa encerrou: o negócio da prospecção e o follow-up dela. */
export interface EfeitosDaRecusa {
  negociosFechados: number;
  followupsEncerrados: number;
}

export type ResultadoDoSemInteresse =
  | ({ gravado: true } & EfeitosDaRecusa)
  | ({ gravado: false; motivo: "ja_recusado" } & EfeitosDaRecusa)
  | { gravado: false; motivo: "nao_encontrado" | "anonimizado" | "erro" };

export type ResultadoDoDesfazer =
  | { desfeito: true }
  | { desfeito: false; motivo: "nao_encontrado" | "sem_recusa" | "erro" };

interface LinhaDoContato {
  id: string;
  consent: unknown;
  is_anonymized: boolean | null;
  updated_at: string | null;
}

/** Quantas vezes a gravação relê quando outra escrita chegou no meio. */
const TENTATIVAS_DE_GRAVACAO = 3;

async function lerContato(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<LinhaDoContato | null | "erro"> {
  const { data, error } = await admin
    .from("contacts")
    .select("id, consent, is_anonymized, updated_at")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) return "erro";
  return (data as LinhaDoContato | null) ?? null;
}

/**
 * Grava `consent` só se o contato não mudou desde a leitura (`updated_at` igual).
 * `"mudou"` quando outra escrita chegou no meio: quem chama relê e recalcula.
 */
async function gravarConsent(
  admin: SupabaseClient,
  organizationId: string,
  contato: LinhaDoContato,
  consent: Record<string, unknown>,
): Promise<"gravado" | "mudou" | { erro: string }> {
  let q = admin
    .from("contacts")
    .update({ consent })
    .eq("organization_id", organizationId)
    .eq("id", contato.id);
  if (contato.updated_at) q = q.eq("updated_at", contato.updated_at);
  const { data, error } = await q.select("id");
  if (error) return { erro: error.message };
  return (data ?? []).length > 0 ? "gravado" : "mudou";
}

/**
 * Grava a recusa "sem interesse". Idempotente: repetir não grava nem audita de novo,
 * mas volta a encerrar o negócio e o follow-up da prospecção. Se o encerramento falhou
 * na primeira vez (funil sem etapa de perdido, erro passageiro), a frase repetida
 * termina o serviço.
 */
export async function registrarSemInteresse(
  admin: SupabaseClient,
  pedido: PedidoDeSemInteresse,
): Promise<ResultadoDoSemInteresse> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_DE_GRAVACAO; tentativa += 1) {
    const contato = await lerContato(admin, pedido.organizationId, pedido.contactId);
    if (contato === "erro") return { gravado: false, motivo: "erro" };
    if (!contato) return { gravado: false, motivo: "nao_encontrado" };
    if (contato.is_anonymized) return { gravado: false, motivo: "anonimizado" };

    const novo = consentComSemInteresse(contato.consent, {
      agora: new Date().toISOString(),
      origem: pedido.origem,
    });
    if (!novo) {
      // Recusa de outra origem (captação, ficha antiga): ela já tira o contato das
      // ofertas, e não é desta régua fechar negócio por ela.
      if (!ehRecusaSemInteresse(contato.consent))
        return { gravado: false, motivo: "ja_recusado", negociosFechados: 0, followupsEncerrados: 0 };
      return { gravado: false, motivo: "ja_recusado", ...(await encerrarOQueARecusaAlcanca(admin, pedido)) };
    }

    const gravacao = await gravarConsent(admin, pedido.organizationId, contato, novo);
    if (gravacao === "mudou") continue;
    if (gravacao !== "gravado") {
      // `error`, não `warn`: o cliente disse que não quer, e a recusa não ficou gravada.
      logger.error("sem-interesse: recusa NAO gravada — o contato segue elegível a ofertas", {
        organization_id: pedido.organizationId,
        contact_id: pedido.contactId,
        origem: pedido.origem,
        detail: gravacao.erro.slice(0, 160),
      });
      return { gravado: false, motivo: "erro" };
    }

    await audit({
      action: "lgpd.consent_changed",
      actorUserId: pedido.actor.type === "user" ? pedido.actor.id : null,
      organizationId: pedido.organizationId,
      resourceType: "contact",
      resourceId: pedido.contactId,
      requestId: pedido.requestId,
      bypassedRls: true,
      // Sem nome nem texto da mensagem: a auditoria é append-only e a anonimização não a alcança.
      metadata: {
        contact_id: pedido.contactId,
        finalidade: "marketing",
        consentimento: "recusado",
        motivo: MOTIVO_SEM_INTERESSE,
        origem: pedido.origem,
        ...(pedido.conversationId ? { conversation_id: pedido.conversationId } : {}),
        ...(pedido.campanhaId ? { prospecting_campaign_id: pedido.campanhaId } : {}),
      },
    });

    return { gravado: true, ...(await encerrarOQueARecusaAlcanca(admin, pedido)) };
  }
  logger.error("sem-interesse: recusa NAO gravada — o contato mudou a cada tentativa", {
    organization_id: pedido.organizationId,
    contact_id: pedido.contactId,
    origem: pedido.origem,
  });
  return { gravado: false, motivo: "erro" };
}

/** O negócio e o follow-up da prospecção. Os dois NUNCA lançam. */
async function encerrarOQueARecusaAlcanca(
  admin: SupabaseClient,
  pedido: PedidoDeSemInteresse,
): Promise<EfeitosDaRecusa> {
  const negociosFechados = await fecharNegociosDaProspeccao(admin, pedido);
  const followupsEncerrados = await encerrarFollowupsDaProspeccao(admin, {
    organizationId: pedido.organizationId,
    contactId: pedido.contactId,
    ...(pedido.conversationId ? { conversationId: pedido.conversationId } : {}),
  });
  return { negociosFechados, followupsEncerrados };
}

/** Desfaz a recusa "sem interesse" (aba LGPD). Não reabre negócio. */
export async function desfazerSemInteresse(
  admin: SupabaseClient,
  pedido: Omit<PedidoDeSemInteresse, "origem" | "conversationId" | "campanhaId">,
): Promise<ResultadoDoDesfazer> {
  let desfeito = false;
  for (let tentativa = 1; tentativa <= TENTATIVAS_DE_GRAVACAO && !desfeito; tentativa += 1) {
    const contato = await lerContato(admin, pedido.organizationId, pedido.contactId);
    if (contato === "erro") return { desfeito: false, motivo: "erro" };
    if (!contato) return { desfeito: false, motivo: "nao_encontrado" };

    const novo = consentSemASemInteresse(contato.consent);
    if (!novo) return { desfeito: false, motivo: "sem_recusa" };

    const gravacao = await gravarConsent(admin, pedido.organizationId, contato, novo);
    if (gravacao === "gravado") desfeito = true;
    else if (gravacao !== "mudou") return { desfeito: false, motivo: "erro" };
  }
  if (!desfeito) return { desfeito: false, motivo: "erro" };

  await audit({
    action: "lgpd.consent_changed",
    actorUserId: pedido.actor.type === "user" ? pedido.actor.id : null,
    organizationId: pedido.organizationId,
    resourceType: "contact",
    resourceId: pedido.contactId,
    requestId: pedido.requestId,
    bypassedRls: true,
    metadata: {
      contact_id: pedido.contactId,
      finalidade: "marketing",
      consentimento: "recusa_desfeita",
      motivo: MOTIVO_SEM_INTERESSE,
      origem: "ficha",
    },
  });
  return { desfeito: true };
}

/**
 * Encerra como perdido o negócio ABERTO que a prospecção criou para o contato.
 *
 * NUNCA lança: a recusa já está gravada, e um funil sem etapa de perdido não pode
 * desfazê-la. A falha fica no log.
 */
async function fecharNegociosDaProspeccao(
  admin: SupabaseClient,
  pedido: PedidoDeSemInteresse,
): Promise<number> {
  try {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, pipeline_id")
      .eq("organization_id", pedido.organizationId)
      .eq("contact_id", pedido.contactId)
      .eq("source", "prospecting")
      .eq("status", "open");
    if (error) {
      logger.warn("sem-interesse: negócios da prospecção não lidos", {
        organization_id: pedido.organizationId,
        contact_id: pedido.contactId,
        detail: error.message.slice(0, 160),
      });
      return 0;
    }
    const leads = (data ?? []) as Array<{ id: string; pipeline_id: string }>;
    if (leads.length === 0) return 0;

    const pipelineIds = [...new Set(leads.map((l) => l.pipeline_id))];
    const { data: funis } = await admin
      .from("crm_pipelines")
      .select("id, settings")
      .eq("organization_id", pedido.organizationId)
      .in("id", pipelineIds);
    const settingsPorFunil = new Map(
      ((funis ?? []) as Array<{ id: string; settings: unknown }>).map((f) => [f.id, f.settings]),
    );

    let fechados = 0;
    for (const lead of leads) {
      try {
        await encerraDemanda(
          admin,
          { organization_id: pedido.organizationId, actor: pedido.actor, requestId: pedido.requestId },
          {
            leadId: lead.id,
            desfecho: "lost",
            motivo: motivoDePerdaSemInteresse(settingsPorFunil.get(lead.pipeline_id)),
            razaoNaTimeline: "O cliente disse que não tem interesse",
            payloadNaTimeline: {
              motivo: MOTIVO_SEM_INTERESSE,
              origem: pedido.origem,
              ...(pedido.conversationId ? { conversation_id: pedido.conversationId } : {}),
            },
          },
        );
        fechados += 1;
      } catch (err) {
        logger.warn("sem-interesse: negócio da prospecção não foi fechado", {
          organization_id: pedido.organizationId,
          contact_id: pedido.contactId,
          lead_id: lead.id,
          detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
        });
      }
    }
    return fechados;
  } catch (err) {
    logger.warn("sem-interesse: fechamento dos negócios da prospecção falhou", {
      organization_id: pedido.organizationId,
      contact_id: pedido.contactId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return 0;
  }
}
