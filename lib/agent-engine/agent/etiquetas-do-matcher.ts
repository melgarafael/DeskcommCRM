import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { TurnPreview } from './preview';
import type { LoadedSkill } from './skills';

/**
 * Etiquetas da CONVERSA e do CONTATO que o matcher de skills (`any_tags`) lê. O agente põe
 * essas etiquetas com `crm_manage_tags`.
 *
 * A etiqueta do NEGÓCIO fica de fora de propósito: uma pessoa com negócios em dois nichos
 * ativaria as skills dos dois na mesma conversa, e essa seleção ainda não tem regra aprovada.
 *
 * Só consulta quando alguma skill carregada tem `any_tags` e quando o turno é real (preview
 * não tem conversa). Sempre com organization_id: o pool é o da service role, que ignora RLS,
 * e o id da conversa vem do job, não do body. Falha de leitura não derruba o turno: registra
 * e devolve [] (a skill ainda casa pela palavra-chave).
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
      `select coalesce(cv.tags,'{}') || coalesce(c.tags,'{}') as tags
         from conversations cv
         left join contacts c on c.id = cv.contact_id and c.organization_id = cv.organization_id
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
