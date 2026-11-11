/**
 * O RECUO DO POLLING DA FILA VAZIA (#3878, sugestão 1) — a conta, separada do
 * laço e do env para poder ser PROVADA com números.
 *
 * ─── O DEFEITO QUE ELE ATENDE ───────────────────────────────────────────────
 *
 * O laço da fila do worker pergunta ao banco "quando tem trabalho?" e, com a
 * fila vazia, repete a pergunta para sempre — 30 consultas/min numa instalação
 * parada (medido na #3688: 3.880 chamadas em 2h19). Numa instalação self-host
 * com uma organização e ninguém usando, isso é egress puro: foi o que estourou
 * a cota do plano Free na #3878 (12,02 GB de 5,5 GB).
 *
 * ─── AS TRÊS REGRAS (o contrato que os testes guardam) ──────────────────────
 *
 * 1. **Dobra por passada vazia.** `passadasVazias = 0` devolve o piso;
 *    1 devolve o dobro; 2, o quádruplo — cada passada vazia é evidência de que
 *    nada vai chegar nos próximos segundos.
 * 2. **Nunca passa do teto.** O teto é um limite duro, inclusive quando há
 *    jitter: o sorteio é aplicado e depois grampeado em `[piso, teto]`.
 * 3. **Com trabalho, volta ao piso IMEDIATAMENTE.** Quem chama passa
 *    `passadasVazias = 0` na primeira passada com trabalho; não existe
 *    "degrau de descida". É o item 5 do pedido da issue: o atraso máximo de um
 *    job que chega continua sendo o piso de hoje, porque o recuo só existe
 *    enquanto nada aparece.
 *
 * Jitter é OPCIONAL e desligado no worker: o laço é um só, não há rebanho de
 * processos para desincronizar. O parâmetro existe para quem rodar várias
 * instâncias do laço no futuro, e o grampeamento é o que impede o jitter de
 * furar o teto.
 *
 * ─── POR QUE A ARITMÉTICA MORA AQUI, E NÃO NO `loop.ts` ─────────────────────
 *
 * `intervaloDeEspera` responde também pelos outros dois estados do laço
 * (trabalho vencido que o claim não pegou, e job agendado à frente). O recuo é
 * a única parte que é uma função fechada de três números — e é a que precisa de
 * prova exaustiva: 0, 1, 2, 5 passadas, teto, teto abaixo do piso, contador
 * absurdo, jitter. O call site continua no `loop.ts`; o contrato é testado
 * aqui.
 */

/** Teto do expoente: `2 ** 31` já é Infinity no float64 muito antes de 30. */
const EXPOENTE_MAXIMO = 30;

/** Fração do jitter em torno da espera calculada (±20%). */
const FRACAO_DE_JITTER_PADRAO = 0.2;

export interface RecuoDoPolling {
  /** Quantas passadas SEGUIDAS voltaram com a fila vazia. 0 = a primeira. */
  passadasVazias: number;
  /** Piso da espera — `QUEUE_POLL_INTERVAL_MS`. Tem de ser > 0. */
  baseMs: number;
  /**
   * Teto do recuo — `QUEUE_IDLE_MAX_INTERVAL_MS`. Ausente/0/negativo = recuo
   * DESLIGADO: a fila vazia dorme sempre o piso, que é o comportamento de
   * antes da #3688 (default de hoje). Teto abaixo do piso é grampeado no piso:
   * recuo serve para ESPAÇAR consultas, nunca para acelerá-las.
   */
  tetoMs?: number | undefined;
  /** Sorteio em [0, 1); ausente = sem jitter. Injetável para o teste. */
  sortear?: (() => number) | undefined;
  /** Amplitude do jitter (default 0,2 = ±20%). Só vale com `sortear`. */
  fracaoDeJitter?: number | undefined;
}

/**
 * O próximo intervalo ocioso, em ms inteiros.
 *
 * Lança `RangeError` só para piso inválido — isso é erro de programação (o env
 * já chega validado por `intervaloDoPollingDoEnv`), não configuração de cliente.
 */
export function proximoIntervaloOcioso(recuo: RecuoDoPolling): number {
  const base = recuo.baseMs;
  if (!Number.isFinite(base) || base <= 0) {
    throw new RangeError(`piso do polling inválido: ${String(base)}`);
  }

  // Passada contada errada (NaN) é tratada como a primeira, não como "ocioso
  // eterno": errar para o ritmo curto custa consulta; errar para o teto esconde
  // trabalho que chegou.
  const passadas = Number.isFinite(recuo.passadasVazias)
    ? Math.max(0, Math.trunc(recuo.passadasVazias))
    : 0;
  const fator = 2 ** Math.min(passadas, EXPOENTE_MAXIMO);

  // Teto ausente/inválido = DESLIGADO (piso fixo, comportamento de hoje). Teto
  // abaixo do piso não encolhe o piso.
  const tetoBruto = recuo.tetoMs;
  const teto =
    tetoBruto !== undefined && Number.isFinite(tetoBruto) && tetoBruto > 0
      ? Math.max(tetoBruto, base)
      : base;

  let espera = Math.min(base * fator, teto);

  if (recuo.sortear !== undefined) {
    const fracao = Number.isFinite(recuo.fracaoDeJitter ?? FRACAO_DE_JITTER_PADRAO)
      ? Math.max(0, Math.min(1, recuo.fracaoDeJitter ?? FRACAO_DE_JITTER_PADRAO))
      : FRACAO_DE_JITTER_PADRAO;
    const sorteio = Math.max(0, Math.min(1, recuo.sortear()));
    // ±fracao em torno da espera; o grampeamento DEPOIS do sorteio é o que
    // garante o contrato "jitter não fura o teto".
    espera = espera * (1 + fracao * (2 * sorteio - 1));
  }

  return Math.round(Math.min(teto, Math.max(base, espera)));
}

/** Assinatura de aviso — o worker passa `console.warn`, o teste um espião. */
export type Avisar = (mensagem: string) => void;

/**
 * Lê um ms inteiro positivo de um valor CRU do env.
 *
 * `undefined`/vazio = ausente (`undefined`); qualquer outra coisa que não seja
 * um inteiro positivo em decimal = inválido (`null`), e quem chama decide o
 * default. Não usa `Number()` de propósito: `Number("6e4")`, `Number("0x10")` e
 * `Number(" 12 ")` aceitam notações que ninguém escreve num `.env` por
 * vontade — e o que não foi escrito por vontade é erro de digitação.
 */
function inteiroPositivoDoEnv(bruto: string | undefined): number | null | undefined {
  if (bruto === undefined) return undefined;
  const texto = bruto.trim();
  if (texto === "") return undefined;
  if (!/^\d+$/.test(texto)) return null;
  const valor = Number(texto);
  if (!Number.isSafeInteger(valor) || valor <= 0) return null;
  return valor;
}

function citar(bruto: string | undefined): string {
  // Só para a mensagem: um valor absurdo não pode virar log gigante.
  const texto = (bruto ?? "").trim().slice(0, 40);
  return JSON.stringify(texto);
}

/**
 * Teto do recuo a partir do env (`QUEUE_IDLE_MAX_INTERVAL_MS`).
 *
 * Inválido NÃO derruba o worker: cai em `undefined` = recuo desligado, que é o
 * comportamento de hoje, e AVISA. É a doutrina de packaging deste repo — uma
 * atualização nunca pode exigir edição manual de arquivo para o processo subir;
 * e um worker que não sobe por causa de um typo no `.env` é pior que um worker
 * que sobe no ritmo de antes.
 */
export function tetoDoRecuoDoEnv(
  bruto: string | undefined,
  opcoes: { nome: string; avisar: Avisar },
): number | undefined {
  const valor = inteiroPositivoDoEnv(bruto);
  if (valor === undefined) return undefined;
  if (valor === null) {
    opcoes.avisar(
      `[env] ${opcoes.nome} inválida (${citar(bruto)}) — o recuo do polling da fila vazia fica ` +
        `DESLIGADO e o ritmo segue QUEUE_POLL_INTERVAL_MS. Corrija no .env se queria espaçar as consultas.`,
    );
    return undefined;
  }
  return valor;
}

/**
 * Piso do polling a partir do env (`QUEUE_POLL_INTERVAL_MS`).
 *
 * Inválido cai no default do produto com AVISO, em vez de derrubar o boot. O
 * default é o de hoje (2000 ms) e ele é o piso do recuo: quem não configura
 * nada continua no ritmo de antes.
 */
export function intervaloDoPollingDoEnv(
  bruto: string | undefined,
  opcoes: { nome: string; padraoMs: number; avisar: Avisar },
): number {
  const valor = inteiroPositivoDoEnv(bruto);
  if (valor === undefined) return opcoes.padraoMs;
  if (valor === null) {
    opcoes.avisar(
      `[env] ${opcoes.nome} inválida (${citar(bruto)}) — usando o padrão ${opcoes.padraoMs} ms.`,
    );
    return opcoes.padraoMs;
  }
  return valor;
}
