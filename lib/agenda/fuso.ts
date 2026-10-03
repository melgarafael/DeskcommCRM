/**
 * Conversão de fuso da agenda — escrita UMA vez, e só aqui.
 *
 * ─── O problema ────────────────────────────────────────────────────────────
 *
 * A jornada de trabalho é escrita em **hora de parede**: "segunda, das 09:00 às
 * 12:00, no fuso America/Sao_Paulo". Um compromisso, não: ele é um **instante**
 * (`timestamptz`). Para saber se as 09:00 de segunda estão livres, o motor
 * precisa transformar hora de parede em instante — e essa conversão é a peça
 * que mais erra em software de agenda.
 *
 * ─── Por que não é uma subtração ───────────────────────────────────────────
 *
 * `instante = parede - offset` parece resolver, e não resolve: **o offset
 * depende do instante**, que é justamente o que se quer descobrir. Em horário
 * de verão o mesmo fuso vale -3 num dia e -2 no outro. Medido neste runtime:
 * `America/Sao_Paulo` era GMT-3 em 2018-11-03 e GMT-2 em 2018-11-05.
 *
 * A saída é duas passadas: converter com o offset de um palpite e recalcular o
 * offset no instante encontrado. As bordas do horário de verão são tratadas
 * explicitamente em `instanteDe` — leia o comentário de lá antes de "simplificar".
 *
 * ─── Por que `Intl` e não `date-fns-tz` ────────────────────────────────────
 *
 * `date-fns` está no repo; `date-fns-tz` não está, e a decisão da entrega é não
 * adicionar. `Intl.DateTimeFormat` já vem no runtime, já conhece as regras
 * históricas de cada zona, e já é o mecanismo que o roteamento usa em produção
 * (`localMoment`, lib/routing/eligibility). Uma dependência a menos para
 * auditar num produto que roda na VPS de quem instalou.
 */
import { localMoment } from "@/lib/routing/eligibility";

/**
 * Hora de parede: o que o relógio da parede mostra, sem dizer em que fuso.
 *
 * `hora`, `minuto` e `segundo` são OPCIONAIS e valem 0 quando ausentes — o que
 * torna `{ano, mes, dia}` a meia-noite daquele dia, que é como
 * `primeiroInstanteDoDia` (`lib/agenda/google/tempo.ts`) pergunta. A alternativa
 * era cada consumidor escrever `hora: 0, minuto: 0`, e um deles esquecer.
 */
export interface HoraDeParede {
  ano: number;
  /** 1-12 — mês do calendário, não o índice do `Date` do JS. */
  mes: number;
  dia: number;
  hora?: number;
  minuto?: number;
  segundo?: number;
}

/** O mesmo, já lido de um instante — com o segundo sempre presente. */
export type ParedeLida = Required<HoraDeParede>;

/**
 * Formatadores são caros de construir e o motor chama isto milhares de vezes
 * ao montar um mês de grade. Um por fuso, reaproveitado.
 */
const FORMATADORES = new Map<string, Intl.DateTimeFormat>();

function formatador(fuso: string): Intl.DateTimeFormat {
  const existente = FORMATADORES.get(fuso);
  if (existente) return existente;
  // Lança `RangeError` em fuso inexistente — de propósito. Quem chama já
  // validou com `fusoValido` (lib/tempo/fusos); silenciar aqui esconderia o
  // erro de digitação no lugar errado, que é o defeito que aquele arquivo conta.
  const novo = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  FORMATADORES.set(fuso, novo);
  return novo;
}

/** O que o relógio de parede daquele fuso mostrava neste instante. */
export function partesNoFuso(instante: Date, fuso: string): ParedeLida {
  const partes = formatador(fuso).formatToParts(instante);
  const numero = (tipo: Intl.DateTimeFormatPartTypes): number =>
    Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  return {
    ano: numero("year"),
    mes: numero("month"),
    dia: numero("day"),
    // ⚠️ `hourCycle: "h23"` é o que garante 00-23 aqui — medido neste runtime,
    // 24h × 5 fusos, nenhuma ocorrência de "24". A variante `hour12: false`
    // devolve 24 para a meia-noite, e trocar uma pela outra faria o dia inteiro
    // escorregar no motor sem nenhum teste reclamar.
    hora: numero("hour"),
    minuto: numero("minute"),
    segundo: numero("second"),
  };
}

/**
 * Offset do fuso NAQUELE instante, em minutos (São Paulo no inverno = -180).
 *
 * Não é constante por fuso: é isto que o horário de verão muda.
 */
export function offsetEmMinutos(instante: Date, fuso: string): number {
  const p = partesNoFuso(instante, fuso);
  const comoSeFosseUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  // O instante truncado ao segundo: `formatToParts` não devolve milissegundo, e
  // sem truncar o offset viria com fração e nunca bateria com o de referência.
  const instanteEmSegundos = Math.floor(instante.getTime() / 1000) * 1000;
  return (comoSeFosseUtc - instanteEmSegundos) / 60_000;
}

/** Preenche os campos ausentes com 0 — meia-noite é `{ano, mes, dia}`. */
function completa(parede: HoraDeParede): Required<HoraDeParede> {
  return {
    ano: parede.ano,
    mes: parede.mes,
    dia: parede.dia,
    hora: parede.hora ?? 0,
    minuto: parede.minuto ?? 0,
    segundo: parede.segundo ?? 0,
  };
}

function ehAHoraPedida(instante: Date, fuso: string, parede: Required<HoraDeParede>): boolean {
  const lida = partesNoFuso(instante, fuso);
  return (
    lida.ano === parede.ano &&
    lida.mes === parede.mes &&
    lida.dia === parede.dia &&
    lida.hora === parede.hora &&
    lida.minuto === parede.minuto
  );
}

/**
 * Hora de parede num fuso → o instante correspondente.
 *
 * ⚠️ AS DUAS BORDAS DO HORÁRIO DE VERÃO, e o que decidimos em cada uma:
 *
 * **A hora que não existe.** Na entrada do horário de verão o relógio pula:
 * em 2018-11-04, São Paulo foi de 00:00 direto para 01:00, e 00:30 daquele dia
 * nunca aconteceu. Devolvemos o **MAIOR** dos dois candidatos — o primeiro
 * instante que de fato existiu naquele dia. É o que `Temporal` chama de
 * `compatible`. **Nunca devolvemos `Invalid Date`**: uma janela de trabalho que
 * cai no salto tem que render algum horário, não derrubar a tela.
 *
 * ⚠️ ERA "FICA O PRIMEIRO", E ISSO ACERTAVA POR ACIDENTE. O sinal do offset
 * decide qual dos dois candidatos é o mais tarde: onde ele é NEGATIVO (as
 * Américas inteiras), o primeiro já é o maior, e devolvê-lo dá o mesmo
 * resultado. Onde é POSITIVO (Beirute, Teerã), a ordem se inverte e o primeiro
 * cai na VÉSPERA. Medido: `Asia/Beirut`, 2018-03-25, meia-noite — aquele dia
 * começou às 01:00, porque o relógio pulou de 23:59 do dia 24 direto para lá —
 * devolvia `2018-03-24T21:00:00Z`, que lido de volta é **dia 24 às 23:00**.
 *
 * Onde a virada é a meia-noite (Beirute, Havana, Santiago, e o Brasil até 2019),
 * "o início deste dia" é exatamente o que a agenda pede para exceção de data e
 * bloqueio de dia inteiro. Com a regra antiga o dia começaria na véspera, e a
 * agenda invadiria o dia anterior por uma hora. Um dia por ano, num fuso, e
 * ninguém liga uma coisa à outra.
 *
 * Achado do QAVivo, confirmado pelo maestro (DECISÃO 15) e reproduzido aqui
 * antes de aceitar. O critério que `lib/agenda/google/tempo.ts` escreve vale
 * mais que o vencedor: **não existe método sem escolha, existe escolha
 * explícita e escolha escondida** — e a certa é a que declara o que faz na
 * borda. Esta agora declara.
 *
 * **A hora que acontece duas vezes.** Na saída, o relógio volta: 23:30 pode
 * existir em dois instantes. Devolvemos o primeiro. Escolher é obrigatório;
 * escolher em silêncio é que não pode — está escrito aqui e tem teste.
 */
export function instanteDe(paredePedida: HoraDeParede, fuso: string): Date {
  const parede = completa(paredePedida);
  const alvo = Date.UTC(
    parede.ano,
    parede.mes - 1,
    parede.dia,
    parede.hora,
    parede.minuto,
    parede.segundo,
  );

  // 1ª passada: o offset lido no palpite (o alvo interpretado como se fosse UTC).
  const primeiro = alvo - offsetEmMinutos(new Date(alvo), fuso) * 60_000;
  if (ehAHoraPedida(new Date(primeiro), fuso, parede)) return new Date(primeiro);

  // 2ª passada: o offset lido no instante que a 1ª encontrou. Corrige o caso em
  // que o palpite caiu do outro lado de uma virada.
  const segundo = alvo - offsetEmMinutos(new Date(primeiro), fuso) * 60_000;
  if (ehAHoraPedida(new Date(segundo), fuso, parede)) return new Date(segundo);

  // Nenhuma das duas bate: a hora pedida não existe naquele dia (salto do
  // horário de verão). Fica o MAIOR — o primeiro instante que de fato existiu.
  // `Math.min` aqui devolveria a véspera em todo fuso de offset positivo.
  return new Date(Math.max(primeiro, segundo));
}

/**
 * O instante, redesenhado como se o NAVEGADOR estivesse no fuso pedido.
 *
 * Existe só para reusar `format` — e o `locale` da tela — sem depender de
 * `date-fns-tz`, que este repositório não instala. `format` lê o relógio local,
 * então devolvemos uma data cujo relógio local já é o parede do fuso alvo.
 * Com os dois fusos iguais — a maioria, e o CI inteiro — é a própria data.
 *
 * Era isto que faltava no painel: a grade desenhava no fuso da organização e a
 * confirmação lia o navegador, então quem clicava em 10:00 liu "às 09:00" ao
 * confirmar. Duas horas diferentes para o mesmo agendamento, na mesma tela.
 */
export function dataDeParede(instante: Date, fuso: string): Date {
  const p = partesNoFuso(instante, fuso);
  return new Date(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
}

/** O dia local (`YYYY-MM-DD`) daquele instante — a régua que casa com a exceção por data. */
export function diaLocalISO(instante: Date, fuso: string): string {
  const p = partesNoFuso(instante, fuso);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`;
}

/**
 * Dia da semana local, domingo = 0 — a mesma régua do `dow` da jornada.
 *
 * Delega para `localMoment`, que já responde exatamente isto e já sobreviveu em
 * produção ao bug do fuso com acento. Escrever outra seria duplicar a peça mais
 * fácil de errar do arquivo.
 */
export function diaDaSemanaLocal(instante: Date, fuso: string): number {
  return localMoment(instante, fuso).dow;
}
