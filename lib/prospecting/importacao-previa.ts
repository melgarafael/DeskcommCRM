import type { Prospect } from "@/lib/prospecting/schema";

/**
 * A PRÉVIA DA IMPORTAÇÃO — quem entra na campanha e quem fica de fora, com o motivo escrito.
 *
 * A planilha do operador não é uma lista limpa: metade das linhas morre no caminho, e cada uma
 * morre por um motivo DIFERENTE. Devolver só "12 linhas recusadas" faz o operador reimportar o
 * mesmo arquivo três vezes atrás do problema; devolver o motivo de cada linha — com o número
 * que a pessoa vê no Excel — é a única versão da prévia que serve para consertar a planilha.
 *
 * Este arquivo é PURO de propósito: recebe os candidatos já lidos e os dois conjuntos de
 * telefones que o banco conhece (contatos do CRM e suprimidos por LGPD), e não sabe consultar
 * nada. Assim a mesma classificação roda na prévia (sem escrever) e na importação (dentro do
 * lock), sem duas versões da regra divergindo.
 */

/** Os motivos, na ordem em que o operador os lê. A lista é fechada: motivo novo entra AQUI. */
export const MOTIVOS_DE_EXCLUSAO = [
  "sem_nome",
  "sem_telefone",
  "telefone_invalido",
  "repetido_na_planilha",
  "contato_do_crm",
  "suprimido_lgpd",
] as const;

export type MotivoDeExclusao = (typeof MOTIVOS_DE_EXCLUSAO)[number];

/**
 * O motivo em português, como sai na tela e no `api_audit_log`.
 *
 * `suprimido_lgpd` NÃO é um detalhe de qualidade de dado: é o pedido de um titular já atendido.
 * Ele aparece por último na lista por ser o único que vem de fora da planilha, mas é conferido
 * PRIMEIRO na classificação — quem pediu para sair não pode ser explicado como "já é contato".
 */
export const TEXTO_DO_MOTIVO: Record<MotivoDeExclusao, string> = {
  sem_nome: "Sem nome da empresa.",
  sem_telefone: "Sem telefone.",
  telefone_invalido: "Telefone inválido.",
  repetido_na_planilha: "Telefone repetido na planilha.",
  contato_do_crm: "Já é contato do CRM.",
  suprimido_lgpd: "Excluído a pedido do titular (LGPD).",
};

/** Uma linha que NÃO entra, com o número que a pessoa vê na planilha (1 = cabeçalho). */
export interface LinhaExcluida {
  linha: number;
  telefone: string | null;
  codigo: MotivoDeExclusao;
  /** A frase pronta (`TEXTO_DO_MOTIVO`) — é a chave do dicionário do espanhol. */
  motivo: string;
  /**
   * O detalhe que NÃO cabe na frase-chave (hoje: a linha da primeira ocorrência do telefone
   * repetido). Fica fora do motivo porque a tela traduz o motivo pelo dicionário e uma frase
   * com número dentro nunca vai estar lá.
   */
  detalhe?: string;
}

/** Uma linha que entra, com a linha de origem preservada para a prévia falar a mesma língua. */
export interface CandidatoNaPlanilha {
  linha: number;
  /** Da planilha só sai candidato COM telefone: a linha sem ele já foi recusada na leitura. */
  prospect: Prospect & { phone: string };
}

/** O mínimo que a prévia precisa da planilha lida — o que `lerPlanilhaDeProspeccao` devolve. */
export interface LeituraComMotivos {
  candidatos: CandidatoNaPlanilha[];
  erros: LinhaExcluida[];
}

/**
 * O que o banco já sabe sobre estes telefones.
 *
 * Os dois conjuntos usam o MESMO telefone normalizado dos candidatos (`Prospect.phone`), então
 * a comparação é de igualdade — as variantes do nono dígito são resolvidas na consulta, que é
 * quem tem `phoneLookupVariants` do lado de lá.
 */
export interface FontesDaPrevia {
  contatos: ReadonlySet<string>;
  suprimidos: ReadonlySet<string>;
}

export interface PreviaDaImportacao {
  entram: CandidatoNaPlanilha[];
  fora: LinhaExcluida[];
  /** Quantas linhas ficaram em cada motivo — zero incluído, para a tela não esconder a coluna. */
  resumo: Record<MotivoDeExclusao, number>;
  /** Linhas de dados lidas: `entram.length + fora.length`. */
  total_linhas: number;
}

export function resumoVazio(): Record<MotivoDeExclusao, number> {
  return MOTIVOS_DE_EXCLUSAO.reduce(
    (acc, m) => ({ ...acc, [m]: 0 }),
    {} as Record<MotivoDeExclusao, number>,
  );
}

export function motivosDe(linhas: LinhaExcluida[]): Record<MotivoDeExclusao, number> {
  const resumo = resumoVazio();
  for (const l of linhas) resumo[l.codigo] += 1;
  return resumo;
}

/**
 * Classifica o que a planilha leu contra o que o banco já sabe.
 *
 * ORDEM DAS PERGUNTAS, e por que ela importa:
 *   1. o que a própria planilha já recusou (sem nome, sem telefone, inválido, repetido);
 *   2. **LGPD** — antes de "já é contato": um titular suprimido que também tem ficha no CRM
 *      aparece como "excluído a pedido do titular", nunca como duplicata. O motivo da saída
 *      é informação do titular, e trocá-lo por um motivo mais confortável esconde a supressão
 *      justamente de quem precisa vê-la;
 *   3. já é contato do CRM.
 */
export function montarPrevia(
  planilha: LeituraComMotivos,
  fontes: FontesDaPrevia,
): PreviaDaImportacao {
  const entram: CandidatoNaPlanilha[] = [];
  const fora: LinhaExcluida[] = [...planilha.erros];

  for (const candidato of planilha.candidatos) {
    const telefone = candidato.prospect.phone;
    if (fontes.suprimidos.has(telefone)) {
      fora.push({
        linha: candidato.linha,
        telefone,
        codigo: "suprimido_lgpd",
        motivo: TEXTO_DO_MOTIVO.suprimido_lgpd,
      });
      continue;
    }
    if (fontes.contatos.has(telefone)) {
      fora.push({
        linha: candidato.linha,
        telefone,
        codigo: "contato_do_crm",
        motivo: TEXTO_DO_MOTIVO.contato_do_crm,
      });
      continue;
    }
    entram.push(candidato);
  }

  // A prévia é lida de cima para baixo, na ordem do arquivo: as recusas da planilha já entraram
  // em ordem, mas as duas listas se intercalam.
  fora.sort((a, b) => a.linha - b.linha);

  return {
    entram,
    fora,
    resumo: motivosDe(fora),
    total_linhas: entram.length + fora.length,
  };
}
