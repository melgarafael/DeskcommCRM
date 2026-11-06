import { partesNoFuso } from '@/lib/agenda/fuso';
import {
  FERIADOS_DESLIGADOS,
  feriadoDoDia,
  feriadosDasSettings,
  type ConfigDeFeriados,
} from '@/lib/tempo/feriados';

import type { Queryable } from '../queue/queue';
import { fusoDaOrganizacao } from './fuso-da-org';

/**
 * Os feriados da organização para o bloco `## Agora` (`organizations.settings.feriados`,
 * `lib/tempo/feriados.ts`). Mesma regra do fuso: nunca lança — sem leitura, desligado,
 * e o bloco fica como sempre foi.
 */
export async function feriadosDaOrganizacao(db: Queryable, organizationId: string): Promise<ConfigDeFeriados> {
  try {
    const { rows } = await db.query<{ feriados: unknown }>(
      `select settings -> 'feriados' as feriados from organizations where id = $1`,
      [organizationId],
    );
    return feriadosDasSettings({ feriados: rows[0]?.feriados ?? null });
  } catch {
    return FERIADOS_DESLIGADOS;
  }
}

/**
 * A data civil (`AAAA-MM-DD`) de um instante no fuso — a CHAVE do calendário.
 *
 * O calendário é indexado por data de parede, não por instante: 02/11 22h em
 * São Paulo já é 03/11 em UTC, e perguntar "que dia é hoje" com a data do
 * runtime daria o feriado errado (ou nenhum) para quem está a oeste de Greenwich.
 */
export function dataCivilNoFuso(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante, fuso);
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

/**
 * O feriado da data de `agora` no fuso da organização (nome), ou `null`.
 *
 * É a costura que faltava para o aviso de fora do horário (#3877): o calendário
 * é o MESMO do bloco `## Agora` — `feriadoDoDia` sobre `feriadosDasSettings`,
 * cuja régua dos nacionais é `isHolidayBR` (`lib/lgpd/holidays-br.ts`). Nenhum
 * segundo calendário aqui, e nenhuma tabela nova.
 *
 * Duas escolhas que valem registro:
 *
 *   - **O `ligado` do settings NÃO é consultado.** Ele liga o BLOCO do prompt
 *     (`## Agora`), não o calendário; o aviso precisa saber que dia é, não do
 *     bloco. A lista `proprios` entra (é a mesma leitura): quem já cadastrou a
 *     loja fechada em 19/03 não precisa de tela nova para o aviso acertar.
 *   - **Falha ABERTA**: banco atrás do código, fuso recusado, settings com
 *     shape torto ⇒ `null`, que é exatamente o comportamento de hoje. Um erro
 *     aqui pode perder um texto melhor; nunca pode segurar a mensagem nem
 *     derrubar o turno (que é adiado de qualquer forma).
 */
export async function feriadoDoDiaDaOrganizacao(
  db: Queryable,
  organizationId: string,
  agora: Date,
): Promise<string | null> {
  try {
    const fuso = await fusoDaOrganizacao(db, organizationId);
    const cfg = await feriadosDaOrganizacao(db, organizationId);
    return feriadoDoDia(dataCivilNoFuso(agora, fuso), cfg);
  } catch {
    return null;
  }
}
