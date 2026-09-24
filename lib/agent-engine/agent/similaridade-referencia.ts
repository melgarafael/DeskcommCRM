/**
 * Semelhança por REFERÊNCIA (coluna `moto_similar`).
 *
 * ─── O que resolve ──────────────────────────────────────────────────────────
 * O dono tem uma coluna que lista motos parecidas por linha (ex.: a linha da
 * "XRE 300" cita "CB 300"). Quando o cliente pede uma moto que NÃO temos, o
 * motor procura o pedido nessas listas e oferece a moto REAL que a cita.
 *
 * ─── Regra de ouro ──────────────────────────────────────────────────────────
 * A referência NUNCA é oferecida ao cliente nem enviada à IA. O que sai é a
 * LINHA (moto do estoque) que contém a referência. É por isso que esta função
 * devolve `MotoDoCatalogo` (motos reais), nunca os nomes da lista.
 *
 * ─── Prioridade ─────────────────────────────────────────────────────────────
 * É o 1º critério: as motos casadas por referência vêm PRIMEIRO (sem anotação),
 * e só depois o motor completa com a ordenação por colunas ("Comparar").
 *
 * Funções PURAS — testáveis e sem I/O.
 */
import type { MotoDoCatalogo } from './fotos-do-catalogo';
import { normalizarNomeDeMoto } from './fotos-do-catalogo';
import { ordenarSimilares } from './similaridade';

/** Separa a lista de referências de uma célula (vírgula, ponto-e-vírgula, pipe, barra, quebra de linha). */
export function separarReferencias(valor: string | undefined): string[] {
  if (valor === undefined || valor === '') return [];
  return valor
    .split(/[,;|\n/]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Quanto o pedido casa com UMA referência (0 = nada; maior = melhor).
 * Igual > contém > tokens em comum.
 */
export function pontuarReferencia(pedido: string, referencia: string): number {
  const p = normalizarNomeDeMoto(pedido);
  const r = normalizarNomeDeMoto(referencia);
  if (p === '' || r === '') return 0;
  if (p === r) return 3;
  if (r.includes(p) || p.includes(r)) return 2;
  const tokens = p.split(' ').filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;
  const cobertos = tokens.filter((t) => r.includes(t)).length;
  return cobertos > 0 ? 1 + cobertos / tokens.length : 0;
}

/**
 * As motos REAIS cuja coluna de referência cita o que o cliente pediu, da mais
 * forte para a mais fraca (estável). Vazio quando nenhuma cita.
 */
export function casarPorReferencia(
  pedido: string,
  catalogo: readonly MotoDoCatalogo[],
  coluna: string,
): MotoDoCatalogo[] {
  if (coluna === '') return [];
  const pontuadas: Array<{ moto: MotoDoCatalogo; pontos: number; i: number }> = [];
  catalogo.forEach((moto, i) => {
    const referencias = separarReferencias(moto.valores?.[coluna]);
    let melhor = 0;
    for (const referencia of referencias) {
      melhor = Math.max(melhor, pontuarReferencia(pedido, referencia));
    }
    if (melhor > 0) pontuadas.push({ moto, pontos: melhor, i });
  });
  return pontuadas.sort((a, b) => b.pontos - a.pontos || a.i - b.i).map((x) => x.moto);
}

export interface OpcoesComReferencia {
  quantidade: number;
  criteriosColunas?: readonly string[];
  /** A coluna de referência (ex.: `moto_similar`). Ausente/null = sem reserva. */
  colunaSimilares?: string | null;
  /** Preferência de ordem por coluna (ex.: {preco:'menor'}). */
  preferencias?: Readonly<Record<string, 'menor' | 'maior'>>;
}

/**
 * Escolha determinística COM reserva: as motos que citam o pedido na coluna de
 * referência vêm PRIMEIRO; o restante é completado pela ordenação por colunas.
 * Nunca passa de `quantidade` e nunca devolve vazio quando há catálogo.
 */
export function escolherComReferencia(
  pedido: string,
  catalogo: readonly MotoDoCatalogo[],
  opcoes: OpcoesComReferencia,
): MotoDoCatalogo[] {
  const quantidade = Math.max(1, opcoes.quantidade);
  const reserva = opcoes.colunaSimilares
    ? casarPorReferencia(pedido, catalogo, opcoes.colunaSimilares)
    : [];
  const reservados = new Set(reserva.map((m) => m.nome));
  const resto = ordenarSimilares(
    pedido,
    catalogo.filter((m) => !reservados.has(m.nome)),
    {
      quantidade,
      ...(opcoes.criteriosColunas !== undefined
        ? { criteriosColunas: opcoes.criteriosColunas }
        : {}),
      ...(opcoes.preferencias !== undefined ? { preferencias: opcoes.preferencias } : {}),
    },
  );
  return [...reserva, ...resto].slice(0, quantidade);
}
