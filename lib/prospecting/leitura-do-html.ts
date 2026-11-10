/**
 * Leitura do HTML baixado do site do lead com custo proporcional ao tamanho da
 * página (até `MAX_BODY_BYTES`).
 *
 * Cada função devolve EXATAMENTE o que devolvia a expressão regular citada no
 * seu comentário — a equivalência é provada em
 * `tests/unit/prospecting-leitura-do-html.test.ts` contra cópias das expressões
 * antigas. As antigas tinham custo que crescia mais que o tamanho da página em
 * HTML malformado (abertura sem fechamento, tag sem `>`): segundos, ou minutos,
 * para 200 KB. Aqui cada busca anda só para a frente, ou é uma busca binária
 * sobre posições achadas numa passada só.
 */

/** Posições de todas as ocorrências de `padrao` (global; nenhum padrão daqui se sobrepõe a si mesmo). */
function posicoes(texto: string, padrao: RegExp): number[] {
  return Array.from(texto.matchAll(padrao), (m) => m.index);
}

/** Índice do primeiro valor `>= x` em `ordenadas` (ou `length`). */
function indiceDesde(ordenadas: number[], x: number): number {
  let lo = 0;
  let hi = ordenadas.length;
  while (lo < hi) {
    const meio = (lo + hi) >> 1;
    if (ordenadas[meio]! < x) lo = meio + 1;
    else hi = meio;
  }
  return lo;
}

/** Primeiro valor `>= x` em `ordenadas`, ou -1. */
function primeiroDesde(ordenadas: number[], x: number): number {
  const i = indiceDesde(ordenadas, x);
  return i < ordenadas.length ? ordenadas[i]! : -1;
}

/** Igual a `texto.replace(/<[^>]+>/g, " ")`. */
export function semTags(texto: string): string {
  // Depois do último `>` nenhuma tag fecha; antes dele, cada `<` acha o seu `>` logo adiante.
  const fim = texto.lastIndexOf(">") + 1;
  return texto.slice(0, fim).replace(/<[^>]+>/g, " ") + texto.slice(fim);
}

const ABERTURA_DE_BLOCO = /<(script|style|noscript)/gi;
const FECHAMENTO_DE_BLOCO: Record<string, RegExp> = {
  script: /<\/script>/gi,
  style: /<\/style>/gi,
  noscript: /<\/noscript>/gi,
};

/** Igual a `html.replace(/<(script|style|noscript)[^>]*>.*?<\/\1>/gis, " ")`. */
export function semBlocosDeScript(html: string): string {
  let saida = "";
  let copiadoAte = 0;
  let busca = 0;
  let proximoGt = -1;
  // Nome sem fechamento a partir de algum ponto não fecha em nenhuma abertura posterior.
  const semFechamento = new Set<string>();
  for (;;) {
    ABERTURA_DE_BLOCO.lastIndex = busca;
    const abertura = ABERTURA_DE_BLOCO.exec(html);
    if (!abertura) break;
    const nome = abertura[1]!.toLowerCase();
    const depoisDoNome = abertura.index + abertura[0].length;
    if (proximoGt < depoisDoNome) proximoGt = html.indexOf(">", depoisDoNome);
    if (proximoGt === -1) break;
    const fechamento = FECHAMENTO_DE_BLOCO[nome]!;
    fechamento.lastIndex = proximoGt + 1;
    const fim = semFechamento.has(nome) ? null : fechamento.exec(html);
    if (!fim) {
      semFechamento.add(nome);
      busca = abertura.index + 1;
      continue;
    }
    saida += html.slice(copiadoAte, abertura.index) + " ";
    copiadoAte = busca = fim.index + fim[0].length;
  }
  return saida + html.slice(copiadoAte);
}

/** Igual a `/<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1]` (null quando não casa). */
export function conteudoDoTitulo(html: string): string | null {
  const abertura = /<title/i.exec(html);
  if (!abertura) return null;
  const gt = html.indexOf(">", abertura.index + 6);
  if (gt === -1) return null;
  const fechamento = /<\/title>/gi;
  fechamento.lastIndex = gt + 1;
  const fim = fechamento.exec(html);
  return fim ? html.slice(gt + 1, fim.index) : null;
}

/** Igual às capturas de `html.matchAll(/<h[12][^>]*>(.*?)<\/h[12]>/gis)`, em ordem. */
export function conteudosDeH1H2(html: string): string[] {
  const abertura = /<h[12]/gi;
  const fechamento = /<\/h[12]>/gi;
  const saida: string[] = [];
  let busca = 0;
  for (;;) {
    abertura.lastIndex = busca;
    const a = abertura.exec(html);
    if (!a) break;
    const gt = html.indexOf(">", a.index + 3);
    if (gt === -1) break;
    fechamento.lastIndex = gt + 1;
    const f = fechamento.exec(html);
    if (!f) break;
    saida.push(html.slice(gt + 1, f.index));
    busca = f.index + f[0].length;
  }
  return saida;
}

/**
 * Regiões `[inicio, fim)` de cada `<nome[^>]+`: do início da abertura até o
 * primeiro `>` (ou o fim do texto). Uma abertura DENTRO da região de outra
 * divide o mesmo `>` e enxerga só uma parte do que a primeira enxerga — nunca
 * casa onde a primeira não casou —, então fica de fora.
 */
function regioes(html: string, abertura: RegExp, gts: number[]): Array<[number, number]> {
  const saida: Array<[number, number]> = [];
  let fimAnterior = 0;
  for (const inicio of posicoes(html, abertura)) {
    if (inicio < fimAnterior) continue;
    const gt = primeiroDesde(gts, inicio + 5);
    fimAnterior = gt === -1 ? html.length : gt;
    saida.push([inicio, fimAnterior]);
  }
  return saida;
}

/** `name="description"` tem 18 caracteres; `content="` tem 9; `<meta` e `<link` têm 5. */
const TAM_NOME = 18;
const TAM_CONTEUDO = 9;
const DEPOIS_DA_ABERTURA = 6; // `<meta` + ao menos 1 caractere do `[^>]+`

interface Meta {
  html: string;
  regioes: Array<[number, number]>;
  nomes: number[];
  conteudos: number[];
  aspas: number[];
  gts: number[];
}

function lerMeta(html: string): Meta {
  const gts = posicoes(html, />/g);
  return {
    html,
    regioes: regioes(html, /<meta/gi, gts),
    nomes: posicoes(html, /name=["']description["']/gi),
    conteudos: posicoes(html, /content=["']/gi),
    aspas: posicoes(html, /["']/g),
    gts,
  };
}

/**
 * Os `content=` válidos de uma região quando `name="description"` vem ANTES:
 * depois do primeiro nome da região e com ao menos 1 caractere entre os dois.
 * Devolve o intervalo de índices em `meta.conteudos`.
 */
function conteudosDepoisDoNome(meta: Meta, inicio: number, fim: number): [number, number] | null {
  const nome = primeiroDesde(meta.nomes, inicio + DEPOIS_DA_ABERTURA);
  if (nome === -1 || nome >= fim) return null;
  return [indiceDesde(meta.conteudos, nome + TAM_NOME + 1), indiceDesde(meta.conteudos, fim)];
}

/**
 * Igual a `/<meta[^>]+name=["']description["'][^>]+content=["'](.*?)["']/is.exec(html)?.[1]`.
 * A captura acaba na primeira aspa depois do `content=`, e o maior `content=`
 * válido da região é o que a expressão escolhia.
 */
export function descricaoComNomeAntes(html: string): string | null {
  const meta = lerMeta(html);
  const ultimaAspa = meta.aspas.length > 0 ? meta.aspas[meta.aspas.length - 1]! : -1;
  for (const [inicio, fim] of meta.regioes) {
    const faixa = conteudosDepoisDoNome(meta, inicio, fim);
    if (!faixa) continue;
    for (let i = faixa[1] - 1; i >= faixa[0]; i--) {
      const valor = meta.conteudos[i]! + TAM_CONTEUDO;
      if (valor > ultimaAspa) continue;
      return html.slice(valor, primeiroDesde(meta.aspas, valor));
    }
  }
  return null;
}

/**
 * Igual a `/<meta[^>]+content=["'](.*?)["'][^>]+name=["']description["']/is.exec(html)?.[1]`.
 * A captura acaba na primeira aspa depois da qual vem um `name="description"`
 * sem `>` no meio — essa condição só depende da aspa, então é calculada uma
 * vez por aspa.
 */
export function descricaoComConteudoAntes(html: string): string | null {
  const meta = lerMeta(html);
  let aspasQueFecham: number[] | null = null;
  for (const [inicio, fim] of meta.regioes) {
    const de = indiceDesde(meta.conteudos, inicio + DEPOIS_DA_ABERTURA);
    const ate = indiceDesde(meta.conteudos, fim);
    if (de >= ate) continue;
    aspasQueFecham ??= meta.aspas.filter((k) => {
      const nome = primeiroDesde(meta.nomes, k + 2);
      if (nome === -1) return false;
      const gt = primeiroDesde(meta.gts, k + 1);
      return gt === -1 || gt > nome;
    });
    for (let i = ate - 1; i >= de; i--) {
      const valor = meta.conteudos[i]! + TAM_CONTEUDO;
      const fecha = primeiroDesde(aspasQueFecham, valor);
      if (fecha !== -1) return html.slice(valor, fecha);
    }
  }
  return null;
}

/**
 * Igual a `/<meta[^>]+name=["']description["'][^>]+content=["'](.{30,})["']/i.test(html)`:
 * existe uma aspa a 30 caracteres ou mais do início do valor, na mesma linha.
 */
export function temDescricaoLonga(html: string): boolean {
  const meta = lerMeta(html);
  const finsDeLinha = posicoes(html, /[\n\r\u2028\u2029]/g);
  for (const [inicio, fim] of meta.regioes) {
    const faixa = conteudosDepoisDoNome(meta, inicio, fim);
    if (!faixa) continue;
    for (let i = faixa[0]; i < faixa[1]; i++) {
      const valor = meta.conteudos[i]! + TAM_CONTEUDO;
      const aspa = primeiroDesde(meta.aspas, valor + 30);
      if (aspa === -1) continue;
      const fimDaLinha = primeiroDesde(finsDeLinha, valor);
      if (fimDaLinha === -1 || aspa < fimDaLinha) return true;
    }
  }
  return false;
}

/** Igual a `/<link[^>]+href=["']http:\/\//i.test(html)`. */
export function temLinkComHrefHttp(html: string): boolean {
  const hrefs = posicoes(html, /href=["']http:\/\//gi);
  if (hrefs.length === 0) return false;
  const gts = posicoes(html, />/g);
  return regioes(html, /<link/gi, gts).some(([inicio, fim]) => {
    const href = primeiroDesde(hrefs, inicio + DEPOIS_DA_ABERTURA);
    return href !== -1 && href < fim;
  });
}
