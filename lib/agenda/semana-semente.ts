import { partesNoFuso, instanteDe } from "./fuso";

/**
 * A SEMANA QUE A AGENDA ABRE — calculada no fuso de quem OLHA, não no do
 * servidor.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * `app/app/agenda/page.tsx` desenhava a primeira semana com
 * `startOfWeek(new Date())` — o fuso do PROCESSO. Num contêiner, isso é UTC;
 * no navegador de quem usa, é o fuso dele. Das 21h de sábado à meia-noite em
 * São Paulo, UTC já virou domingo: o servidor mandava a semana SEGUINTE, e a
 * hidratação corrigia para a semana certa. Quem abre a Agenda nesse intervalo
 * vê a semana errada até a página ganhar vida — e a consulta que o servidor
 * adiantou foi feita para o período errado, então o que ela trouxe é
 * descartado.
 *
 * Achado medindo o CI: quatro rodadas de `agenda-google-sync` em 2026-09-20
 * reprovaram com `Expected: not "2026-09-20"` dentro dessa janela. O teste foi
 * consertado em separado (o portão de hidratação); ISTO aqui é o produto.
 *
 * ═══ Por que uma função pura, e não a conta na página ═══════════════════════
 *
 * Porque a prova não pode depender do relógio de quem roda o teste. Com o
 * instante e o fuso como PARÂMETROS, a borda que quebrava — sábado 21:00 em São
 * Paulo — é um caso de teste de uma linha, verde em qualquer dia, em qualquer
 * máquina. Enquanto a conta morava dentro do render, a única forma de exercitá-la
 * era esperar a janela chegar.
 */

/** Domingo, como a grade desenha (`weekStartsOn: 0`). */
const DIAS_NA_SEMANA = 7;

export interface SemanaSemente {
  /** O instante em que começa o domingo local. */
  de: Date;
  /** O instante em que começa o domingo SEGUINTE — fim exclusivo. */
  ate: Date;
}

/**
 * A semana que contém `agora`, lida no `fuso` pedido.
 *
 * O fim é exclusivo e sai de `instanteDe`, não de "início + 7×24h": a semana
 * que atravessa a virada do horário de verão tem 167 ou 169 horas, e somar um
 * número fixo de horas erraria a última hora do último dia — justamente a que
 * alguém marca consulta.
 */
export function semanaSemente(agora: Date, fuso: string): SemanaSemente {
  const hoje = partesNoFuso(agora, fuso);
  const domingo = new Date(Date.UTC(hoje.ano, hoje.mes - 1, hoje.dia));
  domingo.setUTCDate(domingo.getUTCDate() - domingo.getUTCDay());

  const proximo = new Date(domingo);
  proximo.setUTCDate(proximo.getUTCDate() + DIAS_NA_SEMANA);

  const meiaNoiteLocal = (d: Date) =>
    instanteDe(
      { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), hora: 0 },
      fuso,
    );

  return { de: meiaNoiteLocal(domingo), ate: meiaNoiteLocal(proximo) };
}

/**
 * O DIA DE HOJE no fuso pedido, como a grade o desenha: `yyyy-MM-dd`.
 *
 * Existe para o CLIENTE poder ancorar no MESMO dia que o servidor, sem receber
 * um instante. Receber instante seria a armadilha: `domingo 00:00` em São Paulo
 * é `sábado 22:00` em UTC-5, e um `startOfWeek` sobre ele, em hora local do
 * navegador, cairia na semana ANTERIOR. O que atravessa a fronteira é a DATA;
 * quem a transforma em `Date` local é `ancoraLocalDoDia`, logo abaixo.
 */
export function diaDeHojeNoFuso(agora: Date, fuso: string): string {
  const p = partesNoFuso(agora, fuso);
  const dd = (n: number) => String(n).padStart(2, "0");
  return `${p.ano}-${dd(p.mes)}-${dd(p.dia)}`;
}

/**
 * A âncora local que representa aquele dia — ao MEIO-DIA, de propósito.
 *
 * A grade formata as chaves (`coluna-dia-…`) em hora local do navegador. Ancorar
 * à meia-noite deixaria a data a um passo de horário de verão de virar o dia
 * anterior; o meio-dia está a doze horas de qualquer borda que exista.
 */
export function ancoraLocalDoDia(dia: string): Date {
  const [ano, mes, d] = dia.split("-").map(Number);
  return new Date(ano!, mes! - 1, d!, 12, 0, 0, 0);
}
