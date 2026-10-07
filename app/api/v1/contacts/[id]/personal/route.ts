import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * CONTATO PESSOAL — marcar e desmarcar (spec 21, fatia 1).
 *
 * ## Por que esta rota existe
 *
 * Quem usa o mesmo número para vender e para a vida entrega os dois mundos
 * para a mesma operação: a IA assume conversa que era de gente, o inbox
 * mistura trabalho com vida, e o funil ganha card que nunca foi oportunidade.
 * A marca `contacts.is_personal` (migration 0563) tira o contato da operação —
 * e é esta rota que a liga e desliga.
 *
 * ## Por que `manager`, e não `admin`
 *
 * Diferença medida e proposital contra o desbloqueio (`unblock/route.ts`
 * exige `admin`): desfazer descadastro reabre um canal que o cliente fechou
 * (direito do titular, LGPD). Pessoal é decisão operacional — esconder uma
 * conversa da operação — e gerente pode (spec decisão 1, D3 do plano).
 *
 * ## Por que SEM exceção para gerente no envio
 *
 * Gerente marca e desmarca, mas não envia para marcado — o veto de envio
 * (`sendMessageHandler`, fatia 2) recusa em todo papel, sem exceção.
 *
 * ## O que a rota NÃO faz
 *
 * Não apaga conversa, mensagem, negócio nem histórico: marcar esconde, tudo
 * continua no banco, e desmarcar relista (spec decisão 2). A ÚNICA remoção é a
 * dos trechos já ingeridos no RAG (#2394): ali o vetor é uma cópia operacional
 * do conteúdo, e a conversa original fica. Desmarcar NÃO reativa follow-up,
 * campanha nem prospecção (D8 — espelha o desbloqueio, que também não reativa o
 * que o bloqueio cancelou), e também não reingere o que saiu do acervo: a
 * conversa volta ao RAG quando alguém a marcar de novo como útil. Quem marcou e
 * quando fica só em auditoria + timeline, sem coluna extra no contato
 * (spec §3.6).
 *
 * ## Ordem dos efeitos do marcar (fixa, toda nesta rota)
 *
 * 1) `update contacts is_personal=true`; 2) cancela follow-ups (parada total,
 * como o bloqueio); 3) cancela retornos avulsos; 4) saída de campanha com
 * status/motivo próprios (nunca `opted_out`); 5) prospecção vira pulada com
 * motivo próprio; 6) fecha conversas + tira do atendente; 7) remove os trechos
 * já ingeridos no RAG (#2394); 8) auditoria + timeline. Sem negócio aberto, a
 * timeline é pulada em silêncio e a auditoria continua valendo como prova (D6).
 */

interface EfeitosDoMarcar {
  followups_cancelados: number;
  retornos_cancelados: number;
  campanha_saidas: number;
  prospeccao_pulada: number;
  conversas_fechadas: number;
  /** Trechos já ingeridos no RAG removidos pelo marcar (#2394). */
  trechos_de_rag_removidos: number;
}

const SEM_EFEITO: EfeitosDoMarcar = {
  followups_cancelados: 0,
  retornos_cancelados: 0,
  campanha_saidas: 0,
  prospeccao_pulada: 0,
  conversas_fechadas: 0,
  trechos_de_rag_removidos: 0,
};

/**
 * O negócio aberto do contato, para ancorar a timeline.
 *
 * `crm_lead_activities.lead_id` é NOT NULL: sem negócio aberto não há linha
 * possível — e aí não há nem tentativa (D6), só auditoria. Quando o alvo é
 * ambíguo, NÃO adivinha: o mesmo `resolveActiveLeadForContact` que o motor usa.
 */
async function negocioAbertoDoContato(
  admin: SupabaseClient,
  orgId: string,
  contactId: string,
): Promise<string | null> {
  const { data: candidatos } = await admin
    .from("crm_leads")
    .select("id, organization_id, pipeline_id, status, last_activity_at, created_at")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId);
  const { data: padrao } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  const rota = resolveActiveLeadForContact((candidatos ?? []) as LeadCandidate[], {
    defaultPipelineId: (padrao as { id: string } | null)?.id ?? null,
  });
  return rota.routed ? rota.leadId : null;
}

/**
 * A linha na timeline — falha BAIXO, mas falha CONTADA.
 *
 * A mutação (marcar/desmarcar) já aconteceu quando chegamos aqui: bloquear a
 * operação porque a timeline caiu deixaria o contato refém do registro. Mas a
 * perda vira `event_log` via `registraFalhaDeAtividade` — nunca silêncio.
 * Sem negócio aberto, nem tenta (D6): a auditoria é a prova.
 */
async function registraNaTimeline(
  admin: SupabaseClient,
  entrada: {
    orgId: string;
    contactId: string;
    leadId: string;
    tipo: "contact_marked_personal" | "contact_unmarked_personal";
    motivo: string;
    atorUserId: string;
    requestId: string;
    origem: string;
  },
): Promise<void> {
  const atividade = await emitLeadActivity(admin, {
    organizationId: entrada.orgId,
    leadId: entrada.leadId,
    contactId: entrada.contactId,
    type: entrada.tipo,
    sourceModule: "crm",
    sourceId: entrada.leadId,
    actor: { type: "user", id: entrada.atorUserId },
    reason: entrada.motivo,
    payload: { origem: entrada.origem },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(admin, {
      organizationId: entrada.orgId,
      leadId: entrada.leadId,
      tipo: entrada.tipo,
      origem: entrada.origem,
      erro: atividade.error,
      requestId: entrada.requestId,
    });
  }
}

export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Só gerente e dono marcam (spec decisão 1). Atendente recebe 403 — é ele
  // quem NÃO pode esconder conversa da operação.
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const admin = createAdminClient();
  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e
  // obrigatório (CLAUDE.md, anti-pattern 10).
  const { data: contato, error: leituraErro } = await admin
    .from("contacts")
    .select("id, display_name, is_personal")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (leituraErro) {
    return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
      requestId,
    });
  }
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  // Idempotente na PROVA, não nos efeitos: quem já era pessoal não gera nova
  // auditoria nem nova linha de timeline (recontar a história a cada clique
  // duplicaria a prova sem fato novo) — mas os efeitos SEMPRE rodam, porque
  // são condicionais e viram no-op quando já aplicados. Sem isso, uma falha no
  // meio dos efeitos deixaria a prova pela metade para sempre: a retentativa
  // bateria no "já é pessoal" e nunca completaria o que faltou.
  const eraPessoal = (contato as { is_personal?: boolean }).is_personal === true;

  let marcado = contato as { id: string; display_name: string | null; is_personal: boolean };
  if (!eraPessoal) {
    const { data, error: updateErro } = await admin
      .from("contacts")
      .update({ is_personal: true })
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .select("id, display_name, is_personal")
      .maybeSingle();
    if (updateErro || !data) {
      return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
        requestId,
      });
    }
    marcado = data as typeof marcado;
  }

  const efeitos: EfeitosDoMarcar = { ...SEM_EFEITO };
  const orgId = authz.org.orgId;
  const agora = new Date().toISOString();

  // O negócio aberto é resolvido ANTES dos efeitos: a auditoria dos retornos
  // avulsos carrega o `lead_id` (mesmo contrato da rota de cancel de promessa)
  // e a timeline o usa como âncora. Resolver não escreve nada.
  const leadId = await negocioAbertoDoContato(admin, orgId, id);

  // 2) Follow-ups: parada total, como o bloqueio — vivos + dormente + coletando
  // (os mesmos de `STATUS_ALCANCADOS_PELO_OPT_OUT`, `lib/followup/reactivity.ts`).
  // `outcome` reaproveita `opted_out` porque o CHECK da coluna é fechado
  // (`converted|replied|exhausted|opted_out|handoff`); o que distingue pessoal
  // de STOP é o `cancel_reason` próprio (`pessoal`), nunca o outcome.
  const { data: inscricoes } = await admin
    .from("followup_enrollments")
    .select("id, status, current_node_id")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["active", "waiting_reply", "paused_handoff", "dormente", "coletando"]);
  for (const e of (inscricoes ?? []) as Array<{ id: string; status: string; current_node_id: string }>) {
    const { error: cancelaErro } = await admin
      .from("followup_enrollments")
      .update({
        status: "cancelled",
        outcome: "opted_out",
        cancel_reason: "pessoal",
        next_eval_at: null,
        claimed_until: null,
        completed_at: agora,
        updated_at: agora,
      })
      .eq("organization_id", orgId)
      .eq("id", e.id);
    if (cancelaErro) {
      return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
        requestId,
      });
    }
    await admin.from("followup_enrollment_events").insert({
      organization_id: orgId,
      enrollment_id: e.id,
      node_id: e.current_node_id,
      event_type: "cancelled_personal",
      payload: { reason: "pessoal", via: "contato_pessoal" },
    });
    await audit({
      action: "followup_enrollment.cancelled",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "followup_enrollment",
      resourceId: e.id,
      requestId,
      metadata: { previous_status: e.status, cancel_reason: "pessoal", via: "contato_pessoal" },
    });
    efeitos.followups_cancelados += 1;
  }

  // 3) Retornos avulsos (`cron_jobs`, promessas): cancela o pendente para não
  // deixar lixo que dispararia depois. Mesma trava do cancel manual
  // (`enabled = true` + `cancelled_at is null` no WHERE).
  const { data: retornos } = await admin
    .from("cron_jobs")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .eq("kind", "at")
    .eq("job_kind", "followup_turn")
    .eq("enabled", true)
    .is("cancelled_at", null);
  for (const r of (retornos ?? []) as Array<{ id: string }>) {
    const { data: marcados, error: retornoErro } = await admin
      .from("cron_jobs")
      .update({
        enabled: false,
        cancelled_at: agora,
        cancel_reason: "Contato marcado como pessoal",
        updated_at: agora,
      })
      .eq("organization_id", orgId)
      .eq("id", r.id)
      .eq("enabled", true)
      .select("id");
    if (retornoErro) {
      return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
        requestId,
      });
    }
    if ((marcados ?? []).length === 0) continue; // perdeu a corrida: o cron disparou entre a leitura e a escrita.
    await audit({
      action: "followup.cancelled",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "cron_job",
      resourceId: r.id,
      requestId,
      metadata: { actor_type: "user", via: "contato_pessoal", contact_id: id, lead_id: leadId },
    });
    efeitos.retornos_cancelados += 1;
  }

  // 4) Saída de campanha com status/motivo PRÓPRIOS (D7): `personal` +
  // `contato_pessoal`, nunca `opted_out` — a taxa "pediu para parar" não mexe.
  // Marca a saída sem remover a linha, como o pedido de saída faz (mesmo
  // conjunto de status de `fecharPorOptOut`, `lib/campanhas/resposta.ts`).
  // `opted_out_at` NÃO é carimbado de propósito: aquela coluna é métrica de
  // STOP, e pessoal não é STOP.
  const { data: saidas, error: campanhaErro } = await admin
    .from("campaign_recipients")
    .update({
      status: "personal",
      eligibility_status: "excluded",
      exclusion_reason: "contato_pessoal",
    })
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["pending", "queued", "sent", "delivered", "read", "replied"])
    .select("id");
  if (campanhaErro) {
    return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
      requestId,
    });
  }
  efeitos.campanha_saidas = (saidas ?? []).length;

  // 5) Prospecção vira pulada com motivo PRÓPRIO: `skipped` por outra razão não
  // volta pela remarcação do operador (`lib/prospecting/store.ts`), então o
  // motivo importa — `contato_pessoal` nunca ressuscita pela caixa de seleção.
  const { data: pulados, error: prospeccaoErro } = await admin
    .from("prospecting_candidates")
    .update({ status: "skipped", error: "contato_pessoal", updated_at: agora })
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["new", "queued"])
    .select("id");
  if (prospeccaoErro) {
    return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
      requestId,
    });
  }
  efeitos.prospeccao_pulada = (pulados ?? []).length;

  // 6) Para cada conversa aberta: solta do atendente E fecha. A ordem é
  // `release` antes de `close` porque `fn_conversation_assign` com destino
  // nulo volta o status para `open` — fechar antes seria desfeito na linha
  // seguinte. `p_enforce_expected=false` porque quem marca não é
  // necessariamente o dono da conversa.
  const { data: abertas } = await admin
    .from("conversations")
    .select("id, status, assigned_to_user_id")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .in("status", ["open", "pending", "claimed", "ai_handling"]);
  for (const conv of (abertas ?? []) as Array<{ id: string; assigned_to_user_id: string | null }>) {
    const { data: solta, error: soltaErro } = await admin.rpc("fn_conversation_assign", {
      p_organization_id: orgId,
      p_conversation_id: conv.id,
      p_to_user_id: null as unknown as string,
      p_reason: "release",
      p_enforce_expected: false,
    });
    if (soltaErro) {
      return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
        requestId,
      });
    }
    if (!solta || (solta as unknown[]).length === 0) continue; // a conversa sumiu entre a leitura e a escrita.
    const { error: fechaErro } = await admin.rpc("fn_service_status", {
      p_org: orgId,
      p_conversation: conv.id,
      p_status: "closed",
    });
    if (fechaErro) {
      return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
        requestId,
      });
    }
    await audit({
      action: "conversation.released",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId,
      metadata: { via: "contato_pessoal" },
    });
    await audit({
      action: "conversation.closed",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "conversation",
      resourceId: conv.id,
      requestId,
      metadata: { via: "contato_pessoal" },
    });
    efeitos.conversas_fechadas += 1;
  }

  // 7) RAG (spec 21, etapa 9 + issue #2394): zerar `usable_for_rag` só impede
  // ingestões FUTURAS destas conversas (o lote novo também exclui pessoal na
  // leitura). Os trechos JÁ ingeridos continuam em `ai_chunks` e alcançáveis
  // pelo retriever — `retrieve_top_k_chunks` não lê `usable_for_rag`. A função
  // remove os que saíram das conversas DESTE contato e devolve a contagem; a
  // mesma forma da #1957 na LGPD. Desmarcar não reingere (D8): a conversa volta
  // ao acervo quando alguém a marcar de novo como útil para o RAG.
  const { error: ragErro } = await admin
    .from("conversations")
    .update({ usable_for_rag: false })
    .eq("organization_id", orgId)
    .eq("contact_id", id);
  if (ragErro) {
    return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
      requestId,
    });
  }

  const { data: trechosRemovidos, error: trechosErro } = await admin.rpc(
    "fn_contato_pessoal_remove_trechos_do_rag",
    { p_org: orgId, p_contact: id },
  );
  if (trechosErro) {
    return fail("internal_error", t("Não foi possível marcar o contato como pessoal."), 500, {
      requestId,
    });
  }
  efeitos.trechos_de_rag_removidos = (trechosRemovidos as number | null) ?? 0;

  if (eraPessoal) {
    return ok({ contact: marcado, effects: efeitos }, { requestId });
  }

  // 7) Espelha o registro do desbloqueio (`unblock/route.ts`): mesmo
  // `resourceType`, mesmo `contact_id` no metadata. O telefone NÃO entra —
  // auditoria não é lugar de dado pessoal, e o `contact_id` já identifica.
  // Os contadores de efeitos entram para a prova dizer O QUE foi desarmado.
  await audit({
    action: "contact.marked_personal",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, origem: "tela_do_contato", ...efeitos },
  });

  if (leadId) {
    await registraNaTimeline(admin, {
      orgId: authz.org.orgId,
      contactId: id,
      leadId,
      tipo: "contact_marked_personal",
      motivo: "Contato marcado como pessoal pela equipe",
      atorUserId: authz.user.id,
      requestId,
      origem: "contacts/[id]/personal.POST",
    });
  }
  // Sem negócio aberto: só auditoria (D6). A conversa some do inbox pela
  // leitura filtrada (fatia 2); o histórico continua no banco.

  return ok({ contact: marcado, effects: efeitos }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: contato, error: leituraErro } = await admin
    .from("contacts")
    .select("id, display_name, is_personal")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (leituraErro) {
    return fail("internal_error", t("Não foi possível desmarcar o contato como pessoal."), 500, {
      requestId,
    });
  }
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  // Idempotente na prova: quem já não era pessoal não gera nova auditoria.
  if ((contato as { is_personal?: boolean }).is_personal !== true) {
    return ok({ contact: contato }, { requestId });
  }

  const { data: desmarcado, error: updateErro } = await admin
    .from("contacts")
    .update({ is_personal: false })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, display_name, is_personal")
    .maybeSingle();
  if (updateErro || !desmarcado) {
    return fail("internal_error", t("Não foi possível desmarcar o contato como pessoal."), 500, {
      requestId,
    });
  }

  // NADA mais (D8): desmarcar NÃO reativa follow-up, campanha nem prospecção —
  // o que o marcar cancelou continua cancelado, e tudo volta a APARECER por
  // filtro (decisão 2 da spec). As mensagens nunca foram tocadas, então a
  // volta encontra o histórico inteiro.
  await audit({
    action: "contact.unmarked_personal",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, origem: "tela_do_contato" },
  });

  const leadId = await negocioAbertoDoContato(admin, authz.org.orgId, id);
  if (leadId) {
    await registraNaTimeline(admin, {
      orgId: authz.org.orgId,
      contactId: id,
      leadId,
      tipo: "contact_unmarked_personal",
      motivo: "Marca de pessoal retirada pela equipe",
      atorUserId: authz.user.id,
      requestId,
      origem: "contacts/[id]/personal.DELETE",
    });
  }

  return ok({ contact: desmarcado }, { requestId });
}
