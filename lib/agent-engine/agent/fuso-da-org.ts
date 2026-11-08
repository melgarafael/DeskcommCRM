/**
 * O FUSO DA ORGANIZAÇÃO — de onde o turno tira "que horas são aqui".
 *
 * ⚠️ A FONTE É `organizations.timezone`, E NÃO `channel_knobs.timezone`.
 *
 * As duas colunas guardam um IANA e hoje guardam o MESMO texto
 * (`America/Sao_Paulo`) numa instalação brasileira — o que faz a escolha
 * parecer indiferente. Não é, e o defeito só aparece no cliente que não é de
 * São Paulo:
 *
 *   - `organizations.timezone` é o fuso que a PESSOA escolheu, no wizard de
 *     boas-vindas (`app/actions/onboarding/acceptWelcome.ts`) e em
 *     Configurações › Empresa (`app/actions/settings/updateTenant.ts`).
 *   - `channel_knobs.timezone` é knob ANTI-BAN por canal: o PUT de
 *     `/api/v1/ai/pacing` grava só o que vem no body, e a coluna fica `null`
 *     em quem nunca abriu o painel. Nulo, a JANELA cai no fuso da organização
 *     (`fusoDaJanela`, em `pacing/store.ts`); preenchido, segue o número — e
 *     ler esse valor aqui faria uma escolha anti-ban mudar o relógio do
 *     agente. Até a janela ganhar essa escada, o nulo caía no literal de São
 *     Paulo: numa clínica de Manaus, uma hora de erro, calada.
 *
 * Ler o fuso do pacing seria de graça (o turno já o carrega) e é exatamente por
 * isso que a armadilha existe.
 *
 * ⚠️ FALHA ABERTA, e isso é decisão, não descuido. A leitura pode estourar num
 * clone cujo schema está atrás do código, e o valor pode ser um fuso que o
 * `Intl` recusa — `organizations.timezone` não é validado por escritor nenhum
 * (`tenantSchema` e o schema do onboarding são `z.string().max(64)` sem
 * `refine`, e a coluna não tem CHECK). Nos dois casos o turno segue com o
 * padrão do produto: derrubar o atendimento de um cliente por causa de um
 * acento no campo de configuração seria pior que uma hora de diferença.
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
 * `fusoDaOrganizacao`, que delega.
 *
 * Falha ABERTA, como o fuso: um clone com schema atrás do código, ou um
 * `locale` que o produto não serve, não pode derrubar o atendimento — a prosa
 * sai em português, que é o comportamento de antes da #4260.
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

/**
 * O fuso IANA da organização, sempre utilizável.
 *
 * Nunca lança e nunca devolve string vazia — quem chama pode passar direto ao
 * `Intl`. Quando degrada, o motivo vai ao log com o valor recusado: sem isso, a
 * organização de Manaus que digitou o fuso errado veria horários de São Paulo
 * para sempre, sem nada explicando.
 */
export async function fusoDaOrganizacao(
  db: Queryable,
  organizationId: string,
  log?: Logger,
): Promise<string> {
  return (await fatosDaOrganizacao(db, organizationId, log)).fuso;
}
