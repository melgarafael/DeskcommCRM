/**
 * OS FATOS DO CRM DO CONTATO, EM TEXTO — a parte PURA dos fatos da #3917.
 *
 * ─── Por que este arquivo existe, separado de quem lê o banco ───────────────
 *
 * O bloco de fatos é montado aqui e consumido por DOIS caminhos no mesmo turno:
 * o prompt da IA de sempre (`intent-classifier.ts`) e a pergunta feita ao Jev
 * (`lib/ai/decisao/roteador.ts`). A formatação precisa ser a mesma — um caminho
 * dizendo "isto não é o que classificar" e o outro deixando o modelo responder
 * sobre o funil seria o defeito da issue pela metade.
 *
 * A LEITURA continua em `lib/agent-engine/agent/fatos-do-crm-do-contato.ts`,
 * que importa e reexporta daqui. A separação não é estética: a cerca
 * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts` proíbe que o módulo
 * do Jev alcance `lib/agent-engine/agent/**` — de lá saem os que ENVIAM
 * mensagem e passam a conversa adiante. O Jev só decide; ele não pode ter, nem
 * por import transitivo, o caminho de quem fala com o cliente.
 *
 * Nada aqui toca banco, rede, logger ou relógio: entra fato, sai texto.
 *
 * ─── O que sai daqui vai para provedor de IA ────────────────────────────────
 *
 * Os dois consumidores mandam o bloco para fora da máquina. Nome de funil,
 * etapa e etiqueta é digitado pela empresa e pode carregar telefone, CPF ou
 * e-mail do cliente, então cada nome passa pelo `scrubMessage` em
 * `normalizarNome`, ANTES do corte em `MAX_CARACTERES_DE_NOME` — depois do
 * corte, um número partido no limite escaparia do padrão.
 */
import { scrubMessage } from '@/lib/sentry/scrub';

/** Quantos funis distintos entram no bloco. */
export const MAX_FUNIS_NO_CLASSIFICADOR = 3;
/** Quantas etapas por funil (o contato pode ter dois cards abertos no mesmo funil). */
export const MAX_ETAPAS_POR_FUNIL = 2;
/** Quantas etiquetas entram no bloco. */
export const MAX_ETIQUETAS_NO_CLASSIFICADOR = 8;
/** Teto de cada nome (funil, etapa, etiqueta) — nome de funil é digitado à mão. */
export const MAX_CARACTERES_DE_NOME = 40;
/** Teto do bloco formatado inteiro, contando cabeçalho e marcadores. */
export const MAX_CARACTERES_DOS_FATOS = 600;

/**
 * O cabeçalho do bloco, compartilhado pelos DOIS caminhos que classificam
 * (#3917): o prompt da IA de sempre (`intent-classifier.ts`) e a pergunta feita
 * ao Jev (`lib/ai/decisao/roteador.ts`). Duas cópias divergiriam no primeiro
 * ajuste, e a divergência seria invisível: um caminho diria ao modelo que o
 * bloco "não é o que classificar" e o outro deixaria o modelo responder sobre
 * o funil.
 */
export const CABECALHO_DOS_FATOS_NO_PROMPT =
  'Fatos do CRM deste contato (negócio ABERTO e etiquetas — contexto para decidir a intenção, NÃO é o que classificar):';

/** Um funil em que o contato tem negócio aberto, com as etapas desses cards. */
export interface FunilComNegocioAberto {
  funil: string;
  etapas: string[];
}

/** Os fatos que vão para o prompt. Listas vazias = não há o que informar. */
export interface FatosDoCrm {
  funis: FunilComNegocioAberto[];
  etiquetas: string[];
  /** Quantos funis ficaram fora do teto — o prompt diz que a lista não é completa. */
  funisOmitidos: number;
  /** Quantas etiquetas ficaram fora do teto. */
  etiquetasOmitidas: number;
}

/**
 * O resultado da leitura. `motivo` é o que vai para o log; `fatos` é o que vai
 * para o prompt. Os dois nunca se misturam: motivo é diagnóstico, não contexto.
 */
export interface LeituraDosFatosDoCrm {
  fatos: FatosDoCrm;
  motivo: 'contato_inexistente' | 'falha_na_leitura' | null;
}

/** Um card aberto, como a consulta devolve (nomes já resolvidos). */
export interface NegocioAbertoRow {
  funil: string | null;
  etapa: string | null;
}

/** Fatos vazios, compartilhados: "não há o que informar" tem um valor só. */
export const FATOS_VAZIOS: FatosDoCrm = {
  funis: [],
  etiquetas: [],
  funisOmitidos: 0,
  etiquetasOmitidas: 0,
};

/**
 * Nome de config em uma linha só: sem quebra (nome colado no formulário não vira
 * fato novo no prompt), sem espaço duplicado, com dado pessoal mascarado e
 * cortado no teto com reticências — o scrub vem ANTES do corte.
 */
export function normalizarNome(bruto: unknown): string {
  if (typeof bruto !== 'string') return '';
  const limpo = scrubMessage(bruto.replace(/\s+/g, ' ').trim());
  if (limpo === '') return '';
  return limpo.length > MAX_CARACTERES_DE_NOME
    ? `${limpo.slice(0, MAX_CARACTERES_DE_NOME - 1)}…`
    : limpo;
}

/** Sem caixa e sem espaço: `Cliente ` e `cliente` são a mesma etiqueta. */
function chaveDeEtiqueta(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Monta o bloco a partir das linhas da consulta. Puro e exportado: é aqui que o
 * teto, a deduplicação e a ordem determinística se provam sem banco.
 *
 * Ordem alfabética de propósito — duas leituras do mesmo contato têm de produzir
 * o MESMO texto, senão o cache do provedor (prefixo estável) é inútil e um teste
 * de "o prompt leva estes fatos" passa a depender da ordem que o banco devolveu.
 */
export function montarFatosDoCrm(
  negocios: readonly NegocioAbertoRow[],
  etiquetasBrutas: readonly unknown[] | null | undefined,
): FatosDoCrm {
  const porFunil = new Map<string, { funil: string; etapas: Set<string> }>();
  for (const linha of negocios) {
    const funil = normalizarNome(linha?.funil);
    if (funil === '') continue;
    const atual = porFunil.get(funil) ?? { funil, etapas: new Set<string>() };
    const etapa = normalizarNome(linha?.etapa);
    if (etapa !== '') atual.etapas.add(etapa);
    porFunil.set(funil, atual);
  }

  const funis = [...porFunil.values()]
    .map((f) => ({ funil: f.funil, etapas: [...f.etapas].sort((a, b) => a.localeCompare(b, 'pt-BR')) }))
    .sort((a, b) => a.funil.localeCompare(b.funil, 'pt-BR'));

  const etiquetas: string[] = [];
  const vistas = new Set<string>();
  for (const bruta of etiquetasBrutas ?? []) {
    const tag = normalizarNome(bruta);
    if (tag === '') continue;
    const chave = chaveDeEtiqueta(tag);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    etiquetas.push(tag);
  }
  etiquetas.sort((a, b) => a.localeCompare(b, 'pt-BR'));

  return {
    funis: funis.slice(0, MAX_FUNIS_NO_CLASSIFICADOR).map((f) => ({
      funil: f.funil,
      etapas: f.etapas.slice(0, MAX_ETAPAS_POR_FUNIL),
    })),
    etiquetas: etiquetas.slice(0, MAX_ETIQUETAS_NO_CLASSIFICADOR),
    funisOmitidos: Math.max(0, funis.length - MAX_FUNIS_NO_CLASSIFICADOR),
    etiquetasOmitidas: Math.max(0, etiquetas.length - MAX_ETIQUETAS_NO_CLASSIFICADOR),
  };
}

/** Há algum fato para informar? Sem isso o bloco não entra no prompt. */
export function temFatosDoCrm(fatos: FatosDoCrm | null | undefined): fatos is FatosDoCrm {
  if (!fatos) return false;
  return fatos.funis.length > 0 || fatos.etiquetas.length > 0;
}

/**
 * O bloco em texto. `''` quando não há fato — um bloco dizendo "nenhum" custaria
 * tokens em toda mensagem para informar ausência que o classificador já trata
 * como "sem informação" (mesma direção de `renderCompromissos`).
 */
export function formatarFatosDoCrm(fatos: FatosDoCrm | null | undefined): string {
  if (!temFatosDoCrm(fatos)) return '';

  const linhas: string[] = [];
  for (const f of fatos.funis) {
    const etapas = f.etapas.length > 0 ? `, etapa ${f.etapas.map((e) => `"${e}"`).join(' / ')}` : '';
    linhas.push(`- Funil "${f.funil}"${etapas}: negócio ABERTO`);
  }
  if (fatos.etiquetas.length > 0) {
    linhas.push(`- Etiquetas do contato: ${fatos.etiquetas.join(', ')}`);
  }

  const omitidos: string[] = [];
  if (fatos.funisOmitidos > 0) omitidos.push(`${fatos.funisOmitidos} funil(is)`);
  if (fatos.etiquetasOmitidas > 0) omitidos.push(`${fatos.etiquetasOmitidas} etiqueta(s)`);
  if (omitidos.length > 0) {
    linhas.push(`- (o contato tem mais ${omitidos.join(' e ')} — a lista acima não é completa)`);
  }

  // Teto do bloco: corta por LINHA inteira, nunca no meio de um fato, e diz que
  // cortou — linha truncada no meio vira dado errado lido como verdadeiro.
  const cabem: string[] = [];
  let total = 0;
  for (const linha of linhas) {
    if (total + linha.length + 1 > MAX_CARACTERES_DOS_FATOS && cabem.length > 0) {
      cabem.push('- (mais fatos omitidos por limite de tamanho)');
      break;
    }
    cabem.push(linha);
    total += linha.length + 1;
  }
  return cabem.join('\n');
}
