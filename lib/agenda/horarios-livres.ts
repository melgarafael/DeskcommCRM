/**
 * O motor de horários livres — função PURA, sem banco e sem relógio.
 *
 * ─── O que ele responde ────────────────────────────────────────────────────
 *
 * "Dado o que esta pessoa publicou como jornada, o que ela já tem marcado e as
 * regras deste tipo de agendamento, quais horários posso oferecer entre X e Y?"
 *
 * Nada aqui lê banco e nada aqui lê o relógio: `agora` é parâmetro. Duas
 * armadilhas que esta base já pagou justificam isso. A janela anti-banimento
 * usava `new Date()` cru e derrubava o `test:db` depois das 22h — CI vermelho de
 * madrugada, sem ninguém ter mudado uma linha. E teste que depende da hora do
 * dia mente nos dois sentidos: passa quando não devia e falha quando devia
 * passar.
 *
 ─── Duas grandezas que parecem uma: JANELA e INSTANTE ────────────────────
 *
 * 1. A janela do dia, no fuso da jornada — ou as exceções DISPONÍVEIS, que a
 *    substituem quando existem (o sábado excepcional vale no lugar da jornada).
 * 2. Faixas sobrepostas são UNIDAS antes de qualquer coisa (`unirFaixas`).
 * 3. A grade nasce no início da janela e NÃO SE MOVE, de `intervaloMin` em
 *    `intervaloMin`.
 * 4. Menos os ocupados. Compromisso, evento do Google e bloqueio por exceção
 *    são a MESMA coisa aqui (DECISÃO 12), com o buffer inflando o slot.
 * 5. Menos o que começa antes de `agora + avisoMinimo`.
 * 6. Menos o que passa de `agora + janelaDias`.
 *
 * ⚠️ NADA REPARTE A JANELA — e essa é a lição que custou uma versão inteira.
 *
 * A versão anterior tratava o bloqueio SUBTRAINDO-O da janela. Parece a mesma
 * coisa que removê-lo da grade, e não é: subtrair reparte, e o pedaço de depois
 * começa onde o bloqueio terminou. Uma reunião das 10:30 às 11:30 fazia a tarde
 * inteira ser oferecida às 12:30, 13:30, 14:30 — e o 17:00-18:00, inteiramente
 * livre, sumia. A MESMA reunião gravada como compromisso não fazia nada disso.
 * Duas formas de dizer a mesma coisa, dois resultados.
 *
 * Tentei consertar preservando uma âncora através dos cortes, e funcionava.
 * A decisão do maestro é melhor e é uma REMOÇÃO: fazer dois caminhos
 * concordarem exige disciplina e volta a divergir no primeiro caso que ninguém
 * previu; fazer os dois serem o mesmo caminho não tem como divergir.
 *
 * Ancorada na janela publicada, a lista oferecida é sempre a mesma — 09:00,
 * 10:00, 11:00 — e o que está ocupado apenas some dela. É o que o cal.com faz
 * (`slotInterval` e `offsetStart` só fazem sentido sobre uma âncora fixa) e é o
 * que o dono da agenda consegue prever.
 *
 * ─── A régua do `windows` vazio é OUTRA aqui ───────────────────────────────
 *
 * Ver `janelasDoDia`. Este é o ponto mais fácil de errar do arquivo inteiro.
 *
 * ─── Uma limitação declarada, porque ninguém a mediu como defeito ──────────
 *
 * **Nada aqui cruza a meia-noite.** Nem a jornada (`22:00`–`02:00` é uma janela
 * com `end < start`, descartada), nem a exceção, nem um slot que comece 23:30 e
 * termine 00:30. A limitação é SIMÉTRICA — não há um lado que funcione e outro
 * que não — e está escrita aqui para ser encontrada antes que alguém venda
 * atendimento noturno, e não depois. Medido pelo QAVivo.
 */
import type { ScheduleWindow } from "@/lib/schemas/routing";

import { diaDaSemanaLocal, diaLocalISO, instanteDe, type HoraDeParede } from "./fuso";

/**
 * A jornada semanal da pessoa — lida de `attendant_availability.schedule`, que
 * continua sendo a fonte ÚNICA. A agenda lê; não duplica.
 */
export interface JornadaDaAgenda {
  timezone: string;
  windows: ScheduleWindow[];
}

/**
 * Uma linha de `calendar_availability_exceptions`, já em vocabulário de domínio.
 *
 * ⚠️ A FAIXA É SEMPRE PREENCHIDA, inclusive quando o dia inteiro está bloqueado
 * — aí ela é `(0, 1440)`. Não é detalhe de serialização: numa UNIQUE do
 * Postgres, NULL não colide com NULL, então dois "dia 12 bloqueado" da mesma
 * pessoa passariam os dois, em silêncio, e a tela mostraria a exceção
 * duplicada. `(0, 1440)` é a mesma informação e colide como deve.
 */
export interface ExcecaoDeData {
  /**
   * Data local, `YYYY-MM-DD` — a mesma régua de `diaLocalISO`.
   *
   * ⚠️ A COLUNA NO BANCO CHAMA `exception_date`, não `date`. Os briefings da
   * entrega dizem `date`, e quem escrever a rota ou a query lendo o briefing usa
   * o nome errado. Achado do QAVivo, lendo a migration do Arquiteto.
   */
  data: string;
  /** `true` SUBTRAI a faixa do dia (ver `janelasDoDia`); não zera o dia por si só. */
  indisponivel: boolean;
  /** Minutos desde a meia-noite local. Dia inteiro é `0`…`1440`. */
  inicioMinuto: number;
  fimMinuto: number;
}

/** Um intervalo que já está tomado: agendamento do dono ou evento vindo do Google. */
export interface Ocupado {
  inicio: Date;
  fim: Date;
}

/** As regras do molde (`calendar_event_types`) que o motor precisa conhecer. */
export interface TipoDeAgendamento {
  duracaoMin: number;
  bufferAntesMin: number;
  bufferDepoisMin: number;
  /** Antecedência mínima para marcar (cal.com usa 120 por padrão). */
  avisoMinimoMin: number;
  /** Granularidade da grade. `null`/ausente ⇒ usa a duração. */
  intervaloMin?: number | null;
  /** Até quantos dias no futuro se pode marcar. */
  janelaDias: number;
}

/** Um horário oferecível. Instantes — quem exibe escolhe o fuso. */
export interface Slot {
  inicio: Date;
  fim: Date;
}

export interface EntradaDeHorariosLivres {
  jornada: JornadaDaAgenda;
  excecoes: ExcecaoDeData[];
  ocupados: Ocupado[];
  tipo: TipoDeAgendamento;
  de: Date;
  ate: Date;
  /** INJETADO. Nunca `new Date()` aqui dentro. */
  agora: Date;
}

const MINUTO = 60_000;
const DIA = 86_400_000;

/** Faixa em minutos desde a meia-noite LOCAL (é assim que a jornada é escrita). */
export interface FaixaEmMinutos {
  inicio: number;
  fim: number;
}

/** Faixa em instantes (`getTime()`) — é assim que um compromisso existe. */
export interface FaixaEmInstantes {
  inicio: number;
  fim: number;
}

function hhmmParaMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * A data civil deslocada de N minutos, normalizada em UTC puro.
 *
 * O deslocamento é feito em UTC de propósito: UTC não tem horário de verão, e é
 * o único lugar onde somar minutos nunca muda de significado. O resultado é uma
 * hora de PAREDE (ano/mês/dia/hora/minuto), que só então vira instante no fuso
 * certo. Faz `24:00` virar meia-noite do dia seguinte sem caso especial.
 */
function paredeDeMinutos(ano: number, mes: number, dia: number, minuto: number): HoraDeParede {
  const base = new Date(Date.UTC(ano, mes - 1, dia, 0, 0, 0));
  base.setUTCMinutes(base.getUTCMinutes() + minuto);
  return {
    ano: base.getUTCFullYear(),
    mes: base.getUTCMonth() + 1,
    dia: base.getUTCDate(),
    hora: base.getUTCHours(),
    minuto: base.getUTCMinutes(),
  };
}

/**
 * Funde faixas que se sobrepõem ou se encostam, preservando a âncora da mais
 * à esquerda.
 *
 * ⚠️ NADA IMPEDE SOBREPOSIÇÃO A MONTANTE: o Zod valida `start < end` DENTRO de
 * cada janela e o array só tem `.max(50)`; a tela acrescenta janela sem checar;
 * a rota também não. E duas exceções disponíveis sobrepostas entram as duas —
 * a UNIQUE é por `start_minute`, e 540 ≠ 600.
 *
 * Sem esta união, `09:00–12:00` mais `10:00–13:00` gera 10:00 e 11:00 DUAS
 * vezes, e dois pacientes clicam em dois "10:00" que são o mesmo instante.
 *
 * **Sobreposição é inofensiva para quem TESTA pertinência e venenosa para quem
 * GERA.** `isWithinSchedule` usa `.some()`, e um OR responde `true` uma vez só —
 * por isso o roteamento conviveu com isso sem sintoma. A agenda é o primeiro
 * consumidor que GERA a partir de `schedule.windows`, e por isso esta função é
 * nomeada e exportável: a próxima peça que gerar herda o buraco se reimplementar
 * inline.
 */
export function unirFaixas(faixas: FaixaEmMinutos[]): FaixaEmMinutos[] {
  const ordenadas = [...faixas]
    .filter((f) => f.fim > f.inicio)
    .sort((a, b) => a.inicio - b.inicio || a.fim - b.fim);

  const unidas: FaixaEmMinutos[] = [];
  for (const faixa of ordenadas) {
    const ultima = unidas[unidas.length - 1];
    // `<=` funde também as contíguas: 09:00–12:00 e 12:00–18:00 são um bloco de
    // trabalho só, e a grade deve fluir através da emenda.
    if (ultima && faixa.inicio <= ultima.fim) {
      if (faixa.fim > ultima.fim) ultima.fim = faixa.fim;
      continue;
    }
    unidas.push({ ...faixa });
  }
  return unidas;
}

/**
 * As faixas de trabalho de um dia — e o ponto onde a agenda diverge do roteamento.
 *
 * ⚠️ `windows` VAZIO SIGNIFICA COISAS OPOSTAS NOS DOIS USOS DESTA MESMA COLUNA:
 *
 * | Quem lê | vazio quer dizer | por quê |
 * |---|---|---|
 * | `isWithinSchedule` (roteamento, em produção) | 24/7, aceita | mensagem chega a qualquer hora, e janela existe para RESTRINGIR |
 * | aqui (agenda) | nada publicado ⇒ zero horário | agenda 24/7 ofereceria consulta às 3 da manhã |
 *
 * Por isso esta função existe em vez de reusar `isWithinSchedule` — que tem
 * consumidor em produção e não deve mudar. Quem quiser "unificar as duas" daqui
 * a seis meses está prestes a oferecer madrugada para o paciente de alguém.
 *
 * ─── Os três passos, nesta ordem (DECISÃO 11) ──────────────────────────────
 *
 * 1. **Base**: as janelas da jornada semanal daquele dia.
 * 2. **Exceções DISPONÍVEIS** substituem a base, se houver ao menos uma — é o
 *    sábado excepcional, que vale NO LUGAR da jornada, não somado a ela.
 * 3. **Exceções INDISPONÍVEIS** subtraem do que sobrou.
 *
 * "Dia inteiro bloqueado" NÃO é caso especial: é subtrair `(0, 1440)`, e o
 * resultado é vazio pela regra geral. A versão anterior desta função fazia
 * `if (algumaIndisponivel) return []`, e com a faixa preenchida isso virou um
 * defeito: quem bloqueasse duas horas perdia o dia inteiro.
 *
 * ⚠️ CONSEQUÊNCIA CONHECIDA E ACEITA: um `(0, 1440)` indisponível VENCE uma
 * exceção disponível do mesmo dia, porque subtrai depois. Quem cadastrou "não
 * atendo" mais "mas das 9h às 12h sim" fica sem o dia. Inverter a ordem
 * consertaria este caso e quebraria o sábado excepcional do passo 2 — trocar um
 * defeito por outro não é conserto. Quem tem de avisar é a TELA, ao salvar a
 * segunda linha. Está fixado em teste, com o porquê no nome.
 */
function janelasDoDia(
  jornada: JornadaDaAgenda,
  excecoesDoDia: ExcecaoDeData[],
  dow: number,
): FaixaEmMinutos[] {
  const disponiveis = excecoesDoDia.filter((e) => !e.indisponivel);

  const base: FaixaEmMinutos[] =
    disponiveis.length > 0
      ? disponiveis.map((e) => ({ inicio: e.inicioMinuto, fim: e.fimMinuto }))
      : jornada.windows
          .filter((w) => w.dow === dow)
          .map((w) => ({ inicio: hhmmParaMinutos(w.start), fim: hhmmParaMinutos(w.end) }));

  return unirFaixas(base);
}

/**
 * O slot inflado pelos buffers — e é o SLOT que infla, não o compromisso.
 *
 * O campo promete folga ANTES do meu atendimento e DEPOIS dele. Inflar o
 * compromisso dá a mesma conta só enquanto os dois buffers são iguais; com
 * `antes = 60` e `depois = 0` as duas leituras divergem, e a que corresponde ao
 * que a tela promete é esta.
 */
function slotInflado(inicio: number, fim: number, tipo: TipoDeAgendamento): FaixaEmInstantes {
  return {
    inicio: inicio - tipo.bufferAntesMin * MINUTO,
    fim: fim + tipo.bufferDepoisMin * MINUTO,
  };
}

/**
 * Sobreposição estrita: encostar não é conflitar.
 *
 * Um compromisso que termina 09:00 não impede o slot que começa 09:00 — é o
 * comportamento que o dono da agenda espera, e quem quiser folga entre um e
 * outro configura o buffer, que é o campo feito para isso.
 *
 * Exportada para o ENCAIXE fora da grade (`exigeSemSobreposicao`, no handler de
 * agendamentos) — e lá ela é REDUNDANTE hoje. O filtro de `coletaOQueOcupa` já é
 * o mesmo cruzamento estrito (`starts_at < fim` e `ends_at > inicio`), então
 * tudo o que chega ao encaixe já cruza o pedido e esta chamada não muda o
 * desfecho. O encostado é decidido duas vezes, e cada uma sozinha basta:
 * afrouxar só uma das duas não deixa vermelho no caso "encostado" de
 * `tests/unit/pessoa-marca-fora-da-grade.test.ts`.
 *
 * A chamada fica pelo dia em que a janela de coleta for alargada — pelo buffer,
 * que é o conserto descrito em `exigeHorarioLivre`. Aí a coleta passa a trazer
 * vizinhos que NÃO cruzam o pedido, e esta é a régua que os separa; sem ela,
 * alargar a coleta faria o encaixe recusar o encostado.
 */
export function colide(inicio: number, fim: number, faixa: FaixaEmInstantes): boolean {
  return inicio < faixa.fim && fim > faixa.inicio;
}

export function horariosLivres(entrada: EntradaDeHorariosLivres): Slot[] {
  const { jornada, excecoes, ocupados, tipo, de, ate, agora } = entrada;
  const fuso = jornada.timezone;
  const passo = tipo.intervaloMin ?? tipo.duracaoMin;
  if (passo <= 0 || tipo.duracaoMin <= 0) return [];

  // Os dois cortes do tempo, resolvidos uma vez: o começo é o mais tarde entre
  // o que se pediu e o aviso mínimo; o fim, o mais cedo entre o que se pediu e
  // a janela de agendamento.
  const naoAntesDe = Math.max(de.getTime(), agora.getTime() + tipo.avisoMinimoMin * MINUTO);
  const naoDepoisDe = Math.min(ate.getTime(), agora.getTime() + tipo.janelaDias * DIA);
  if (naoAntesDe > naoDepoisDe) return [];

  // Os compromissos, em instantes. Os bloqueios por exceção entram por dia, no
  // laço — eles nascem em minutos de parede e só viram instante lá dentro.
  const compromissos: FaixaEmInstantes[] = ocupados.map((o) => ({
    inicio: o.inicio.getTime(),
    fim: o.fim.getTime(),
  }));

  const excecoesPorData = new Map<string, ExcecaoDeData[]>();
  for (const e of excecoes) {
    const doDia = excecoesPorData.get(e.data);
    if (doDia) doDia.push(e);
    else excecoesPorData.set(e.data, [e]);
  }

  // Caminhamos por DIA LOCAL, com um dia de margem de cada lado: o fuso desloca
  // as bordas, e o primeiro slot de um dia local pode cair no dia UTC anterior.
  const primeiro = diaLocalISO(new Date(naoAntesDe - DIA), fuso);
  const ultimo = diaLocalISO(new Date(naoDepoisDe + DIA), fuso);

  const slots: Slot[] = [];
  for (let dataISO = primeiro; dataISO <= ultimo; dataISO = diaSeguinte(dataISO)) {
    const { ano, mes, dia } = dataCivil(dataISO);

    // O meio-dia local como âncora do dia: é o instante que nunca cai numa
    // virada de horário de verão (elas acontecem de madrugada), então ler o dia
    // da semana a partir dele é seguro em qualquer fuso.
    const meioDia = instanteDe({ ano, mes, dia, hora: 12, minuto: 0 }, fuso);
    const dow = diaDaSemanaLocal(meioDia, fuso);

    const excecoesDoDia = excecoesPorData.get(dataISO) ?? [];
    const emInstantes = (f: FaixaEmMinutos | ExcecaoDeData): FaixaEmInstantes => {
      const inicio = "inicio" in f ? f.inicio : f.inicioMinuto;
      const fim = "inicio" in f ? f.fim : f.fimMinuto;
      return {
        inicio: instanteDe(paredeDeMinutos(ano, mes, dia, inicio), fuso).getTime(),
        fim: instanteDe(paredeDeMinutos(ano, mes, dia, fim), fuso).getTime(),
      };
    };

    // ⚠️ O BLOQUEIO POR EXCEÇÃO CONTA COMO OCUPADO PARA EFEITO DE BUFFER.
    //
    // Ele já saiu das faixas pela subtração — mas isso só impede o slot de cair
    // DENTRO dele. O buffer é outra pergunta: a dentista que pede 15 minutos
    // entre pacientes e bloqueia 12h-14h para o almoço não quer um paciente às
    // 11h, porque a esterilização dele invade o almoço dela. Sem esta linha o
    // buffer valia contra compromisso e não valia contra bloqueio — mesma
    // intenção, duas telas, dois resultados. Medido pelo QAVivo; a DECISÃO 11
    // criou o caso, porque antes dela a exceção zerava o dia e não havia borda
    // no meio do dia para o buffer atravessar.
    // ⚠️ O BLOQUEIO É UM OCUPADO — não uma janela menor (DECISÃO 12).
    //
    // A versão anterior SUBTRAÍA o bloqueio da janela, e subtrair repartia: uma
    // reunião das 10:30 às 11:30 fazia a segunda metade da janela começar às
    // 11:30, e o relógio inteiro da tarde andava meia hora. Compromisso nunca
    // fez isso, porque ele REMOVE INSTANTES em vez de REPARTIR A JANELA — as
    // duas coisas parecem a mesma e não são.
    //
    // Aqui os dois viram o MESMO mecanismo, e é por isso que a correção é uma
    // remoção de código: fazer dois caminhos concordarem exige disciplina e
    // volta a divergir no caso que ninguém previu; ser o mesmo caminho não tem
    // como divergir. O buffer passa a valer contra bloqueio de graça, pela
    // mesma razão.
    const bloqueiosDoDia = [
      ...compromissos,
      ...excecoesDoDia.filter((e) => e.indisponivel).map(emInstantes),
    ];

    for (const faixa of janelasDoDia(jornada, excecoesDoDia, dow)) {
      const fimDaFaixa = instanteDe(paredeDeMinutos(ano, mes, dia, faixa.fim), fuso).getTime();

      for (let minuto = faixa.inicio; ; minuto += passo) {
        const inicio = instanteDe(paredeDeMinutos(ano, mes, dia, minuto), fuso).getTime();
        const fim = inicio + tipo.duracaoMin * MINUTO;

        // O slot inteiro precisa caber na faixa publicada. Comparação em
        // INSTANTES, não em minutos de parede: numa virada de horário de verão
        // a faixa pode ter 3h de parede e 2h de mundo.
        if (fim > fimDaFaixa) break;

        if (inicio < naoAntesDe) continue;
        if (inicio > naoDepoisDe) break;

        const comFolga = slotInflado(inicio, fim, tipo);
        if (bloqueiosDoDia.some((b) => colide(comFolga.inicio, comFolga.fim, b))) continue;

        slots.push({ inicio: new Date(inicio), fim: new Date(fim) });
      }
    }
  }

  // ⚠️ DOIS HORÁRIOS NÃO PODEM SER O MESMO INSTANTE.
  //
  // No salto do horário de verão a hora que não existe desliza para depois do
  // salto (decisão de `fuso.ts`), e aterrissa em cima do slot seguinte: em Nova
  // York, 2026-03-08, as 02:00 e as 03:00 viram o mesmo `07:00Z`. Dois pacientes
  // escolheriam "o seu" 03:00 e cairiam no mesmo `timestamptz`, sem erro em
  // lugar nenhum. O Brasil não tem mais horário de verão, mas Santiago e
  // Assunção — que o produto oferece — têm.
  const porInstante = new Map<number, Slot>();
  for (const slot of slots) {
    if (!porInstante.has(slot.inicio.getTime())) porInstante.set(slot.inicio.getTime(), slot);
  }

  return [...porInstante.values()].sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

/** `YYYY-MM-DD` → data civil. Uma função só, para o tipo não virar `number | undefined`. */
function dataCivil(dataISO: string): { ano: number; mes: number; dia: number } {
  const [ano = 0, mes = 1, dia = 1] = dataISO.split("-").map(Number);
  return { ano, mes, dia };
}

/** Próxima data civil em `YYYY-MM-DD`, normalizada em UTC (sem horário de verão pelo caminho). */
function diaSeguinte(dataISO: string): string {
  const { ano, mes, dia } = dataCivil(dataISO);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + 1);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}`;
}
