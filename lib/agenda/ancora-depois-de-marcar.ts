/**
 * Para onde a grade da Agenda vai quando o painel de marcação fecha.
 *
 * ## De onde vem a prova — e de onde ELA NÃO VEM
 *
 * Relato de 2026-09-12: *"fiz um agendamento que não aparece ao sair da agenda"*.
 *
 * ⚠️ **O compromisso existia** — aparecia nas três visões. Quem relatou estava
 * procurando no dia e na semana errados, e disse isso ao conferir. Vale registrar
 * a forma exata do engano, porque ela é o defeito e não a desculpa dele: a grade
 * ficou onde estava, a pessoa foi procurar de memória, e procurou errado. Um
 * minuto perdido e a conclusão "sumiu" — sobre um sistema que funcionava.
 *
 * "Não apareceu" e "não fui levado até ele" são a mesma experiência para quem
 * usa. O produto já sabia disso e escreveu, no botão "Ver na agenda":
 *
 * > *"o compromisso recém marcado costuma ser de OUTRA semana (o do relato era
 * > 8 de setembro), e a grade abre na semana corrente. Voltar para uma grade que
 * > não mostra o que acabou de nascer é o mesmo 'nada acontece' com um passo a
 * > mais."*
 *
 * E consertou **um** caminho: quem clica em "Ver na agenda" é levado até o dia.
 * Quem fecha no X — ou clica fora, ou aperta Esc — não é. É o mesmo formato de
 * erro que a limpeza do painel tinha no mesmo arquivo: o raciocínio certo,
 * aplicado a parte dos caminhos.
 *
 * Dois relatos, meses diferentes, mesma frase — e o conserto anterior cobriu só
 * quem clica no botão certo. Quem fecha no X é a maioria.
 *
 * ## Por que levar a grade, e não avisar
 *
 * A alternativa seria um aviso ("marcado para 24 de setembro"). Ela é pior: o
 * aviso some, a dúvida fica, e a pessoa ainda precisa navegar. Levar a grade
 * responde a pergunta que ela vai fazer — *cadê?* — antes de ela fazer.
 *
 * ## Por que isto é uma função, e não três linhas dentro do componente
 *
 * Porque assim dá para medir. A regra tem um caso degenerado que decide tudo
 * (**fechar sem ter marcado não pode mover a grade**) e ele é invisível em
 * revisão de código: mover a âncora sempre que o painel fecha teleporta quem
 * abriu, olhou e desistiu — para o dia de um compromisso que ele não criou.
 */

/**
 * @param instanteMarcado ISO do compromisso recém-criado nesta abertura do
 *   painel, ou `null` quando nada foi marcado.
 * @param inicioDoDia Normalmente `startOfDay` do date-fns. Recebido como
 *   parâmetro para esta regra não depender da biblioteca de datas — o que a
 *   torna testável sem fuso, sem relógio e sem import pesado.
 * @returns O novo valor da âncora, ou `null` para **não mexer** na grade.
 */
export function ancoraAoFecharPainel(
  instanteMarcado: string | null | undefined,
  inicioDoDia: (d: Date) => Date,
): Date | null {
  // ⛔ O CASO QUE DECIDE TUDO: abrir o painel, olhar e desistir não pode mover
  // a grade. Quem só espiou perderia o lugar onde estava — e é o caminho mais
  // comum dos dois.
  if (!instanteMarcado) return null;

  const quando = new Date(instanteMarcado);
  // Data ilegível é o mesmo que não saber: não mexer é sempre recuperável,
  // teleportar para `Invalid Date` deixa a grade em branco sem explicação.
  if (Number.isNaN(quando.getTime())) return null;

  // O DIA, nunca o instante: a âncora é o dia de referência da visão. Mandar o
  // instante exato funciona por acidente na visão de semana e escolhe a hora
  // errada na de dia — é a mesma razão escrita no `onVerNaAgenda`.
  return inicioDoDia(quando);
}
