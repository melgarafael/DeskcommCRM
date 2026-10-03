/**
 * A grade que ACEITA — a conta que decide se um bloco vazio pode virar
 * compromisso, e a frase que explica quando não pode.
 *
 * ─── Por que este módulo existe, e o que ele deliberadamente NÃO faz ─────
 *
 * Ele **não sabe** quem atende, que jornada foi publicada, que exceção bloqueou
 * o dia nem quanto buffer o tipo pede. Nada disso: a disponibilidade tem dono e
 * é `lib/agenda/horarios-livres.ts`, consumido por
 * `GET /api/v1/agenda/horarios-livres`. A grade **pergunta** a essa rota — a
 * mesma que o painel de marcação e o agente usam — e este módulo só posiciona a
 * resposta em cima de uma régua de pixels.
 *
 * A consequência é a que interessa: um bloco só é clicável quando existe um
 * horário PUBLICADO ali. Não por disciplina de quem escreve a tela, e sim por
 * construção — a tela não tem de onde tirar um instante que a regra não deu.
 * Se alguém reimplementasse a jornada aqui para "ir mais rápido", a agenda
 * passaria a oferecer horário que o agente recusa, e as duas telas do mesmo
 * produto discordariam sobre o que está livre.
 *
 * ─── A régua é de meia hora, e é uma escolha ────────────────────────────
 *
 * O passo dos horários publicados NÃO é fixo: `horariosLivres()` usa
 * `tipo.intervaloMin ?? tipo.duracaoMin`, então uma organização oferece de 20
 * em 20 minutos e outra de hora em hora. Desenhar a camada clicável no passo do
 * tipo faria a grade mudar de geometria conforme o tipo escolhido, e o alvo de
 * toque de um tipo de 15 minutos teria 12px de altura — metade do mínimo que se
 * acerta com o polegar.
 *
 * Então a camada é fixa em meia hora (24px na régua de 48px/hora), e cada
 * célula OFERECE o primeiro horário publicado que começa dentro dela. A célula
 * nunca inventa um instante: ou ela devolve um horário que veio da rota, ou ela
 * não é clicável.
 */

/** A régua da camada de marcação, em minutos. Ver o cabeçalho. */
import { partesNoFuso } from "@/lib/agenda/fuso";

/** A régua da camada de marcação, em minutos. Ver o cabeçalho. */
export const PASSO_DA_CELULA_MIN = 30;

/** Um horário oferecido pela rota — a mesma forma que o painel de marcação usa. */
export interface HorarioPublicado {
  /** ISO-8601 do início. */
  instante: string;
  /** Rótulo já formatado no fuso de apresentação (ex.: "09:30"). */
  rotulo: string;
}

/**
 * Por que a grade INTEIRA está travada, quando está — os mesmos três estados
 * que `PainelDeMarcacao` distingue, e pela mesma razão: "você não publicou
 * horários", "não consegui carregar" e "não há vaga" chegam à tela como a mesma
 * lista vazia, e responder "nenhum horário disponível" para quem nunca
 * configurou nada é verdadeiro e inútil.
 */
export type MotivoDaGradeTravada = "sem-jornada" | "erro" | "sem-vaga";

/**
 * O minuto do dia (desde a meia-noite) que um horário publicado ocupa.
 *
 * ⚠️ ERA `d.getHours()` — o relógio do NAVEGADOR. Com a grade agora desenhada no
 * fuso da organização, esta conta ficou sendo a ÚNICA do arquivo ainda lida no
 * fuso errado, e ela alimenta as três portas: `horarioNaCelula` (em que linha a
 * célula cai), `alvoDoArraste` (para onde o card solto pode ir) e
 * `publicadoVizinho` (para onde a seta pula).
 *
 * O sintoma é o pior tipo: nada falha. Com o navegador em outro fuso que a org,
 * `rotulo` (já no fuso da apresentação) dizia "10:00" enquanto a linha calculada
 * aqui era a das 09:00 — e no arraste a tolerância de 30 min não alcançava o
 * publicado, devolvia `null` e o fantasma nem aparecia.
 */
function minutoDoDia(iso: string, fuso: string): number {
  const p = partesNoFuso(new Date(iso), fuso);
  return p.hora * 60 + p.minuto;
}

/**
 * O horário publicado que uma célula oferece — o mais CEDO que começa dentro
 * dela, ou `null` quando não há nenhum.
 *
 * O intervalo é fechado no início e aberto no fim (`[inicio, inicio + passo)`),
 * senão o horário das 09:30 seria oferecido por duas células e um clique em
 * cada uma marcaria o mesmo instante — duas portas para a mesma porta.
 */
export function horarioNaCelula(
  publicados: readonly HorarioPublicado[],
  celulaMinuto: number,
  fuso: string,
  passoMin: number = PASSO_DA_CELULA_MIN,
): HorarioPublicado | null {
  let escolhido: HorarioPublicado | null = null;
  let melhor = Number.POSITIVE_INFINITY;
  for (const h of publicados) {
    const m = minutoDoDia(h.instante, fuso);
    if (m < celulaMinuto || m >= celulaMinuto + passoMin) continue;
    if (m < melhor) {
      melhor = m;
      escolhido = h;
    }
  }
  return escolhido;
}

/**
 * Para onde um card arrastado pode ir — o horário publicado mais próximo do
 * ponto onde o ponteiro soltou, dentro da tolerância. `null` quer dizer "não
 * dá", e quem chamou tem de RECUSAR em vez de aproximar.
 *
 * A tolerância é o que transforma um gesto impreciso (soltar a 09:34) num
 * instante da regra (09:30) sem nunca sair da disponibilidade publicada: fora
 * dela não existe candidato, então não existe remarcação. É o mesmo princípio
 * da célula — a tela não tem de onde tirar um instante que a regra não deu.
 *
 * Empate (o ponto cai exatamente entre dois publicados) resolve para o MAIS
 * CEDO, e não é arbitrário: arrastar meio bloco para baixo e cair no horário
 * anterior é reversível com outro arrasto; ganhar meia hora sem pedir é o tipo
 * de surpresa que faz a pessoa desconfiar do gesto inteiro.
 */
export function alvoDoArraste(
  publicados: readonly HorarioPublicado[],
  minutoAlvo: number,
  fuso: string,
  toleranciaMin: number = PASSO_DA_CELULA_MIN,
): HorarioPublicado | null {
  let escolhido: HorarioPublicado | null = null;
  let melhor = Number.POSITIVE_INFINITY;
  for (const h of publicados) {
    const distancia = Math.abs(minutoDoDia(h.instante, fuso) - minutoAlvo);
    if (distancia > toleranciaMin) continue;
    if (distancia < melhor) {
      melhor = distancia;
      escolhido = h;
    }
  }
  return escolhido;
}

/**
 * O horário publicado seguinte (ou anterior) a um minuto do dia.
 *
 * ⚠️ ESTA FUNÇÃO EXISTE PORQUE O TECLADO TRAVAVA, e o teste é quem contou.
 *
 * A primeira versão do caminho por teclado somava meia hora à proposta corrente
 * e reencaixava com `alvoDoArraste`. Só que a proposta corrente JÁ está
 * encaixada: de 14:00, somar 30 dá 14:30, que empata entre 14:00 e 15:00 e
 * resolve para o mais cedo — 14:00 de novo. Apertar a seta dez vezes não movia
 * o card um minuto, e a tela não tinha como dizer isso: o fantasma aparecia,
 * válido, no lugar de sempre.
 *
 * Encaixar é a resposta certa para o PONTEIRO, que aponta para um pixel
 * arbitrário; para o teclado a pergunta é outra — "qual é o próximo horário que
 * existe?" —, e é essa que esta função responde. De quebra, ela dá a quem
 * navega por teclado a informação que o arraste dá pelos olhos: onde estão as
 * vagas. Pular de vaga em vaga é mais rápido do que varrer meia hora por vez.
 */
export function publicadoVizinho(
  publicados: readonly HorarioPublicado[],
  minutoAtual: number,
  direcao: 1 | -1,
  fuso: string,
): HorarioPublicado | null {
  let escolhido: HorarioPublicado | null = null;
  let melhor = Number.POSITIVE_INFINITY;
  for (const h of publicados) {
    const distancia = (minutoDoDia(h.instante, fuso) - minutoAtual) * direcao;
    // Estritamente adiante: `> 0` e não `>= 0`, senão o horário em que já
    // estamos seria sempre o vizinho e a seta nunca sairia do lugar.
    if (distancia <= 0) continue;
    if (distancia < melhor) {
      melhor = distancia;
      escolhido = h;
    }
  }
  return escolhido;
}

/**
 * A razão de um bloco vazio não aceitar marcação, na voz de quem está olhando
 * para ele.
 *
 * ⚠️ Ela deriva da MESMA conta que apaga o bloco (`horarioNaCelula() === null`),
 * e o padrão vem de `PainelDeMarcacao`, que pagou este defeito: lá o dia era
 * desabilitado por um booleano e o aviso dependia de OUTRO, então havia estado
 * em que a grade travava sem dizer nada — 42 dias mortos, aviso nenhum. Dois
 * booleanos independentes voltam a divergir; um só, não.
 *
 * A ordem é do MAIS ESPECÍFICO para o mais geral, porque a frase útil é a que
 * diz o que fazer em seguida: "já há um compromisso" manda olhar o compromisso,
 * "você ainda não publicou" manda configurar, e "fora dos horários" é o que
 * sobra quando não há nada mais preciso a dizer.
 */
export function razaoDoBloco(entrada: {
  motivo: MotivoDaGradeTravada | null;
  /** Um compromisso já cobre este instante. */
  ocupado: boolean;
  /** O instante já passou — não há o que marcar no passado. */
  passado: boolean;
}): string {
  if (entrada.passado) return "este horário já passou";
  if (entrada.ocupado) return "já há um compromisso neste horário";
  if (entrada.motivo === "sem-jornada") return "você ainda não publicou seus horários";
  if (entrada.motivo === "erro") return "não consegui carregar os horários";
  return "fora dos horários que você publicou";
}

/**
 * O minuto do dia sob uma coordenada Y dentro do corpo de uma coluna.
 *
 * Fica aqui, e não no componente, porque é a tradução pixel→tempo que o arraste
 * e o teste de geometria têm de concordar. Duas implementações da mesma régua
 * divergiriam no arredondamento, e a divergência apareceria como "o card caiu
 * uma faixa acima" — que é indistinguível de defeito de posicionamento.
 */
export function minutoSobY(entrada: {
  y: number;
  alturaDaHoraPx: number;
  primeiraHora: number;
}): number {
  return entrada.primeiraHora * 60 + (entrada.y / entrada.alturaDaHoraPx) * 60;
}

/** O começo da célula de meia hora que contém um minuto do dia. */
export function celulaQueContem(
  minuto: number,
  passoMin: number = PASSO_DA_CELULA_MIN,
): number {
  return Math.floor(minuto / passoMin) * passoMin;
}
