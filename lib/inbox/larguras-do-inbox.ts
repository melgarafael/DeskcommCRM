/**
 * AS DIVISÓRIAS DO INBOX — limites, piso da conversa e memória por faixa (#2579).
 *
 * A largura das três colunas vivia fixa no CSS
 * (`md:grid-cols-[300px_1fr] xl:grid-cols-[272px_1fr_296px] 2xl:...`), e num
 * monitor grande sobrava conversa no meio enquanto a lista cortava nome e a
 * ficha quebrava campo. Este módulo é a REGRA do arraste, separada do React de
 * propósito: o componente só posiciona a alça e chama estas funções — quem
 * decide quanto vale cada coluna é este arquivo, e é ele que o teste prende.
 *
 * Três decisões, cada uma por um motivo medido:
 *
 *   1. LIMITE PRÓPRIO + PISO DA CONVERSA. Lista 240–520, ficha 260–560 (os
 *      valores que a issue propôs) e conversa com no mínimo ~420px. O piso da
 *      conversa não é uma quarta coluna: ele aperta o TETO das colunas laterais
 *      e nunca empurra nenhuma abaixo do próprio mínimo — quando a janela é
 *      estreita demais para cumprir as três medidas, valem os mínimos das
 *      colunas e a conversa encolhe o que sobrar (o `minmax(0,1fr)` do layout é
 *      quem impede estouro; sem piso nenhum a lista poderia crescer até
 *      empurrar a conversa para fora da tela).
 *
 *   2. MEMÓRIA POR FAIXA, não por breakpoint de CSS. `md`, `xl` e `2xl` têm
 *      padrões DIFERENTES (300/272/300 na lista), então uma largura só de
 *      "desktop" brigaria entre notebook e monitor: quem estica a lista no
 *      notebook a estica a 500px e, no 27", a mesma chave derrubaria a
 *      conversa. Cada faixa guarda a sua.
 *
 *   3. SEM BANCO. `localStorage` basta (decisão da issue): a largura é
 *      preferência de quem olha a tela, não dado do sistema — e a guarda de
 *      escrita silencia o quota cheio em vez de quebrar o arraste.
 *
 * Nada aqui lê `window` fora do argumento `storage` (injetado, tipado como o
 * recorte mínimo que usamos): é o que torna "grava e lê por faixa" testável
 * sem jsdom e sem mock de navegador.
 */

/** Faixa de viewport do Tailwind que define o FORMATO da grade. */
export type FaixaId = "md" | "xl" | "2xl";

export interface LargurasDoInbox {
  lista: number;
  ficha: number;
}

export interface Faixa {
  id: FaixaId;
  /** Início da faixa em px de viewport — igual ao breakpoint do Tailwind. */
  min: number;
  /** Padrão da lista, igual ao `grid-cols` de hoje nesta faixa. */
  lista: number;
  /** Padrão da ficha, igual ao `grid-cols` de hoje nesta faixa. */
  ficha: number;
  /** A ficha só existe como coluna a partir do `xl` (abaixo é Sheet). */
  temFicha: boolean;
}

export const LIMITES_LISTA = { min: 240, max: 520 } as const;
export const LIMITES_FICHA = { min: 260, max: 560 } as const;
export const CONVERSA_MINIMA = 420;
/** Passo da seta do teclado, igual ao do explorador de dados. */
export const PASSO_TECLADO = 16;

/** Da faixa maior para a menor: `find` devolve a primeira que cabe. */
export const FAIXAS: readonly Faixa[] = [
  { id: "2xl", min: 1536, lista: 300, ficha: 320, temFicha: true },
  { id: "xl", min: 1280, lista: 272, ficha: 296, temFicha: true },
  { id: "md", min: 768, lista: 300, ficha: 300, temFicha: false },
];

/** Abaixo do `md` o inbox é uma coluna por vez e não tem divisória nenhuma. */
export function faixaDaLargura(largura: number): Faixa | null {
  if (!Number.isFinite(largura) || largura <= 0) return null;
  return FAIXAS.find((f) => largura >= f.min) ?? null;
}

export function largurasPadrao(faixa: Faixa): LargurasDoInbox {
  return { lista: faixa.lista, ficha: faixa.ficha };
}

function limitar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

/** Arredonda e prende a lista nos seus próprios limites (240–520). */
export function limitarLista(valor: number): number {
  if (!Number.isFinite(valor)) return LIMITES_LISTA.min;
  return limitar(Math.round(valor), LIMITES_LISTA.min, LIMITES_LISTA.max);
}

/** Arredonda e prende a ficha nos seus próprios limites (260–560). */
export function limitarFicha(valor: number): number {
  if (!Number.isFinite(valor)) return LIMITES_FICHA.min;
  return limitar(Math.round(valor), LIMITES_FICHA.min, LIMITES_FICHA.max);
}

/**
 * A REGRA COMPLETA: limites próprios primeiro, depois o piso da conversa.
 *
 * A ordem importa. Prender cada coluna no seu próprio intervalo é
 * determinístico; o piso de 420px é quem desempata quando as três não cabem —
 * e ele só pode apertar o teto, nunca o piso (a lista não cai de 240 nem a
 * ficha de 260, mesmo custando conversa). Com a janela estreita demais até
 * para os três mínimos (`larguraContainer` menor que a soma deles), o piso é
 * desligado: aí vale não estourar o layout, e o `minmax(0,1fr)` da conversa
 * encolhe sozinho.
 *
 * `larguraContainer <= 0` (grade ainda não medida) desliga o piso da mesma
 * forma — os limites próprios continuam valendo.
 */
export function resolverLarguras(pedido: {
  lista: number;
  ficha: number;
  larguraContainer: number;
  temFicha: boolean;
}): LargurasDoInbox {
  let lista = limitarLista(pedido.lista);
  let ficha = limitarFicha(pedido.ficha);
  const fichaOcupada = pedido.temFicha ? ficha : 0;

  const mede = Number.isFinite(pedido.larguraContainer) && pedido.larguraContainer > 0;
  if (!mede) return { lista, ficha };

  const sobra = () => pedido.larguraContainer - lista - fichaOcupada;
  if (sobra() < CONVERSA_MINIMA && lista > LIMITES_LISTA.min) {
    lista = Math.max(
      LIMITES_LISTA.min,
      Math.min(lista, Math.round(pedido.larguraContainer - fichaOcupada - CONVERSA_MINIMA)),
    );
  }
  if (pedido.temFicha && sobra() < CONVERSA_MINIMA && ficha > LIMITES_FICHA.min) {
    ficha = Math.max(
      LIMITES_FICHA.min,
      Math.min(ficha, Math.round(pedido.larguraContainer - lista - CONVERSA_MINIMA)),
    );
  }
  return { lista, ficha };
}

/**
 * O que a tecla faz: seta move a DIVISÓRIA no sentido da seta (padrão Window
 * Splitter do WAI-ARIA). A lista fica à esquerda da alça, então seta direita a
 * faz crescer; a ficha fica à DIREITA da alça, então seta direita a encolhe.
 * `null` = tecla que não ajusta largura, para o componente não comer o evento.
 */
export function moverPorSeta(
  coluna: "lista" | "ficha",
  atual: number,
  tecla: string,
): number | null {
  const passo = tecla === "ArrowLeft" ? -PASSO_TECLADO : tecla === "ArrowRight" ? PASSO_TECLADO : 0;
  if (passo === 0) return null;
  return coluna === "lista"
    ? limitarLista(atual + passo)
    : limitarFicha(atual - passo);
}

/** Recorte mínimo do `Storage` — o teste passa um objeto falso e segue o resto. */
export interface StorageLeve {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

export function chaveDaFaixa(faixa: FaixaId): string {
  return `inbox:divisorias:${faixa}`;
}

/**
 * Lê a largura salva da faixa. Valor corrompido, tipo errado ou ausência
 * nenhum devolvem `null` — que o layout interpreta como "padrão de hoje",
 * nunca como zero.
 */
export function lerLarguras(
  storage: StorageLeve | null | undefined,
  faixa: FaixaId,
): LargurasDoInbox | null {
  if (!storage) return null;
  try {
    const bruto = storage.getItem(chaveDaFaixa(faixa));
    if (!bruto) return null;
    const dado = JSON.parse(bruto) as { lista?: unknown; ficha?: unknown };
    if (typeof dado?.lista !== "number" || typeof dado?.ficha !== "number") return null;
    if (!Number.isFinite(dado.lista) || !Number.isFinite(dado.ficha)) return null;
    // O limite na LEITURA também: uma chave gravada por uma versão antiga com
    // outra regra não pode entrar já estourada.
    return { lista: limitarLista(dado.lista), ficha: limitarFicha(dado.ficha) };
  } catch {
    return null;
  }
}

/**
 * Grava (ou apaga, com `null`) a largura da faixa. Falha silenciosa de
 * propósito: sem permissão de `localStorage` (aba anônima, quota cheia) o
 * ajuste continua valendo nesta sessão — a alça não pode parar de arrastar
 * porque a memória falhou.
 */
export function gravarLarguras(
  storage: StorageLeve | null | undefined,
  faixa: FaixaId,
  larguras: LargurasDoInbox | null,
): void {
  if (!storage) return;
  try {
    if (!larguras) {
      storage.removeItem(chaveDaFaixa(faixa));
      return;
    }
    storage.setItem(
      chaveDaFaixa(faixa),
      JSON.stringify({ lista: limitarLista(larguras.lista), ficha: limitarFicha(larguras.ficha) }),
    );
  } catch {
    // Sem persistência o ajuste vale nesta sessão.
  }
}
