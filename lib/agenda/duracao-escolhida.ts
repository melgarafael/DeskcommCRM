/**
 * A DURAÇÃO DO ATENDIMENTO ESCOLHIDA NA MARCAÇÃO — a faixa, num lugar só.
 *
 * ─── Por que isto existe ────────────────────────────────────────────────────
 *
 * `calendar_event_types.duration_minutes` é o molde do serviço, e até aqui era
 * a ÚNICA duração que existia: quem marca recebe o que o cadastro decidiu, e um
 * atendimento que dura o dobro do previsto vira dois compromissos colados ou um
 * bloco que invade o seguinte. O pedido da issue #3709 é exatamente quebrar o
 * "tempo pré-determinado" sem perder o molde — o valor do serviço continua sendo
 * o PADRÃO, e deixa de ser a única opção.
 *
 * ─── ⚠️ ONDE A DURAÇÃO VIVE, E POR QUE NÃO HÁ COLUNA ────────────────────────
 *
 * `calendar_appointments` NÃO tem `duration_minutes`, e não precisa: a duração
 * de um compromisso é `ends_at - starts_at`, e é isso que o motor de horários
 * lê (`Ocupado.inicio`/`fim`). Gravar o número numa coluna criaria uma segunda
 * verdade que pode discordar do intervalo — e a que decide ocupação é o
 * intervalo. O `check (duration_minutes between 5 and 1440)` que existe no
 * schema é de `calendar_event_types` e de `calendar_service_schedule`, os
 * MOLDES.
 *
 * A consequência prática: escolher 90 minutos é escrever `ends_at = inicio + 90`,
 * sem migration. O que esta faixa protege é a ENTRADA — a tela e a rota não
 * podem aceitar um valor que o bom senso (e os moldes) recusariam.
 *
 * ─── A faixa é a MESMA dos moldes, e é de propósito ────────────────────────
 *
 * 5…1440 são os limites de `calendar_event_types_duracao_sensata`. Um
 * compromisso de 3 minutos ou de 25 horas não é escolha de produto, é erro de
 * digitação — e um de 25 horas atravessa o dia seguinte e faz o motor de
 * horários oferecer slot que termina depois da janela. Uma régua só para os
 * dois lados evita que a marcação aceite o que o cadastro recusa.
 */

/** Piso da duração escolhida — o mesmo `check` de `calendar_event_types`. */
export const DURACAO_MINIMA_MIN = 5;

/** Teto da duração escolhida — idem. */
export const DURACAO_MAXIMA_MIN = 1440;

/**
 * O valor é uma duração aceitável?
 *
 * Inteiro de minutos dentro da faixa. `Number.isInteger` recusa 30.5, que
 * gravaria um `ends_at` com segundos e faria a grade desenhar um bloco com
 * altura fracionária; `NaN`, `Infinity` e string ficam de fora pela mesma
 * checagem de tipo.
 */
export function duracaoEscolhidaValida(valor: unknown): valor is number {
  return (
    typeof valor === "number" &&
    Number.isInteger(valor) &&
    valor >= DURACAO_MINIMA_MIN &&
    valor <= DURACAO_MAXIMA_MIN
  );
}
