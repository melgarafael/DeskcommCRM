/**
 * A CONTA QUE DECIDE SE UM BLOCO VAZIO ACEITA MARCAÇÃO.
 *
 * ─── Por que estes casos, e não "renderizou" ─────────────────────────────
 *
 * A grade interativa tem um jeito de errar que NÃO dá erro nenhum: oferecer um
 * horário que a disponibilidade publicada não tem. A tela abre o painel, o
 * painel confirma, o POST volta 422 `agenda_disponibilidade_invalida` — e quem
 * usou não tem o que reportar além de "não deu". É o mesmo formato do defeito
 * que `PainelDeMarcacao` já pagou (a tela oferecia a agenda de um e marcava na
 * de outro), e a defesa é a mesma: o instante NUNCA é calculado pela tela, ele é
 * escolhido entre os que a rota devolveu.
 *
 * Estes casos fixam justamente as bordas onde "escolher entre os publicados"
 * poderia virar "inventar":
 *
 *   • o intervalo da célula é `[inicio, inicio + 30)` — fechado no começo,
 *     aberto no fim. Fosse fechado dos dois lados, o horário das 09:30 seria
 *     oferecido pela célula das 09:00 E pela das 09:30, e dois cliques em
 *     lugares diferentes marcariam o mesmo instante;
 *   • soltar um card fora da tolerância NÃO aproxima para o publicado mais
 *     perto — devolve `null`, e quem chamou recusa. Um "aproximar" generoso
 *     remarcaria para 08:00 um card solto às 03:00 da manhã;
 *   • a razão do bloqueio sai da MESMA entrada que apaga o bloco. Foi assim que
 *     o painel deixou de travar em silêncio.
 *
 * O relógio é injetado em todo caso: os instantes são construídos a partir de
 * `DIA`, uma constante. Esta base já pagou o preço de invariante que passa de
 * manhã e reprova de madrugada.
 */
import { describe, expect, it } from "vitest";

import { instanteDe } from "@/lib/agenda/fuso";

import {
  PASSO_DA_CELULA_MIN,
  alvoDoArraste,
  celulaQueContem,
  horarioNaCelula,
  minutoSobY,
  publicadoVizinho,
  razaoDoBloco,
  type HorarioPublicado,
} from "@/lib/agenda/grade-interativa";

/** Quarta-feira. A data não importa — o que importa é a hora de parede. */
const DIA = "2026-08-26";

/**
 * O fuso que a grade desenha — e que as contas abaixo têm de ler.
 *
 * A escolha de um fuso EXPLÍCITO, e não o do runtime, é o que faz o teste
 * sobreviver a quem roda com `TZ` diferente. Antes, `instante` era um ISO sem
 * offset e o `minutoDoDia` lia o relógio do navegador: o caso passava por
 * acidente e reproduzia o mesmo defeito da tela.
 */
const FUSO = "America/Sao_Paulo";

function publicado(hhmm: string): HorarioPublicado {
  const [h, m] = hhmm.split(":").map(Number);
  const [ano, mes, dia] = DIA.split("-").map(Number);
  const instante = instanteDe(
    { ano: ano!, mes: mes!, dia: dia!, hora: h, minuto: m },
    FUSO,
  );
  return { instante: instante.toISOString(), rotulo: hhmm };
}

/** Minutos desde a meia-noite, para escrever os casos na linguagem do relógio. */
function minuto(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

describe("horarioNaCelula — a célula oferece, nunca inventa", () => {
  const publicados = [publicado("09:00"), publicado("09:20"), publicado("09:40"), publicado("14:00")];

  it("devolve o horário que começa no início da célula", () => {
    expect(horarioNaCelula(publicados, minuto("09:00"), FUSO)?.rotulo).toBe("09:00");
  });

  it("devolve o MAIS CEDO quando dois publicados caem na mesma célula", () => {
    // Passo de 20min numa régua de 30: 09:00 e 09:20 dividem a mesma célula.
    // Oferecer o segundo faria o clique no topo do bloco marcar mais tarde do
    // que o bloco mostra.
    expect(horarioNaCelula(publicados, minuto("09:00"), FUSO)?.rotulo).toBe("09:00");
    expect(horarioNaCelula(publicados, minuto("09:30"), FUSO)?.rotulo).toBe("09:40");
  });

  it("NÃO oferece o horário que começa exatamente no fim da célula", () => {
    // ⚠️ A BORDA É 09:30, e a primeira versão deste caso usava 09:40 — que está
    // FORA da célula das 09:00 por dez minutos e passaria com qualquer
    // comparação. Sabotei o `>=` para `>` e os 14 casos seguiram verdes: o
    // teste do fim da célula não tocava no fim da célula.
    //
    // Com 09:30 a asserção fica presa ao operador: fechado dos dois lados, o
    // mesmo instante é oferecido pela célula das 09:00 E pela das 09:30, e dois
    // cliques em blocos diferentes marcam a mesma coisa.
    const so0930 = [publicado("09:30")];
    expect(horarioNaCelula(so0930, minuto("09:00"), FUSO)).toBeNull();
    expect(horarioNaCelula(so0930, minuto("09:30"), FUSO)?.rotulo).toBe("09:30");
  });

  it("devolve null onde a disponibilidade não publicou nada", () => {
    expect(horarioNaCelula(publicados, minuto("11:00"), FUSO)).toBeNull();
    expect(horarioNaCelula([], minuto("09:00"), FUSO)).toBeNull();
  });
});

describe("alvoDoArraste — soltar perto encaixa, soltar longe recusa", () => {
  const publicados = [publicado("09:00"), publicado("10:00"), publicado("15:00")];

  it("encaixa no publicado mais próximo dentro da tolerância", () => {
    expect(alvoDoArraste(publicados, minuto("09:14"), FUSO)?.rotulo).toBe("09:00");
    expect(alvoDoArraste(publicados, minuto("09:50"), FUSO)?.rotulo).toBe("10:00");
  });

  it("RECUSA quando nada publicado está dentro da tolerância", () => {
    // 03:00 da manhã: o publicado mais perto está a seis horas. Aproximar aqui
    // remarcaria o compromisso de alguém para as 09:00 sem que ninguém pedisse.
    expect(alvoDoArraste(publicados, minuto("03:00"), FUSO)).toBeNull();
    // E logo depois da borda da tolerância — 30min de 09:00 é 09:30, e 09:31 já
    // está fora dos dois vizinhos por mais de meia hora? Não: 10:00 está a 29.
    // O caso honesto é o vão do meio-dia.
    expect(alvoDoArraste(publicados, minuto("12:00"), FUSO)).toBeNull();
  });

  it("empate resolve para o mais cedo", () => {
    // 09:30 está a exatos 30min de 09:00 e de 10:00. Ganhar meia hora sem pedir
    // é a surpresa que faz desconfiar do gesto; perder é reversível arrastando
    // de novo.
    expect(alvoDoArraste(publicados, minuto("09:30"), FUSO)?.rotulo).toBe("09:00");
  });

  it("lista vazia não tem alvo — nem o mais próximo de nada", () => {
    expect(alvoDoArraste([], minuto("09:00"), FUSO)).toBeNull();
  });
});

describe("publicadoVizinho — a seta do teclado salta de vaga em vaga", () => {
  const publicados = [publicado("09:00"), publicado("10:00"), publicado("15:00")];

  it("devolve a próxima vaga adiante, e não a que já está sob o card", () => {
    // ⚠️ ESTRITAMENTE adiante. Com `>=`, o horário atual seria sempre o próprio
    // vizinho e a seta nunca sairia do lugar — que foi o defeito medido: a
    // primeira versão do teclado somava meia hora e reencaixava, o empate
    // resolvia para trás, e o card ficava parado com o fantasma válido em cima
    // dele.
    expect(publicadoVizinho(publicados, minuto("09:00"), 1, FUSO)?.rotulo).toBe("10:00");
    expect(publicadoVizinho(publicados, minuto("10:00"), -1, FUSO)?.rotulo).toBe("09:00");
  });

  it("de um minuto sem vaga, pega a mais próxima na direção pedida", () => {
    expect(publicadoVizinho(publicados, minuto("09:30"), 1, FUSO)?.rotulo).toBe("10:00");
    expect(publicadoVizinho(publicados, minuto("09:30"), -1, FUSO)?.rotulo).toBe("09:00");
  });

  it("devolve null na ponta — quem chama decide o que fazer sem vaga adiante", () => {
    expect(publicadoVizinho(publicados, minuto("15:00"), 1, FUSO)).toBeNull();
    expect(publicadoVizinho(publicados, minuto("09:00"), -1, FUSO)).toBeNull();
    expect(publicadoVizinho([], minuto("09:00"), 1, FUSO)).toBeNull();
  });
});

describe("razaoDoBloco — a frase sai da mesma entrada que apaga o bloco", () => {
  const base = { motivo: null, ocupado: false, passado: false } as const;

  it("passado vence tudo: não há o que marcar atrás", () => {
    expect(razaoDoBloco({ ...base, passado: true, ocupado: true, motivo: "sem-jornada" })).toBe(
      "este horário já passou",
    );
  });

  it("ocupado é mais informativo que 'sem vaga', e vence", () => {
    expect(razaoDoBloco({ ...base, ocupado: true })).toBe("já há um compromisso neste horário");
  });

  it("distingue jornada não publicada de consulta quebrada de sem vaga", () => {
    // Os três chegam à tela como a mesma lista vazia. Dizer "nenhum horário
    // disponível" para quem nunca configurou nada é verdadeiro e inútil.
    expect(razaoDoBloco({ ...base, motivo: "sem-jornada" })).toBe(
      "você ainda não publicou seus horários",
    );
    expect(razaoDoBloco({ ...base, motivo: "erro" })).toBe("não consegui carregar os horários");
    expect(razaoDoBloco({ ...base, motivo: "sem-vaga" })).toBe(
      "fora dos horários que você publicou",
    );
  });

  it("sem motivo nenhum, a frase ainda diz algo — nunca cai em vazio", () => {
    // O bloco pode estar apagado num dia com vagas: é o horário FORA das faixas
    // publicadas. Frase vazia aqui devolveria o defeito original do painel.
    expect(razaoDoBloco(base)).not.toBe("");
  });
});

describe("a régua de pixels — a mesma tradução para o arraste e para o teste", () => {
  it("converte Y em minuto do dia com a janela da grade", () => {
    // 48px por hora, primeira hora 7. O topo é 07:00; 24px abaixo, 07:30.
    expect(minutoSobY({ y: 0, alturaDaHoraPx: 48, primeiraHora: 7 })).toBe(minuto("07:00"));
    expect(minutoSobY({ y: 24, alturaDaHoraPx: 48, primeiraHora: 7 })).toBe(minuto("07:30"));
    expect(minutoSobY({ y: 48 * 7, alturaDaHoraPx: 48, primeiraHora: 7 })).toBe(minuto("14:00"));
  });

  it("a célula que contém um minuto quebrado é a de meia hora abaixo dele", () => {
    expect(celulaQueContem(minuto("09:29"))).toBe(minuto("09:00"));
    expect(celulaQueContem(minuto("09:30"))).toBe(minuto("09:30"));
    expect(PASSO_DA_CELULA_MIN).toBe(30);
  });
});
