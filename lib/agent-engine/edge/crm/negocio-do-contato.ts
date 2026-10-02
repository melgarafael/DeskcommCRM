/**
 * O NEGÓCIO DA PESSOA — o id que as ferramentas do CRM querem em `lead_id`.
 *
 * O contexto do turno sempre chamou o CONTATO de `lead_id` (issue #509), e o
 * modelo acreditava no nome: mandava o id da pessoa para `crm_update_lead`, que
 * espera o id do NEGÓCIO. O portão de escopo não achava negócio, recusava com
 * `escopo_de_funil:indisponivel`, e nenhum campo do card era gravado. Medido em
 * produção em 2026-10-01: nenhuma chamada do agente gravou.
 *
 * A ESCOLHA não nasce aqui: é `resolveActiveLeadForContact`, a mesma do
 * roteamento de atividade e do portão (`lib/ai/runtime/tools.ts`), também sem
 * `defaultPipelineId`. Se as duas divergissem, o contexto diria um negócio e o
 * portão autorizaria outro. O Operador (`cardDoFunil`, operator-turn.ts) chama
 * ESTA função — uma cópia da consulta deixaria os dois papéis discordarem sobre
 * qual é o card da pessoa.
 */
import type { Queryable } from '../../queue/queue';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';

/** `{ id: null, aviso }` = há negócio, mas não dá para saber qual: não adivinhar. */
export type NegocioNoContexto =
  | { id: string; funil: string; etapa: string | null }
  | { id: null; aviso: string };

type LinhaDoNegocio = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  status: LeadCandidate['status'];
  last_activity_at: Date | string | null;
  created_at: Date | string;
  funil: string;
  etapa: string | null;
};

const SQL_NEGOCIOS_ABERTOS = `select l.id, l.organization_id, l.pipeline_id, l.status, l.last_activity_at, l.created_at,
       p.name as funil, s.name as etapa
  from crm_leads l
  join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
  left join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
 where l.organization_id = $1 and l.contact_id = $2 and l.status = 'open'`;

/** O pg devolve `timestamptz` como Date; a regra compara ISO. */
function paraIso(valor: Date | string): string {
  return new Date(valor).toISOString();
}

export async function negocioDoContato(
  db: Queryable,
  tenantId: string,
  contactId: string,
): Promise<NegocioNoContexto | null> {
  const { rows } = await db.query<LinhaDoNegocio>(SQL_NEGOCIOS_ABERTOS, [tenantId, contactId]);
  // O status vem da LINHA, e não um 'open' fixo confiando no `where`: quem decide
  // o que é aberto é a regra, e é ela que o Operador (`cardDoFunil`) também usa.
  const candidatos: LeadCandidate[] = rows.map((r) => ({
    id: r.id,
    organization_id: r.organization_id,
    pipeline_id: r.pipeline_id,
    status: r.status,
    last_activity_at: r.last_activity_at === null ? null : paraIso(r.last_activity_at),
    created_at: paraIso(r.created_at),
  }));

  const escolha = resolveActiveLeadForContact(candidatos);
  if (escolha.routed) {
    const linha = rows.find((r) => r.id === escolha.leadId);
    return linha ? { id: linha.id, funil: linha.funil, etapa: linha.etapa } : null;
  }
  if (escolha.reason === 'ambiguous_open_leads') {
    return {
      id: null,
      aviso:
        'Esta pessoa tem mais de um negócio aberto e não dá para saber qual é o desta conversa. ' +
        'Não grave nada em negócio neste turno.',
    };
  }
  return null;
}
