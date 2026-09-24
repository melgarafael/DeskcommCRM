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
import { normalizarNomeDeMoto } from './fotos-do-catalogo';

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
  criterios?: ReadonlyArray<'nome' | 'cilindrada' | 'preco' | 'tipo'>;
  /**
   * Colunas (por nome) para comparação GENÉRICA, na ordem de prioridade. Quando
   * presente, substitui `criterios`: número → o mais próximo; texto → o mais
   * parecido. É o que abre a semelhança para QUALQUER coluna marcada "Comparar".
   */
  criteriosColunas?: readonly string[];
  /**
   * Preferência de ORDEM por coluna (qualquer característica): 'menor' põe os
   * valores crescentes primeiro; 'maior' os decrescentes. Aplicada como
   * DESEMPATE, depois dos critérios de semelhança. Ex.: `{preco:'menor'}` =
   * "entre as parecidas, as mais baratas primeiro".
   */
  preferencias?: Readonly<Record<string, 'menor' | 'maior'>>;
  toleranciaPrecoPct?: number;
}

/**
 * Extrai o primeiro número "plausível" de um texto — de cilindrada/valor, não o
 * sufixo do modelo. Exige ≥ 50 (assim "MT-07" NÃO vira 7) e ignora anos
 * (1900–2099). Sem número plausível, devolve null (a coluna numérica fica neutra).
 */
function extrairNumeroDoPedido(texto: string): number | null {
  const t = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const numeros = [...t.matchAll(/(?<!\d)(\d{1,7})(?!\d)/g)].map((m) => Number(m[1]));
  const candidato = numeros.find((n) => n >= 50 && (n < 1900 || n > 2099));
  return candidato ?? null;
}

/**
 * O valor da célula é NUMÉRICO? Só quando sobra UM número depois de tirar o
 * rótulo de moeda/unidade. Nome de moto ("Biz 125 FLEX 2021") tem letras e mais
 * de um número → é TEXTO (ordena por relevância, não por distância numérica).
 * Sem isto, o nome virava um número colado ("1252025") e a coluna `nome`
 * dominava a ordenação com uma distância sem sentido — medido ao vivo: a
 * objeção "Achei caro" na Biz 125 trouxe uma BMW G 310.
 */
export function numeroDaCelula(valor: string): number | null {
  const t = valor.trim();
  if (!/\d/.test(t)) return null;
  const limpo = t
    .replace(/r\$/gi, '')
    .replace(/(cm3|cm³|cc|cilindradas?|km|quilometragem|anos?|hp|cv)/gi, '')
    .trim();
  if (/[a-z]/i.test(limpo)) return null;
  return parsePreco(limpo) ?? parseNumeroSimples(limpo);
}

/**
 * Chave de ordenação de UMA coluna genérica (0 = neutro; menor = melhor).
 *  - valor numérico e pedido com número → distância (mais próximo primeiro);
 *  - senão → similaridade textual com o pedido (mais parecido primeiro).
 */
function chaveDeColuna(
  moto: MotoDoCatalogo,
  termo: string,
  alvoNumerico: number | null,
  coluna: string,
): number {
  const valor = moto.valores?.[coluna];
  if (valor === undefined || valor === '') return 0;
  const numero = numeroDaCelula(valor);
  if (numero !== null && alvoNumerico !== null) {
    return Math.abs(numero - alvoNumerico);
  }
  if (numero !== null) return 0;
  return -relevanciaDoNome(termo, valor);
}

/** Número simples ("2021", "300", "160") sem semântica de moeda. */
function parseNumeroSimples(valor: string): number | null {
  const limpo = valor.replace(/[^\d.,-]/g, '');
  if (limpo === '') return null;
  const normalizado =
    limpo.includes(',') && limpo.lastIndexOf(',') > limpo.lastIndexOf('.')
      ? limpo.replace(/\./g, '').replace(',', '.')
      : limpo.replace(/,/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/**
 * Quanto o NOME da moto casa com o pedido do cliente (0..2). `nome` e `versao`
 * que compõem o nome têm o MESMO peso. Soma duas frações:
 *  - COBERTURA: quantos tokens do NOME o cliente citou (0..1);
 *  - PRECISÃO: quantos tokens do PEDIDO o nome cobre (0..1).
 * A soma desempata o nome mais específico: pedido "quero a Biz 125 Flex" dá
 * "Biz 125 Flex" (1 + 0.75) acima de "Biz 125" (1 + 0.5). Nome igual ao termo = 2.
 */
export function relevanciaDoNome(termo: string, nome: string | undefined): number {
  if (nome === undefined || nome === '') return 0;
  const alvo = normalizarNomeDeMoto(termo);
  const nomeNorm = normalizarNomeDeMoto(nome);
  if (alvo === '' || nomeNorm === '') return 0;
  const nomeTokens = nomeNorm.split(' ').filter((t) => t.length >= 2);
  if (nomeTokens.length === 0) return 0;
  const termoTokens = alvo.split(' ').filter((t) => t.length >= 2);

  const cobertura = nomeTokens.filter((t) => alvo.includes(t)).length / nomeTokens.length;
  const precisao =
    termoTokens.length === 0
      ? 0
      : termoTokens.filter((t) => nomeNorm.includes(t)).length / termoTokens.length;
  return cobertura + precisao;
}

function chaveOrdenacao(
  moto: MotoDoCatalogo,
  termo: string,
  termoCil: number | null,
  termoPreco: number | null,
  criterios: ReadonlyArray<'nome' | 'cilindrada' | 'preco' | 'tipo'>,
): number[] {
  const cil = cilindradaDaMoto(moto);
  const preco = parsePreco(moto.preco);
  const chaves: number[] = [];
  for (const criterio of criterios) {
    if (criterio === 'nome') {
      // Texto: maior relevância = menor chave (ordena crescente). O nome já vem
      // composto (nome + versão) do extrator do catálogo.
      chaves.push(-relevanciaDoNome(termo, moto.nome));
    } else if (criterio === 'cilindrada') {
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
  const colunas = (opcoes.criteriosColunas ?? []).filter((c) => c !== '');
  const criterios = opcoes.criterios ?? ['cilindrada', 'preco'];
  const termoCil = extrairCilindrada(termo);
  const termoPreco = extrairPrecoDoPedido(termo);
  const alvoNumerico = extrairNumeroDoPedido(termo) ?? extrairPrecoDoPedido(termo);

  const preferencias = opcoes.preferencias ?? {};
  const chavePref = (moto: MotoDoCatalogo, coluna: string): number => {
    const valor = moto.valores?.[coluna];
    const numero = valor === undefined ? null : numeroDaCelula(valor);
    if (numero === null) return Number.MAX_SAFE_INTEGER;
    return preferencias[coluna] === 'maior' ? -numero : numero;
  };
  const chave = (moto: MotoDoCatalogo): number[] => {
    const base =
      colunas.length > 0
        ? colunas.map((coluna) => chaveDeColuna(moto, termo, alvoNumerico, coluna))
        : chaveOrdenacao(moto, termo, termoCil, termoPreco, criterios);
    const prefs = Object.keys(preferencias).map((coluna) => chavePref(moto, coluna));
    return [...base, ...prefs];
  };

  const comparar = (a: MotoDoCatalogo, b: MotoDoCatalogo): number => {
    const ka = chave(a);
    const kb = chave(b);
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

