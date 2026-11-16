/**
 * QUANDO O "NÃO TENHO INTERESSE" AINDA RESPONDE À PROSPECÇÃO — e o que o adiamento cria.
 * Decisão do dono, 15/11 (doc 360 de decisões, recomendações 1A e 2A).
 *
 * ═══ 1A · A janela ═══
 *
 * A conversa do WhatsApp é a mesma para sempre, e `metadata.prospecting_campaign_id`
 * nunca sai dela. Sem janela, o cliente que foi prospectado, comprou, e meses depois
 * escreve "não tenho interesse" sobre outra coisa ganhava recusa permanente e perdia
 * os acompanhamentos da conversa. A frase só responde à prospecção enquanto:
 *
 * - houver negócio da prospecção ABERTO para o contato (`crm_leads.source =
 *   'prospecting'`, `status = 'open'`), ou
 * - a última abordagem da prospecção (`prospecting_candidates.attempted_at`, gravado
 *   pelo worker na transação do envio) tiver no máximo 30 dias.
 *
 * Fora disso, a frase é conversa normal: nada é gravado, nada é encerrado.
 *
 * ═══ 2A · Adiamento ═══
 *
 * "Não tenho interesse agora, me chama mês que vem" não vai para Perdido nem tira o
 * contato das campanhas: vira TAREFA para o vendedor retomar.
 *
 * NUNCA lança: a mensagem já está gravada, e quem chama só registra o resultado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Db } from "@/lib/db";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { normalizarTexto } from "@/lib/opt-out/deteccao";
import { criarTarefaInterna } from "@/lib/tarefas/criar-tarefa";
import { ORIGEM_ADIAMENTO_DA_PROSPECCAO } from "@/lib/tarefas/vocabulario-de-origem";

/** Até quanto tempo depois da última abordagem a frase ainda responde à prospecção. */
export const JANELA_DA_ULTIMA_ABORDAGEM_MS = 30 * 24 * 60 * 60 * 1000;

export interface JanelaDaProspeccao {
  negocioAberto: { id: string; ownerUserId: string | null } | null;
  ultimaAbordagemEm: string | null;
}

/** A frase ainda responde à prospecção? */
export function dentroDaJanelaDaProspeccao(janela: JanelaDaProspeccao, agoraMs: number): boolean {
  if (janela.negocioAberto) return true;
  const abordagem = janela.ultimaAbordagemEm ? Date.parse(janela.ultimaAbordagemEm) : Number.NaN;
  return !Number.isNaN(abordagem) && agoraMs - abordagem <= JANELA_DA_ULTIMA_ABORDAGEM_MS;
}

/**
 * Lê o negócio aberto da prospecção e a última abordagem do contato. `null` quando a
 * leitura falha: quem chama não grava nada (a régua erra para o lado de não gravar).
 */
export async function lerJanelaDaProspeccao(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<JanelaDaProspeccao | null> {
  const [leads, abordagens] = await Promise.all([
    admin
      .from("crm_leads")
      .select("id, owner_user_id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .eq("source", "prospecting")
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1),
    admin
      .from("prospecting_candidates")
      .select("attempted_at")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .in("status", ["sending", "sent"])
      .not("attempted_at", "is", null)
      .order("attempted_at", { ascending: false })
      .limit(1),
  ]);
  if (leads.error || abordagens.error) return null;
  const lead = ((leads.data ?? []) as Array<{ id: string; owner_user_id?: string | null }>)[0];
  const abordagem = ((abordagens.data ?? []) as Array<{ attempted_at: string | null }>)[0];
  return {
    negocioAberto: lead ? { id: lead.id, ownerUserId: lead.owner_user_id ?? null } : null,
    ultimaAbordagemEm: abordagem?.attempted_at ?? null,
  };
}

/** Título da tarefa (traduzido pelo idioma da organização, como o aviso da carteira). */
export const TITULO_DA_RETOMADA = "Retomar a prospecção: {{contact.name}} pediu para falar depois";

/** "semana que vem" pede retorno em dias; o resto ("mês que vem", "mais pra frente") em um mês. */
export function prazoDaRetomadaEmDias(texto: string): number {
  // ponytail: duas faixas só; o vendedor ajusta o prazo na tarefa.
  return /\b(?:semana\s+que\s+(?:vem|viene)|proxima\s+semana|mais\s+tarde|mas\s+tarde)\b/u.test(
    normalizarTexto(texto),
  )
    ? 7
    : 30;
}

export interface PedidoDeRetomada {
  organizationId: string;
  contactId: string;
  texto: string;
  negocio: JanelaDaProspeccao["negocioAberto"];
  /** Quem atende a conversa (`conversations.assigned_to_user_id`), quando há. */
  atendenteDaConversa: string | null;
  requestId: string;
}

export type ResultadoDaRetomada =
  | { criada: true; tarefaId: string }
  | { criada: false; motivo: "sem_responsavel" | "ja_tem_tarefa_aberta" }
  | { criada: false; motivo: "falha"; erro: string };

/**
 * O vendedor responsável, nesta ordem: o dono do negócio da prospecção, quem atende a
 * conversa, o dono da carteira do contato e, sem nenhum deles, o administrador mais
 * antigo — o negócio da prospecção nasce com o AGENTE de IA como dono, e uma tarefa
 * sem responsável não lembra ninguém. A régua de quem pode receber é a de
 * `lib/tarefas/responsavel.ts`: membro ativo da organização, acima de `viewer`.
 */
const SQL_DO_RESPONSAVEL = `
  with candidatos as (
    select array_remove(array[
      $3::uuid,
      $4::uuid,
      (select carteira_user_id from contacts where organization_id = $1 and id = $2)
    ], null) as ids
  )
  select u.user_id
    from user_organizations u, candidatos c
   where u.organization_id = $1
     and u.revoked_at is null
     and u.role <> 'viewer'
     and (u.user_id = any(c.ids) or u.role = 'admin')
   order by array_position(c.ids, u.user_id) nulls last, u.created_at
   limit 1`;

/** Cria a tarefa de retomar o contato que adiou. Uma por vez: com tarefa aberta, não duplica. */
export async function criarTarefaDeRetomada(db: Db, pedido: PedidoDeRetomada): Promise<ResultadoDaRetomada> {
  try {
    const responsavel = await db.queryOne<{ user_id: string }>(SQL_DO_RESPONSAVEL, [
      pedido.organizationId,
      pedido.contactId,
      pedido.negocio?.ownerUserId ?? null,
      pedido.atendenteDaConversa,
    ]);
    if (!responsavel) return { criada: false, motivo: "sem_responsavel" };

    const aberta = await db.queryOne<{ id: string }>(
      `select id from crm_tasks
        where organization_id = $1 and contact_id = $2 and assigned_to = $3
          and status in ('pending', 'in_progress')
        limit 1`,
      [pedido.organizationId, pedido.contactId, responsavel.user_id],
    );
    if (aberta) return { criada: false, motivo: "ja_tem_tarefa_aberta" };

    const org = await db.queryOne<{ locale: string | null }>(
      "select locale from organizations where id = $1",
      [pedido.organizationId],
    );
    const r = await criarTarefaInterna(db, {
      organizationId: pedido.organizationId,
      titulo: traduzir(TITULO_DA_RETOMADA, normalizarIdioma(org?.locale)),
      venceEmDias: prazoDaRetomadaEmDias(pedido.texto),
      atribuirA: { usuario_id: responsavel.user_id },
      prioridade: "medium",
      leadId: pedido.negocio?.id ?? null,
      contactId: pedido.contactId,
      origem: ORIGEM_ADIAMENTO_DA_PROSPECCAO,
      requestId: pedido.requestId,
    });
    if (r.ok) return { criada: true, tarefaId: r.tarefa_id };
    return { criada: false, motivo: "falha", erro: r.erro ?? r.codigo };
  } catch (err) {
    return { criada: false, motivo: "falha", erro: err instanceof Error ? err.message.slice(0, 160) : "desconhecido" };
  }
}
