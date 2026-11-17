/**
 * A TABELA DE VALORES DE NEGOCIAÇÃO — o vocabulário compartilhado.
 *
 * ─── O problema que a tabela resolve (issue #4612) ────────────────────────
 *
 * A empresa quer que o agente negocie preço dentro de uma margem: ela oferece
 * um valor de PARTIDA e aceita subir até um valor LIMITE, procedimento a
 * procedimento. Produto tem preço único, sem faixa; desconto passa por pedido
 * interno com aprovação humana, que não serve para negociar uma tabela inteira.
 * E no prompt isto não cabe: são centenas ou milhares de linhas.
 *
 * Esta fatia é a BASE: importar a tabela da planilha e ler por procedimento.
 * A conversa de negociação, o histórico de contrapropostas e a aprovação acima
 * do limite são as fatias seguintes — nada aqui fala com o agente.
 *
 * ─── Dinheiro em centavos inteiros ────────────────────────────────────────
 *
 * `valor_us_*_cents` e `valor_brl_*_cents` são inteiros, como o resto do repo
 * (`value_cents`, `teto_ia_usd_cents`). Não é preciosismo: `0.1 + 0.2` em ponto
 * flutuante é `0.30000000000000004`, e a comparação "limite >= partida" é
 * justamente a cerca que não pode errar por arredondamento.
 */

/**
 * Por que uma linha NÃO entrou. A lista é FECHADA: motivo novo entra aqui,
 * ganha texto em `TEXTO_DO_MOTIVO` e entra na tela.
 *
 * O motivo por LINHA (e não só o total) é o que deixa o operador consertar a
 * planilha de primeira: "3 linhas recusadas" manda ele reimportar no escuro;
 * "linha 47: valor limite menor que o valor de partida" resolve.
 */
export const MOTIVOS_DE_RECUSA = [
  "sem_codigo",
  "sem_descricao",
  "sem_valor",
  "valor_invalido",
  "faixa_incompleta",
  "limite_menor_que_partida",
  "repetido_na_planilha",
  "ja_existe_na_tabela",
] as const;

export type MotivoDeRecusa = (typeof MOTIVOS_DE_RECUSA)[number];

/**
 * O motivo em português — é a CHAVE do dicionário (`lib/i18n/tabela-de-valores`),
 * não um `catch` no meio do caminho: a tela traduz esta frase.
 */
export const TEXTO_DO_MOTIVO: Record<MotivoDeRecusa, string> = {
  sem_codigo: "Sem o código do procedimento.",
  sem_descricao: "Sem a descrição do procedimento.",
  sem_valor: "Sem valor de partida em US nem em reais.",
  valor_invalido: "Valor não é um número válido.",
  faixa_incompleta: "Tem valor de partida sem valor limite (ou o contrário).",
  limite_menor_que_partida: "O valor limite é menor que o valor de partida.",
  repetido_na_planilha: "O código do procedimento se repete na planilha.",
  ja_existe_na_tabela: "Este procedimento já está na tabela.",
};

/** Um procedimento como ele fica na tabela. Dinheiro em centavos; nulo = moeda não cotada. */
export interface ItemDaTabela {
  codigo: string;
  descricao: string;
  valor_us_partida_cents: number | null;
  valor_us_limite_cents: number | null;
  valor_brl_partida_cents: number | null;
  valor_brl_limite_cents: number | null;
  unidade: string | null;
  observacao: string | null;
}

/** Uma linha que ENTRA, com o número que a pessoa vê na planilha (1 = cabeçalho). */
export interface LinhaDaTabela {
  linha: number;
  item: ItemDaTabela;
}

/** Uma linha que NÃO entra, com motivo e o detalhe que a frase-chave não carrega. */
export interface LinhaRecusada {
  linha: number;
  codigo: MotivoDeRecusa;
  /** A frase pronta (`TEXTO_DO_MOTIVO`) — chave do dicionário. */
  motivo: string;
  /** O que o código do procedimento era, quando a planilha tinha um (ajuda a achar no Excel). */
  codigo_do_procedimento?: string;
  /** Detalhe fora da frase (ex.: "US", "linha 12") — frase com número não cabe no dicionário. */
  detalhe?: string;
}

/** O que a leitura da planilha devolve: o que entrou, o que não entrou e por quê. */
export interface LeituraDaTabelaDeValores {
  itens: LinhaDaTabela[];
  fora: LinhaRecusada[];
  colunasIgnoradas: string[];
}

/** A prévia: a mesma leitura já classificada contra o que a tabela tem hoje. */
export interface PreviaDaTabela {
  entram: LinhaDaTabela[];
  fora: LinhaRecusada[];
  /** Quantas linhas ficaram em cada motivo — zero incluído, para a tela não esconder a coluna. */
  resumo: Record<MotivoDeRecusa, number>;
  /** Linhas de dados lidas: `entram.length + fora.length`. */
  total_linhas: number;
  /** SHA-256 do arquivo: é a chave estável que impede a mesma planilha de entrar duas vezes. */
  chave_do_arquivo: string;
}

export function resumoVazio(): Record<MotivoDeRecusa, number> {
  return MOTIVOS_DE_RECUSA.reduce(
    (acc, m) => ({ ...acc, [m]: 0 }),
    {} as Record<MotivoDeRecusa, number>,
  );
}

export function motivosDe(linhas: readonly LinhaRecusada[]): Record<MotivoDeRecusa, number> {
  const resumo = resumoVazio();
  for (const l of linhas) resumo[l.codigo] += 1;
  return resumo;
}

/** Teto de linhas por planilha — o mesmo teto do leitor de arquivo (`IMPORT_MAX_DATA_ROWS`). */
export const TABELA_MAX_LINHAS = 2_000;
