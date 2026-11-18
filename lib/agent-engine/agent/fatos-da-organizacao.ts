/**
 * OS FATOS DA ORGANIZAÇÃO que o turno lê UMA vez: fuso e idioma.
 *
 * ⚠️ MÓDULO PRÓPRIO, e não dentro de `fuso-da-org.ts`. A #4260 acrescentou o
 * idioma à mesma query do fuso, e mover a função para dentro do módulo do fuso
 * custou caro: testes de terceiros substituem `fuso-da-org` por um duble
 * INTEIRO (`vi.mock(..., () => ({ fusoDaOrganizacao: ... }))`), e o turno, que
 * passou a importar `fatosDaOrganizacao` de lá, morria com "No export is
 * defined on the mock". O símbolo novo mora aqui, onde nenhum duble o alcança;
 * `fuso-da-org.ts` só REEXPORTA, para quem já importava de lá continuar
 * funcionando.
 *
 * ⚠️ A FONTE DO FUSO É `organizations.timezone`, E NÃO `channel_knobs.timezone`.
 * As duas colunas guardam um IANA e hoje guardam o mesmo texto numa instalação
 * brasileira; não são a mesma coisa. `organizations.timezone` é o fuso que a
 * PESSOA escolheu (wizard de boas-vindas e Configurações › Empresa);
 * `channel_knobs.timezone` é knob ANTI-BAN por canal, `null` em quem nunca
 * abriu o painel. Ler o pacing aqui faria uma escolha anti-ban mudar o relógio
 * do agente — numa clínica de Manaus, uma hora de erro, calada.
 *
 * ⚠️ FALHA ABERTA, e isso é decisão, não descuido. A leitura pode estourar num
 * clone cujo schema está atrás do código, o fuso pode ser um IANA que o `Intl`
 * recusa (a coluna não tem CHECK) e o `locale` pode ser um idioma que o produto
 * não serve. Nos três casos o turno segue com o padrão do produto: derrubar o
 * atendimento por causa de um acento no campo de configuração seria pior que
 * uma hora de diferença — e a prosa sai em português, que é o comportamento de
 * antes da #4260.
 */

import { IDIOMA_PADRAO, type Idioma } from '@/lib/i18n/idiomas';
import { FUSO_PADRAO, fusoValido } from '@/lib/tempo/fusos';

import type { Queryable } from '../queue/queue';
import type { Logger } from '../obs/logger';
import { idiomaDoMotor } from './idioma-do-turno';

/** O que o turno precisa saber da linha da organização, lido de UMA vez. */
export interface FatosDaOrganizacao {
  /** Fuso IANA, sempre utilizável. */
  fuso: string;
  /** Idioma do atendimento; `pt-BR` quando o campo está vazio ou é desconhecido. */
  idioma: Idioma;
}

/**
 * Fuso e idioma da organização, numa query só.
 *
 * O idioma entrou aqui na #4260 (item 1) porque o turno JÁ lia esta linha para
 * o fuso: uma segunda consulta por turno só para saber a língua seria pagar
 * duas idas ao banco pela mesma linha. Quem só quer o fuso continua chamando
 * `fusoDaOrganizacao` (em `fuso-da-org.ts`), que delega.
 */
export async function fatosDaOrganizacao(
  db: Queryable,
  organizationId: string,
  log?: Logger,
): Promise<FatosDaOrganizacao> {
  let bruto: { timezone: string | null; locale: string | null } | null = null;
  try {
    const { rows } = await db.query<{ timezone: string | null; locale: string | null }>(
      'select timezone, locale from organizations where id = $1',
      [organizationId],
    );
    bruto = rows[0] ?? null;
  } catch (err) {
    log?.warn('não consegui ler o fuso e o idioma da organização — o turno segue no padrão', {
      fuso_padrao: FUSO_PADRAO,
      idioma_padrao: IDIOMA_PADRAO,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return { fuso: FUSO_PADRAO, idioma: IDIOMA_PADRAO };
  }

  const tz = bruto?.timezone?.trim() ?? '';
  if (tz !== '' && fusoValido(tz)) return { fuso: tz, idioma: idiomaDoMotor(bruto?.locale ?? null) };

  log?.warn('fuso da organização inutilizável — o turno segue no padrão', {
    // O valor recusado vai ao log porque é ele que diz o que corrigir na tela.
    // Não é PII: é um código IANA de configuração, não dado de pessoa.
    fuso_recusado: tz,
    fuso_padrao: FUSO_PADRAO,
  });
  return { fuso: FUSO_PADRAO, idioma: idiomaDoMotor(bruto?.locale ?? null) };
}
