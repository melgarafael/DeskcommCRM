/**
 * As duas peças puras do editor da jornada (issue #2312): o BOTÃO de copiar e
 * o RESUMO do que foi publicado.
 *
 * O defeito que estas funções existem para consertar estava medido na issue:
 * no primeiro salvamento só a segunda-feira ficou gravada (`windows` só com
 * `dow: 1`), a pessoa achava que preencheu a semana e a grade da Agenda só
 * oferecia horário às segundas, sem aviso nenhum. Duas metades, e as duas
 * estão aqui:
 *
 *   `copiarParaDiasUteis`   — a semana vira uma só, sem digitar dia a dia;
 *   `resumoDaJornada`       — o que SAIU GRAVADO, para conferir antes de sair.
 *
 * O resumo é a parte mais frágil: ele tem de ler o retorno da gravação, não o
 * formulário. Ler o formulário reproduz o mesmo defeito com outra roupa — a
 * tela diz uma semana, o banco guarda um dia, e ninguém vê a diferença.
 * `tests/unit/editor-da-jornada-copia-e-resumo.test.tsx` prova essa separação.
 */
import type { ScheduleWindow } from "@/lib/schemas/routing";

/** dom=0 … sáb=6 (`scheduleWindowSchema`). Dias úteis: segunda(1) … sexta(5). */
export const DIAS_UTEIS = [1, 2, 3, 4, 5] as const;

/** Rótulos curtos da semana — os MESMOS que a coluna Horário já usa. */
export const ROTULOS_DOS_DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;

/**
 * Mesmo número do `.max(50)` de `availabilityScheduleSchema.windows`
 * (lib/schemas/routing.ts). A cópia multiplica janelas por dia, então é a única
 * conta que pode transformar um clique em erro de validação na hora de salvar.
 */
export const LIMITE_DE_JANELAS = 50;

type Tradutor = (texto: string) => string;

/**
 * Copia as faixas do dia-modelo para os outros dias úteis.
 *
 * O dia-modelo é o PRIMEIRO dia com janela na tela (a ordem em que a pessoa
 * digitou). Os demais dias úteis passam a ter exatamente as mesmas faixas —
 * SUBSTITUINDO o que estava lá, porque é o que o rótulo promete: "copiar estes
 * horários para os outros dias úteis" tem de acabar com dias diferentes, não
 * somar por cima deles. Sábado e domingo não são dias úteis e ficam intocados.
 *
 * Tudo isso acontece no rascunho do diálogo: nada é gravado antes de "Salvar"
 * e "Cancelar" desfaz, então substituir não custa dado nenhum.
 */
export function copiarParaDiasUteis(windows: ScheduleWindow[]): ScheduleWindow[] {
  if (windows.length === 0) return windows;

  const diaModelo = windows[0]?.dow;
  if (diaModelo === undefined) return windows;
  const faixas = windows
    .filter((w) => w.dow === diaModelo)
    .map(({ start, end }) => ({ start, end }));

  const alvos: number[] = DIAS_UTEIS.filter((dow) => dow !== diaModelo);
  const preservadas = windows.filter((w) => !alvos.includes(w.dow));
  const copiadas = alvos.flatMap((dow) => faixas.map((faixa) => ({ dow, ...faixa })));

  return [...preservadas, ...copiadas];
}

/**
 * Há o que copiar, e cabe no limite da rota? Se não, o botão fica desligado —
 * sem janela nenhuma o clique não faria nada, e passar do limite viraria erro
 * ao salvar.
 */
export function podeCopiarParaDiasUteis(windows: ScheduleWindow[]): boolean {
  return windows.length > 0 && copiarParaDiasUteis(windows).length <= LIMITE_DE_JANELAS;
}

/**
 * O resumo do que foi GRAVADO, uma linha por faixa: `Seg–Sex 08:00–11:30`.
 *
 * Dias com a MESMA faixa viram um trecho (`Seg–Sex`, ou `Seg, Sex` quando não
 * são vizinhos) para a semana caber em duas linhas; cada faixa vira a sua
 * linha. Nenhum dia some: o que decide é o conjunto de dias gravados, não o
 * intervalo — `Seg, Qui` tem de aparecer como `Seg, Qui`, nunca como `Seg–Qui`.
 */
export function resumoDaJornada(windows: ScheduleWindow[], t: Tradutor): string[] {
  if (windows.length === 0) return [t("Não publicado")];

  const diasPorFaixa = new Map<string, Set<number>>();
  for (const w of windows) {
    const faixa = `${w.start}–${w.end}`;
    const dias = diasPorFaixa.get(faixa) ?? new Set<number>();
    dias.add(w.dow);
    diasPorFaixa.set(faixa, dias);
  }

  return [...diasPorFaixa].map(([faixa, dows]) => `${rotularDias([...dows], t)} ${faixa}`);
}

/** `1,2,3,5` → `Seg–Sex, Sáb`… vizinhos viram trecho, o resto vira lista. */
function rotularDias(dows: number[], t: Tradutor): string {
  const ordenados = [...new Set(dows)].sort((a, b) => a - b);
  const pecas: string[] = [];
  let trecho: number[] = [];
  let anterior: number | null = null;

  for (const dow of ordenados) {
    if (anterior !== null && dow === anterior + 1) {
      trecho.push(dow);
    } else {
      if (trecho.length > 0) pecas.push(rotuloDoTrecho(trecho, t));
      trecho = [dow];
    }
    anterior = dow;
  }
  if (trecho.length > 0) pecas.push(rotuloDoTrecho(trecho, t));

  return pecas.join(", ");
}

/** Um trecho de dias vizinhos: `Seg–Sex`; um dia solto: `Seg`. */
function rotuloDoTrecho(trecho: number[], t: Tradutor): string {
  const primeiro = trecho[0];
  const ultimo = trecho[trecho.length - 1];
  if (primeiro === undefined || ultimo === undefined) return "";
  const doPrimeiro = t(ROTULOS_DOS_DIAS[primeiro] ?? "");
  const doUltimo = t(ROTULOS_DOS_DIAS[ultimo] ?? "");
  return trecho.length > 1 ? `${doPrimeiro}–${doUltimo}` : doPrimeiro;
}
