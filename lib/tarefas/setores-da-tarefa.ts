/**
 * AS TRÊS FONTES DO SETOR DE UMA TAREFA, LIDAS NO SERVIDOR (#4883).
 *
 * A regra é `setorDaTarefa` (`lib/tarefas/setor-da-tarefa.ts`). Este arquivo só
 * responde "qual é o setor da conversa / do negócio / do responsável" para um
 * punhado de tarefas — e é o único lugar da tela de Tarefas que toca o banco
 * para isso, porque o chip e o filtro precisam da MESMA resposta.
 *
 * ─── Onde cada fonte mora (medido no schema, nenhuma migration) ─────────────
 *
 *  · conversa: `conversations.sector_id`, escrito pela IA/automação/pessoa por
 *    `lib/atendimento/setor-da-conversa.ts` (#3881). A conversa "da tarefa" é a
 *    do `crm_tasks.contact_id` — a MAIS RECENTE. Se ela não tem fila, a fonte
 *    não responde: um setor antigo, de uma conversa anterior, não é o setor do
 *    atendimento de agora.
 *  · negócio: `crm_leads` NÃO tem coluna de setor (conferido no baseline). O
 *    setor do card é o da conversa LIGADA a ele em `crm_lead_links`
 *    (`target_kind = 'conversation'`); sem ligação, o da conversa mais recente
 *    do contato do negócio.
 *  · responsável: `attendant_sector_members`. Quando a pessoa está em mais de um
 *    setor, o "primeiro" é o de menor id — determinístico e sempre o mesmo. Ele
 *    não finge ser regra: o selo o marca como fallback.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { buscaEmLotes } from "@/lib/supabase/em-lotes";

import type { FontesDoSetor } from "./setor-da-tarefa";

/** O mínimo que estas consultas precisam de uma tarefa. */
export interface TarefaParaSetor {
  id: string;
  contact_id: string | null;
  lead_id: string | null;
  assigned_to: string | null;
  /** O negócio embutido pela rota (`lead:crm_leads(id, title, contact_id)`). */
  lead?: { id: string; contact_id?: string | null } | null;
}

interface LinhaDeConversa {
  id?: string;
  contact_id?: string;
  sector_id: string | null;
  last_message_at: string | null;
  created_at?: string | null;
}

/** Quanto mais recente, mais "agora" — e desempate estável pelo id. */
function maisRecente(a: LinhaDeConversa, b: LinhaDeConversa): number {
  const chave = (c: LinhaDeConversa) => c.last_message_at ?? c.created_at ?? "";
  const porData = chave(b).localeCompare(chave(a));
  return porData !== 0 ? porData : (a.id ?? "").localeCompare(b.id ?? "");
}

/**
 * Devolve, por id de tarefa, as fontes preenchidas. Tarefa sem nenhuma fonte
 * simplesmente não aparece no mapa (e o selo dela não existe).
 *
 * Quatro consultas no máximo, e nenhuma por linha: a lista corta em 500 e uma
 * consulta por tarefa multiplicaria isso por 500. Cada `.in()` vai em lotes
 * (`buscaEmLotes`): 500 uuids numa consulta só estouram o header de resposta.
 *
 * Falha de leitura LANÇA: devolver a lista sem setor seria o selo mentindo em
 * silêncio — a rota traduz em 500.
 */
export async function lerFontesDoSetor(
  supabase: SupabaseClient,
  organizationId: string,
  tarefas: readonly TarefaParaSetor[],
): Promise<Map<string, FontesDoSetor>> {
  const fontes = new Map<string, FontesDoSetor>();
  if (tarefas.length === 0) return fontes;

  const contatos = new Set<string>();
  const negocios = new Set<string>();
  const responsaveis = new Set<string>();
  for (const tarefa of tarefas) {
    if (tarefa.contact_id) contatos.add(tarefa.contact_id);
    const contatoDoNegocio = tarefa.lead?.contact_id ?? null;
    if (contatoDoNegocio) contatos.add(contatoDoNegocio);
    if (tarefa.lead_id) negocios.add(tarefa.lead_id);
    if (tarefa.assigned_to) responsaveis.add(tarefa.assigned_to);
  }

  // ① A conversa mais recente de cada contato (a da tarefa e a do negócio).
  const setorPorContato = new Map<string, string>();
  if (contatos.size > 0) {
    const { data, error } = await buscaEmLotes<LinhaDeConversa>([...contatos], (lote) =>
      supabase
        .from("conversations")
        .select("id, contact_id, sector_id, last_message_at, created_at")
        .eq("organization_id", organizationId)
        .in("contact_id", lote),
    );
    if (error) throw new Error(error.message);
    const porContato = new Map<string, LinhaDeConversa[]>();
    for (const linha of data) {
      if (!linha.contact_id) continue;
      const lista = porContato.get(linha.contact_id) ?? [];
      lista.push(linha);
      porContato.set(linha.contact_id, lista);
    }
    for (const [contatoId, lista] of porContato) {
      const recente = [...lista].sort(maisRecente)[0];
      if (recente?.sector_id) setorPorContato.set(contatoId, recente.sector_id);
    }
  }

  // ② O setor da conversa LIGADA a cada negócio (`crm_lead_links`).
  const setorPorNegocio = new Map<string, string>();
  if (negocios.size > 0) {
    const { data: ligacoes, error: erroDasLigacoes } = await buscaEmLotes<{
      lead_id: string;
      target_id: string;
    }>([...negocios], (lote) =>
      supabase
        .from("crm_lead_links")
        .select("lead_id, target_id, created_at")
        .eq("organization_id", organizationId)
        .eq("target_kind", "conversation")
        .in("lead_id", lote),
    );
    if (erroDasLigacoes) throw new Error(erroDasLigacoes.message);
    const porNegocio = new Map<string, string[]>();
    for (const l of ligacoes) {
      const lista = porNegocio.get(l.lead_id) ?? [];
      lista.push(l.target_id);
      porNegocio.set(l.lead_id, lista);
    }
    const ids = [...new Set([...porNegocio.values()].flat())];
    if (ids.length > 0) {
      const { data: conversas, error: erroDasConversas } = await buscaEmLotes<{
        id: string;
        sector_id: string | null;
      }>(ids, (lote) =>
        supabase
          .from("conversations")
          .select("id, sector_id")
          .eq("organization_id", organizationId)
          .in("id", lote),
      );
      if (erroDasConversas) throw new Error(erroDasConversas.message);
      const setorDaConversa = new Map(
        conversas.flatMap((c) => (c.sector_id ? [[c.id, c.sector_id] as const] : [])),
      );
      for (const [negocioId, conversasDoNegocio] of porNegocio) {
        for (const conversaId of conversasDoNegocio) {
          const setor = setorDaConversa.get(conversaId);
          if (setor) {
            setorPorNegocio.set(negocioId, setor);
            break;
          }
        }
      }
    }
  }

  // ③ O fallback: o primeiro setor de quem tem a tarefa (menor id, estável).
  const setorDoResponsavel = new Map<string, string>();
  if (responsaveis.size > 0) {
    const { data: vinculos, error: erroDosVinculos } = await buscaEmLotes<{
      user_id: string;
      sector_id: string;
    }>([...responsaveis], (lote) =>
      supabase
        .from("attendant_sector_members")
        .select("user_id, sector_id")
        .eq("organization_id", organizationId)
        .in("user_id", lote),
    );
    if (erroDosVinculos) throw new Error(erroDosVinculos.message);
    const porUsuario = new Map<string, string[]>();
    for (const v of vinculos) {
      const lista = porUsuario.get(v.user_id) ?? [];
      lista.push(v.sector_id);
      porUsuario.set(v.user_id, lista);
    }
    for (const [userId, lista] of porUsuario) {
      const menor = [...lista].sort()[0];
      if (menor) setorDoResponsavel.set(userId, menor);
    }
  }

  for (const tarefa of tarefas) {
    const entrada: FontesDoSetor = {
      conversa: tarefa.contact_id ? (setorPorContato.get(tarefa.contact_id) ?? null) : null,
      negocio:
        setorPorNegocio.get(tarefa.lead_id ?? "") ??
        (tarefa.lead?.contact_id ? (setorPorContato.get(tarefa.lead.contact_id) ?? null) : null),
      responsavel: tarefa.assigned_to ? (setorDoResponsavel.get(tarefa.assigned_to) ?? null) : null,
    };
    if (entrada.conversa || entrada.negocio || entrada.responsavel) fontes.set(tarefa.id, entrada);
  }

  return fontes;
}
