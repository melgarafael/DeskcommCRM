/**
 * O RECOLHIMENTO DA BARRA DE RESPOSTAS RÁPIDAS DO INBOX (#3282).
 *
 * A barra (`components/inbox/composer/BarraDeRecursos.tsx`) monta um botão por
 * resposta rápida marcada. Numa agência com dezenas de respostas ela vira uma
 * nuvem de várias linhas acima do compositor. O recolhimento é a segunda metade
 * da issue: RECOLHIDA a barra mostra uma linha só, com "mais (N)" para abrir o
 * resto; ABERTA mostra todas.
 *
 * ─── Por que este módulo existe separado do React ───────────────────────────
 *
 * Duas regras, e as duas doem quando moram no JSX:
 *
 *   1. QUANTOS cabem na linha recolhida e quantos sobram — a CONTAGEM do
 *      "mais (N)" é critério de aceite. Uma função pura a prende sem jsdom e sem
 *      renderizar a barra inteira.
 *   2. O ESTADO aberto/fechado é POR USUÁRIO e sobrevive ao recarregar a página.
 *      A memória é o `localStorage` (decisão da issue): o produto não tem tabela
 *      de preferência por usuário, e a largura das divisórias do Inbox (#2579)
 *      já resolve o mesmo tipo de ajuste de tela assim — sem banco, com a guarda
 *      que silencia a quota cheia.
 *
 * Nada aqui lê `window` fora do argumento `storage` (injetado, tipado como o
 * recorte mínimo que usamos): é o que torna "grava e lê por usuário" testável
 * sem mock de navegador.
 */

/** O recorte mínimo do `Storage` — o teste passa um objeto falso e segue o resto. */
export interface StorageLeve {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

/**
 * Quantos botões a barra mostra RECOLHIDA.
 *
 * O número é a régua do "uma linha": a issue propõe "os 5 ou 6 textos mais
 * usados", e é isso que cabe numa linha de compositor em notebook. A ordem é a
 * que a lista já vem (a do operador) — esta fatia não reordena nem agrupa: #3244
 * e #3245 são as issues disso.
 */
export const RECURSOS_VISIVEIS_RECOLHIDA = 6;

/** O que a barra precisa de cada item para desenhar um botão. */
interface TemId {
  id: string;
}

export interface BarraRecolhida<T> {
  /** Os botões que a barra desenha agora. */
  visiveis: T[];
  /** Quantos ficaram para trás — o N do "mais (N)". */
  restantes: number;
}

/**
 * A lista da barra RECOLHIDA ou ABERTA, com a CONTAGEM do que sobrou.
 *
 * `restantes === 0` significa "não há o que abrir nem o que fechar": ou a barra
 * já está aberta, ou cabe inteira na linha recolhida — nos dois casos o botão
 * "mais (N)"/"menos" não tem função e some. É o que impede um "mais (0)".
 */
export function recursosVisiveis<T extends TemId>(
  recursos: readonly T[],
  aberta: boolean,
): BarraRecolhida<T> {
  if (aberta || recursos.length <= RECURSOS_VISIVEIS_RECOLHIDA) {
    return { visiveis: [...recursos], restantes: 0 };
  }
  return {
    visiveis: recursos.slice(0, RECURSOS_VISIVEIS_RECOLHIDA),
    restantes: recursos.length - RECURSOS_VISIVEIS_RECOLHIDA,
  };
}

/**
 * A CHAVE DA MEMÓRIA, por usuário. Um operador por navegador não é garantia
 * (máquina compartilhada do escritório): sem o id na chave, o recolhimento de um
 * mudaria a tela do colega que entrar depois no MESMO navegador.
 *
 * Sem id (teste que renderiza a barra isolada, sessão ainda sem usuário) a chave
 * prefixa `anon` — a memória existe, só não é atribuída a ninguém.
 */
export function chaveDaBarra(usuarioId: string | null | undefined): string {
  return `inbox:respostas-rapidas:${usuarioId || "anon"}`;
}

/**
 * Lê o estado aberto/fechado. Ausência, valor corrompido ou tipo errado devolvem
 * `false` — RECOLHIDA, que é o padrão do produto: a barra recolhe para quem nunca
 * escolheu nada, e expandir é uma decisão explícita do operador.
 */
export function lerBarraAberta(
  storage: StorageLeve | null | undefined,
  chave: string,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(chave) === "aberta";
  } catch {
    return false;
  }
}

/**
 * Grava o estado. Falha silenciosa de propósito: sem permissão de `localStorage`
 * (aba anônima, quota cheia) o ajuste continua valendo NESTA sessão — a barra não
 * pode parar de abrir porque a memória falhou.
 */
export function gravarBarraAberta(
  storage: StorageLeve | null | undefined,
  chave: string,
  aberta: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(chave, aberta ? "aberta" : "fechada");
  } catch {
    // Sem persistência o ajuste vale nesta sessão.
  }
}

/**
 * O `localStorage` do navegador, com a guarda de `SecurityError` (a propriedade
 * LANÇA quando o navegador bloqueia armazenamento) e a de SSR (`window` não
 * existe). Devolve `null`, que o chamador trata igual à ausência.
 */
export function armazenamentoDoNavegador(): StorageLeve | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
