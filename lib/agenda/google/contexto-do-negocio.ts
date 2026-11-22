/**
 * A LEITURA DO CONTEXTO DO NEGÓCIO PARA O EVENTO (#4006).
 *
 * O commit do bloco é `lib/agenda/contexto-do-negocio.ts` (função pura). Aqui
 * mora o que ele não pode fazer: ler o banco.
 *
 * ─── De onde vem cada linha ────────────────────────────────────────────────
 *
 * - **Negócio:** o vinculo polimórfico `crm_lead_links` (`target_kind =
 *   'appointment'`). Compromisso sem vínculo devolve `null` — e o bloco inteiro
 *   não existe. Não há `lead_id` na linha do compromisso (DECISÃO 6).
 * - **Etapa:** `crm_stages.name`, pela mesma linha do negócio.
 * - **Produtos:** os itens da proposta do negócio. Vale a ACEITA; sem aceita, a
 *   ENVIADA mais recente. Rascunho, recusada, vencida e cancelada não entram:
 *   mandar para o cliente o que ele recusou é pior que não mandar nada.
 * - **Cliente e telefone:** a ficha do contato, pela régua de rótulo
 *   (`nomeDoContato`) e nunca por identificador técnico. Contato anonimizado
 *   (LGPD) não leva nome nem telefone.
 * - **Link:** `${NEXT_PUBLIC_APP_URL}/app/leads/<id>`, e só quando a instalação
 *   tem base configurada. Sem ela, a linha não aparece — um link relativo no
 *   celular de quem recebeu o convite não leva a lugar nenhum.
 *
 * ⚠️ NADA aqui pode derrubar a publicação. O evento é do compromisso; o bloco é
 * um acessório. Toda falha de leitura degrada para "sem contexto".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  montarBlocoDoNegocio,
  type ContextoDoNegocio,
  type ItemDaProposta,
} from "@/lib/agenda/contexto-do-negocio";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

function linkDoNegocio(leadId: string): string | null {
  const base = (env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}/app/leads/${leadId}` : null;
}

/**
 * O contexto do negócio vinculado ao compromisso, ou `null` quando não há.
 *
 * Sem vínculo (`crm_lead_links`, `target_kind='appointment'`) não há bloco: o
 * evento do compromisso avulso continua sendo só o que a pessoa escreveu. É a
 * mesma resposta para falha de leitura — o acessório não derruba a publicação.
 */
export async function carregarContextoDoNegocio(
  db: SupabaseClient,
  org: string,
  appointment: { id: string; contact_id: string | null },
): Promise<ContextoDoNegocio | null> {
  if (typeof db.from !== "function") return null;
  try {
    const { data: vinculo } = await db
      .from("crm_lead_links")
      .select("lead_id")
      .eq("organization_id", org)
      .eq("target_id", appointment.id)
      .eq("target_kind", "appointment")
      .limit(1);
    const leadId = (vinculo ?? [])[0]?.lead_id;
    if (!leadId) return null;

    const [{ data: lead }, contato] = await Promise.all([
      db
        .from("crm_leads")
        .select("id,title,stage_id,crm_stages!crm_leads_stage_id_fkey(name)")
        .eq("organization_id", org)
        .eq("id", leadId)
        .maybeSingle(),
      lerContato(db, org, appointment.contact_id),
    ]);
    if (!lead) return null;

    const etapa = (lead as { crm_stages?: { name?: string | null } | { name?: string | null }[] | null })
      .crm_stages;
    const nomeDaEtapa = (Array.isArray(etapa) ? etapa[0]?.name : etapa?.name) ?? null;

    return {
      negocio: { id: String(lead.id), titulo: String(lead.title ?? "").trim() },
      etapa: nomeDaEtapa,
      produtos: await itensDaPropostaVigente(db, org, String(leadId)),
      cliente: contato,
      link: linkDoNegocio(String(leadId)),
    };
  } catch (e) {
    logger.warn("[agenda-contexto] leitura do negócio falhou; o evento sai sem o bloco", {
      organization_id: org,
      appointment_id: appointment.id,
      motivo: e instanceof Error ? e.message : "desconhecido",
    });
    return null;
  }
}

/** Nome pela régua do contato e telefone canônico. Anonimizado não leva nada. */
async function lerContato(
  db: SupabaseClient,
  org: string,
  contactId: string | null,
): Promise<{ nome: string | null; telefone: string | null } | null> {
  if (!contactId) return null;
  const { data } = await db
    .from("contacts")
    .select("display_name,name,phone_number,is_anonymized")
    .eq("organization_id", org)
    .eq("id", contactId)
    .maybeSingle();
  if (!data || data.is_anonymized) return null;
  const nome = nomeDoContato(data);
  const telefone = phoneForDisplay(data.phone_number);
  if (!nome && !telefone) return null;
  return { nome, telefone: telefone || null };
}

/**
 * Os itens da proposta que vale: aceita primeiro; sem aceita, a enviada mais
 * recente. As outras situações não são "produto em jogo", são histórico.
 */
async function itensDaPropostaVigente(
  db: SupabaseClient,
  org: string,
  leadId: string,
): Promise<ItemDaProposta[]> {
  const { data: propostas } = await db
    .from("crm_proposals")
    .select("id,status,sent_at,created_at")
    .eq("organization_id", org)
    .eq("lead_id", leadId)
    .in("status", ["aceita", "enviada"]);
  const lista = (propostas ?? []) as Array<{
    id: string;
    status: string;
    sent_at: string | null;
    created_at: string | null;
  }>;
  const escolhida =
    lista.find((p) => p.status === "aceita") ??
    [...lista]
      .filter((p) => p.status === "enviada")
      .sort((a, b) => instante(b) - instante(a))[0];
  if (!escolhida) return [];

  const { data: itens } = await db
    .from("crm_proposal_items")
    .select("descricao,quantidade")
    .eq("organization_id", org)
    .eq("proposal_id", escolhida.id)
    .order("position", { ascending: true });
  return ((itens ?? []) as Array<{ descricao: string; quantidade: number }>).map((i) => ({
    descricao: String(i.descricao ?? ""),
    quantidade: Number(i.quantidade ?? 1),
  }));
}

function instante(p: { sent_at: string | null; created_at: string | null }): number {
  const bruto = p.sent_at ?? p.created_at;
  const ms = bruto ? Date.parse(bruto) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * O bloco que a descrição do evento leva no fim, ou `""` quando não leva.
 *
 * ⚠️ Só compromisso FUTURO ganha o bloco: o passado não se reescreve, e
 * reescrevê-lo seria disparar `sendUpdates` para todo cliente de compromisso
 * encerrado.
 *
 * O interruptor por tipo (`calendar_event_types.levar_dados_do_negocio`) é
 * DESLIGADO de fábrica (doc 272 = B) porque o cliente TAMBÉM é convidado quando
 * a ficha tem e-mail: atualizar o sistema não pode mandar nome, telefone e etapa
 * do funil para fora sem alguém decidir. Quem quer liga na tela do tipo; quem
 * desliga depois faz os compromissos futuros já publicados voltarem a levar só
 * o texto da pessoa.
 */
export async function blocoDoNegocioDoEvento(
  db: SupabaseClient,
  org: string,
  appointment: {
    id: string;
    contact_id: string | null;
    description: string | null;
    starts_at: string;
    event_type_id: string | null;
  },
  agora: Date = new Date(),
): Promise<string> {
  const futuro = Date.parse(appointment.starts_at) > agora.getTime();
  if (!futuro) return "";
  if (!(await levarDadosDoNegocio(db, org, appointment.event_type_id))) return "";
  const contexto = await carregarContextoDoNegocio(db, org, appointment);
  return montarBlocoDoNegocio(contexto);
}

/**
 * O interruptor do tipo, com o default do banco (desligado).
 *
 * Só `true` lido do banco leva o bloco. Tipo ausente (compromisso antigo,
 * bloqueio do Google), linha não achada e erro de leitura não têm decisão de
 * ninguém a respeitar e ficam no padrão de fábrica: dado do cliente não sai.
 */
async function levarDadosDoNegocio(
  db: SupabaseClient,
  org: string,
  eventTypeId: string | null,
): Promise<boolean> {
  if (!eventTypeId) return false;
  try {
    const { data } = await db
      .from("calendar_event_types")
      .select("levar_dados_do_negocio")
      .eq("organization_id", org)
      .eq("id", eventTypeId)
      .maybeSingle();
    return data?.levar_dados_do_negocio === true;
  } catch {
    return false;
  }
}
