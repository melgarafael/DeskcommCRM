import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { TurnPreview } from './preview';
import type { LoadedSkill } from './skills';

/**
 * Etiquetas da CONVERSA, do CONTATO e dos NEGÓCIOS do contato que o matcher de skills
 * (`any_tags`) lê. O agente põe essas etiquetas com `crm_manage_tags`, e os fluxos de follow-up
 * põem a do negócio (`edit_lead_tag`).
 *
 * Os negócios: os ABERTOS do contato (`crm_leads.status = 'open'`); se não há nenhum aberto, o
 * MAIS RECENTE. Spec 27, fatia 2 — antes só a conversa e o contato entravam.
 *
 * Só consulta quando alguma skill carregada tem `any_tags` e quando o turno é real (preview
 * não tem conversa). Sempre com organization_id nas TRÊS tabelas: o pool é o da service role,
 * que ignora RLS, e o id da conversa vem do job, não do body — o negócio de outra organização
 * não casa com a conversa, mesmo que o contact_id coincida. Falha de leitura não derruba o
 * turno: registra e devolve [] (a skill ainda casa pela palavra-chave).
 */
export async function etiquetasParaOMatcher(
  pool: Pick<pg.Pool, 'query'>,
  tenantId: string,
  conversationId: string,
  skills: readonly LoadedSkill[],
  preview: TurnPreview | undefined,
  log: Logger,
): Promise<string[]> {
  // Prévia (Testar): não há conversa real; as etiquetas são as que o operador simulou.
  if (preview) return preview.tags ?? [];
  if (!skills.some((s) => (s.matcher.any_tags?.length ?? 0) > 0)) return [];
  try {
    const { rows } = await pool.query<{ tags: string[] | null }>(
      `select coalesce(cv.tags,'{}') || coalesce(c.tags,'{}') || n.tags as tags
         from conversations cv
         left join contacts c on c.id = cv.contact_id and c.organization_id = cv.organization_id
         left join lateral (
           select coalesce(array_agg(u.t), '{}'::text[]) as tags
             from (
               select unnest(l.tags) as t
                 from crm_leads l
                where l.organization_id = cv.organization_id
                  and l.contact_id = cv.contact_id
                  and l.status = 'open'
               union all
               select unnest(r.tags) as t
                 from (
                   select l.tags
                     from crm_leads l
                    where l.organization_id = cv.organization_id
                      and l.contact_id = cv.contact_id
                    order by l.created_at desc
                    limit 1
                 ) r
                where not exists (
                   select 1 from crm_leads a
                    where a.organization_id = cv.organization_id
                      and a.contact_id = cv.contact_id
                      and a.status = 'open'
                )
             ) u
         ) n on true
        where cv.organization_id = $1 and cv.id = $2`,
      [tenantId, conversationId],
    );
    return rows[0]?.tags ?? [];
  } catch (erro) {
    log.warn('etiquetas da conversa não lidas — a skill segue só pela palavra-chave', {
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return [];
  }
}
