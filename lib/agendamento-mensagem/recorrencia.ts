/**
 * RECORRÊNCIA DA MENSAGEM AGENDADA — régua pura, sem banco e sem relógio.
 *
 * Opções da tela: diária, semanal, quinzenal, mensal, trimestral, semestral,
 * anual, "a cada N dias" e "nenhuma" (envio único). Cada ocorrência é calculada
 * a partir da DATA DE INÍCIO (âncora) + k × passo, na hora de parede do fuso
 * da organização. Calcular a partir da âncora, e não encadeando a anterior,
 * impede o desvio: uma mensal iniciada dia 31 cai no último dia de fevereiro e
 * volta ao dia 31 em março, em vez de ir encolhendo para o dia 28.
 */

export const RECORRENCIAS = [
  "nenhuma",
  "diaria",
  "semanal",
  "quinzenal",
  "mensal",
  "trimestral",
  "semestral",
  "anual",
  "a_cada_n_dias",
] as const;

export type Recorrencia = (typeof RECORRENCIAS)[number];

export interface RegraDeRecorrencia {
  recorrencia: Recorrencia;
  /** Obrigatório quando `recorrencia === "a_cada_n_dias"`, inteiro entre 1 e 365. */
  intervalo_dias?: number | null;
  /** Início da série: hora de parede local (fuso da organização), ISO `YYYY-MM-DDTHH:mm`. */
  inicio: string;
  /** Término opcional, mesma forma de `inicio`. Sem término, a série não acaba. */
  termino?: string | null;
  tz: string;
}

interface PartesLocais {
  ano: number;
  mes: number; // 1..12
  dia: number;
  hora: number;
  minuto: number;
}

const LIMITE_DE_OCORRENCIAS = 20_000;

/** Converte um instante em partes de relógio do fuso dado. */
export function partesNoFuso(instante: Date, tz: string): PartesLocais {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(instante).map((x) => [x.type, x.value]));
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour),
    minuto: Number(p.minute),
  };
}

/** Converte partes de relógio de um fuso para o instante correspondente. */
export function instanteDeLocal(p: PartesLocais, tz: string): Date {
  const alvo = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto);
  // Duas passadas bastam para fusos com horário de verão: ajusta pelo deslocamento medido.
  let instante = alvo;
  for (let i = 0; i < 2; i++) {
    const medido = partesNoFuso(new Date(instante), tz);
    const medidoUtc = Date.UTC(medido.ano, medido.mes - 1, medido.dia, medido.hora, medido.minuto);
    instante += alvo - medidoUtc;
  }
  return new Date(instante);
}

/** Soma meses preservando o dia quando existe, senão cai no último dia do mês. */
function somaMeses(p: PartesLocais, meses: number): PartesLocais {
  const total = p.ano * 12 + (p.mes - 1) + meses;
  const ano = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return { ...p, ano, mes, dia: Math.min(p.dia, ultimoDia) };
}

function somaDias(p: PartesLocais, dias: number): PartesLocais {
  const d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + dias));
  return { ...p, ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/** Ocorrência de índice k (0 = a própria data de início). */
function ocorrencia(ancora: PartesLocais, regra: RegraDeRecorrencia, k: number): PartesLocais {
  switch (regra.recorrencia) {
    case "diaria":
      return somaDias(ancora, k);
    case "semanal":
      return somaDias(ancora, 7 * k);
    case "quinzenal":
      return somaDias(ancora, 14 * k);
    case "mensal":
      return somaMeses(ancora, k);
    case "trimestral":
      return somaMeses(ancora, 3 * k);
    case "semestral":
      return somaMeses(ancora, 6 * k);
    case "anual":
      return somaMeses(ancora, 12 * k);
    case "a_cada_n_dias":
      return somaDias(ancora, (regra.intervalo_dias ?? 1) * k);
    case "nenhuma":
      return ancora;
  }
}

/** Lê "YYYY-MM-DDTHH:mm" como partes de relógio, sem depender do fuso do servidor. */
export function parseLocal(texto: string): PartesLocais {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(texto);
  if (!m) throw new Error("data_local_invalida");
  return { ano: +m[1]!, mes: +m[2]!, dia: +m[3]!, hora: +m[4]!, minuto: +m[5]! };
}

/** Confere a regra antes de gravar. Devolve o motivo ou `null` quando válida. */
export function motivoRegraInvalida(regra: RegraDeRecorrencia): string | null {
  if (!RECORRENCIAS.includes(regra.recorrencia)) return "recorrencia_desconhecida";
  if (regra.recorrencia === "a_cada_n_dias") {
    const n = regra.intervalo_dias;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 365) return "intervalo_dias_invalido";
  }
  try {
    const inicio = parseLocal(regra.inicio);
    if (regra.termino) {
      const termino = parseLocal(regra.termino);
      if (instanteDeLocal(termino, regra.tz) < instanteDeLocal(inicio, regra.tz)) return "termino_antes_do_inicio";
    }
  } catch {
    return "data_local_invalida";
  }
  return null;
}

/**
 * Próxima ocorrência ESTRITAMENTE depois de `depois`, ou `null` se a série
 * acabou (passou do término, ou é envio único já feito).
 *
 * Quem chama passa o instante do envio que acabou de sair. Se o worker ficou
 * parado e várias ocorrências venceram, a resposta pula as perdidas: a série
 * não vira uma rajada de mensagens atrasadas.
 */
export function proximaOcorrenciaDepois(regra: RegraDeRecorrencia, depois: Date): Date | null {
  const inicio = parseLocal(regra.inicio);
  const termino = regra.termino ? instanteDeLocal(parseLocal(regra.termino), regra.tz) : null;

  if (regra.recorrencia === "nenhuma") {
    const unico = instanteDeLocal(inicio, regra.tz);
    return unico > depois ? unico : null;
  }

  for (let k = 0; k < LIMITE_DE_OCORRENCIAS; k++) {
    const instante = instanteDeLocal(ocorrencia(inicio, regra, k), regra.tz);
    if (termino && instante > termino) return null;
    if (instante > depois) return instante;
  }
  return null;
}

/** Primeira ocorrência da série (o horário que o usuário escolheu). */
export function primeiraOcorrencia(regra: RegraDeRecorrencia): Date {
  return instanteDeLocal(parseLocal(regra.inicio), regra.tz);
}
