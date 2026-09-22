/**
 * A PROJEÇÃO DE VENDAS — serviço puro, testável sem UI nem banco.
 *
 * Três métodos, do mais honesto ao mais ambicioso, e o retorno DIZ qual foi
 * usado (§46–47 do padrão): a tela mostra o método, não só o número.
 *
 * - `sem_dados`: nada vendido e sem histórico — projetar seria inventar.
 * - `ritmo`: média diária × dias restantes (fallback sempre disponível).
 * - `historico`: pondera por dia da semana com o histórico recente — só quando
 *   há histórico SUFICIENTE (60+ dias com vendas em metade deles, no mínimo).
 *
 * Centavos inteiros, Math.round nas médias. A apresentação arredonda para
 * centena ("≈ R$ 307,5 mil") — ilusão de precisão mora na tela, não aqui.
 */

export type MetodoProjecao = "sem_dados" | "ritmo" | "historico";

export interface EntradaProjecao {
  /** Vendido até hoje (centavos). */
  acumuladoCents: number;
  /** Dias transcorridos (hoje conta). */
  diasTranscorridos: number;
  /** Dias que o mês tem. */
  diasNoMes: number;
  /** Dia da semana de cada dia restante (0=domingo..6=sábado), na ordem. */
  diasRestantesDow: number[];
  /** Totais diários dos últimos dias (mais recente por último), em centavos. */
  historicoDiario: number[];
  /** Dia da semana de cada dia do histórico (alinhado a `historicoDiario`). */
  historicoDow: number[];
}

export interface ResultadoProjecao {
  metodo: MetodoProjecao;
  projetadoCents: number;
  mediaDiariaCents: number;
  /** Faixa provável [piso, teto] — só no método histórico. */
  faixa: [number, number] | null;
  /** Expectativa dia a dia dos restantes, alinhada a `diasRestantesDow`. */
  restantePorDia: number[];
}

const MIN_DIAS_HISTORICO = 60;
const MIN_COBERTURA = 0.5;

function media(valores: number[]): number {
  if (valores.length === 0) return 0;
  return Math.round(valores.reduce((s, v) => s + v, 0) / valores.length);
}

export function projetarVendas(e: EntradaProjecao): ResultadoProjecao {
  const restantes = Math.max(0, e.diasNoMes - e.diasTranscorridos);
  const mediaDiaria = e.diasTranscorridos > 0 ? Math.round(e.acumuladoCents / e.diasTranscorridos) : 0;

  const historicoUtil =
    e.historicoDiario.length >= MIN_DIAS_HISTORICO &&
    e.historicoDiario.filter((v) => v > 0).length / e.historicoDiario.length >= MIN_COBERTURA;

  if (e.acumuladoCents === 0 && !historicoUtil) {
    return { metodo: "sem_dados", projetadoCents: 0, mediaDiariaCents: 0, faixa: null, restantePorDia: [] };
  }

  if (historicoUtil && restantes > 0) {
    // Expectativa por dia da semana a partir do histórico.
    const porDow: number[][] = [[], [], [], [], [], [], []];
    e.historicoDiario.forEach((v, i) => {
      porDow[e.historicoDow[i] ?? 0]?.push(v);
    });
    const esperadoDow = porDow.map((lista) => (lista.length > 0 ? media(lista) : mediaDiaria));
    const restantePorDia = e.diasRestantesDow.map((dow) => esperadoDow[dow] ?? mediaDiaria);
    const somaRestante = restantePorDia.reduce((s, v) => s + v, 0);
    const projetado = e.acumuladoCents + somaRestante;
    // Faixa: ±1 desvio-padrão diário escalado pela raiz dos dias restantes.
    // É intervalo honesto de dispersão, não promessa.
    const todos = e.historicoDiario;
    const m = media(todos);
    const variancia = todos.reduce((s, v) => s + (v - m) * (v - m), 0) / todos.length;
    const margem = Math.round(Math.sqrt(variancia * restantes));
    return {
      metodo: "historico",
      projetadoCents: projetado,
      mediaDiariaCents: mediaDiaria,
      faixa: [Math.max(0, projetado - margem), projetado + margem],
      restantePorDia,
    };
  }

  return {
    metodo: "ritmo",
    projetadoCents: e.acumuladoCents + mediaDiaria * restantes,
    mediaDiariaCents: mediaDiaria,
    faixa: null,
    restantePorDia: new Array(restantes).fill(mediaDiaria),
  };
}
