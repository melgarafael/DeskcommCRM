/**
 * O FUSO DA ORGANIZAÇÃO — de onde o turno tira "que horas são aqui".
 *
 * O fuso e o idioma são lidos JUNTOS numa query só, em `fatos-da-organizacao.ts`
 * — módulo próprio, porque testes de terceiros substituem ESTE arquivo por um
 * duble inteiro. Aqui ficam só `fusoDaOrganizacao` (a porta de quem quer apenas
 * o fuso) e o reexport de compatibilidade de quem já importava
 * `fatosDaOrganizacao` deste caminho.
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
 * acento no campo de configuração seria pior que uma hora de diferença. A
 * leitura e a degradação moram em `fatos-da-organizacao.ts`, onde o motivo
 * está documentado por inteiro.
 */

import { fatosDaOrganizacao } from './fatos-da-organizacao';

import type { Queryable } from '../queue/queue';
import type { Logger } from '../obs/logger';

export { fatosDaOrganizacao, type FatosDaOrganizacao } from './fatos-da-organizacao';

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
