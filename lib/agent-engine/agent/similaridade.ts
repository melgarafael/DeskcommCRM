/**
 * Escolha DETERMINÍSTICA das motos semelhantes (Fase 3 do PLANO-CONFIG-UI-AGENTE).
 *
 * ─── O defeito que isto resolve ─────────────────────────────────────────────
 * Até aqui, quando o catálogo não tinha a moto pedida, quem escolhia as
 * "parecidas" era o MODELO, por julgamento livre. Resultado: a escolha variava
 * de turno para turno e, em modelo barato, podia ser ruim. O dono pediu regra
 * fixa: cilindrada primeiro, depois preço.
 *
 * ─── O critério ─────────────────────────────────────────────────────────────
 *  1. CILINDRADA: extrai a cilindrada do pedido ("CB 250" -> 250) e prioriza a
 *     moto de cilindrada mais próxima (mesma cilindrada primeiro).
 *  2. PREÇO: empate desempatado pelo preço mais próximo do que o cliente citou;
 *     sem preço no pedido, as mais baratas primeiro.
 *  3. TIPO: (opcional) mesmo tipo quando existir coluna.
 *
 * Sem cilindrada identificável no pedido, cai para preço. Nada casa => devolve
 * as primeiras do catálogo (nunca vazio quando o catálogo tem item), para a IA
 * ainda ter o que oferecer.
 *
 * Funções PURAS — testáveis e sem I/O.
 */
import type { MotoDoCatalogo } from './fotos-do-catalogo';

/** Extrai uma cilindrada plausível de um texto (nome de moto ou pedido). */
export function extrairCilindrada(texto: string): number | null {
  const t = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // "250cc", "250 cc", "250 cilindradas".
  const comCc = t.match(/(\d{2,4})\s*(?:cc|cilindradas?)/);
  if (comCc) return Number(comCc[1]);

  // Números soltos, inclusive colados à letra ("cb250" -> 250). Aceita 50–999 e
  // 1000–1899 (cilindradas comuns); EXCLUI anos (1900–2099).
  const numeros = [...t.matchAll(/(?<!\d)(\d{2,4})(?!\d)/g)].map((m) => Number(m[1]));
  const candidatos = numeros.filter(
    (n) => (n >= 50 && n <= 999) || (n >= 1000 && n <= 1899),
  );
  return candidatos.length > 0 ? (candidatos[0] ?? null) : null;
}

/** Cilindrada de uma moto: coluna configurada quando houver; senão, o nome. */
export function cilindradaDaMoto(moto: MotoDoCatalogo): number | null {
  if (moto.cilindrada) {
    const daColuna = extrairCilindrada(moto.cilindrada);
    if (daColuna !== null) return daColuna;
  }
  return extrairCilindrada(moto.nome);
}

/** Preço em número ("R$ 28.990,00" / "28990.00" -> 28990). */
export function parsePreco(valor: string | undefined): number | null {
  if (valor === undefined) return null;
  const limpo = valor.replace(/[^\d.,-]/g, '');
  if (limpo === '') return null;
  // Formato BR: pontos de milhar + vírgula decimal. Formato US: ponto decimal.
  const normalizado =
    limpo.includes(',') && limpo.lastIndexOf(',') > limpo.lastIndexOf('.')
      ? limpo.replace(/\./g, '').replace(',', '.')
      : limpo.replace(/,/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/** Preço citado pelo cliente ("até 30 mil" -> 30000). */
export function extrairPrecoDoPedido(texto: string): number | null {
  const t = texto.toLowerCase();
  const comMil = t.match(/(\d+(?:[.,]\d+)?)\s*(mil|k)\b/);
  if (comMil) {
    const base = Number(comMil[1]?.replace(',', '.'));
    if (Number.isFinite(base)) return Math.round(base * 1000);
  }
  const numeros = [...t.matchAll(/\b(\d{4,6})\b/g)].map((m) => Number(m[1]));
  const candidatos = numeros.filter((n) => n >= 3000);
  return candidatos.length > 0 ? (candidatos[0] ?? null) : null;
}

export interface OpcoesSimilares {
  quantidade: number;
  criterios?: ReadonlyArray<'cilindrada' | 'preco' | 'tipo'>;
  toleranciaPrecoPct?: number;
}

function chaveOrdenacao(
  moto: MotoDoCatalogo,
  termoCil: number | null,
  termoPreco: number | null,
  criterios: ReadonlyArray<'cilindrada' | 'preco' | 'tipo'>,
): number[] {
  const cil = cilindradaDaMoto(moto);
  const preco = parsePreco(moto.preco);
  const chaves: number[] = [];
  for (const criterio of criterios) {
    if (criterio === 'cilindrada') {
      // Distância da cilindrada pedida. Sem pedido ou sem cilindrada -> neutro.
      chaves.push(termoCil !== null && cil !== null ? Math.abs(cil - termoCil) : 0);
    } else if (criterio === 'preco') {
      // Distância do preço pedido; sem pedido, menor preço primeiro.
      if (termoPreco !== null && preco !== null) chaves.push(Math.abs(preco - termoPreco));
      else chaves.push(preco ?? Number.MAX_SAFE_INTEGER);
    } else {
      // tipo: só desempata — neutro aqui (o chamador pode evoluir).
      chaves.push(0);
    }
  }
  return chaves;
}

/**
 * Ordena o catálogo pelas motos mais semelhantes ao pedido e devolve até
 * `quantidade`. Nunca vazio quando o catálogo tem itens: sem sinal nenhum,
 * devolve as primeiras (a IA ainda tem o que oferecer).
 */
export function ordenarSimilares(
  termo: string,
  catalogo: readonly MotoDoCatalogo[],
  opcoes: OpcoesSimilares,
): MotoDoCatalogo[] {
  if (catalogo.length === 0) return [];
  const criterios = opcoes.criterios ?? ['cilindrada', 'preco'];
  const termoCil = extrairCilindrada(termo);
  const termoPreco = extrairPrecoDoPedido(termo);

  const comparar = (a: MotoDoCatalogo, b: MotoDoCatalogo): number => {
    const ka = chaveOrdenacao(a, termoCil, termoPreco, criterios);
    const kb = chaveOrdenacao(b, termoCil, termoPreco, criterios);
    for (let i = 0; i < ka.length; i += 1) {
      const d = (ka[i] ?? 0) - (kb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };

  // Ordenação estável com desempate final pelo nome (determinismo byte-a-byte).
  return [...catalogo]
    .map((m, i) => ({ m, i }))
    .sort((x, y) => comparar(x.m, y.m) || x.i - y.i)
    .slice(0, Math.max(1, opcoes.quantidade))
    .map((x) => x.m);
}
