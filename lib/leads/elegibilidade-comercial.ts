/**
 * ELEGIBILIDADE COMERCIAL DO NEGÓCIO (#4191) — a fonte canônica.
 *
 * ─── O buraco que este arquivo fecha ────────────────────────────────────────
 *
 * O negócio tinha dois desfechos (`won`/`lost`) e nenhum jeito de dizer "isto
 * nunca foi uma oportunidade". A saída que a operação usava era pior nos dois
 * sentidos: marcar perdido inventa uma perda comercial ("perdemos por preço"
 * para um golpe) e excluir o card apaga contato, conversa e atividades.
 *
 * A classificação vive em TRÊS colunas de `crm_leads` (migration 9222) e a
 * coluna que DECIDE é `nao_comercial_em`: nula é o estado de sempre, comercial.
 * `nao_comercial_motivo` e `nao_comercial_por` são o lastro humano — por quê e
 * quem —, não a elegibilidade.
 *
 * ─── Por que a regra mora aqui, e não em cada consumidor ────────────────────
 *
 * Radar, funil e (adiante) qualquer lista comercial precisam da MESMA resposta
 * para o mesmo negócio. Espalhar `nao_comercial_em is null` por quatro arquivos
 * é o defeito clássico já medido neste repositório: as cópias começam iguais e
 * divergem no primeiro ajuste, e a divergência aparece como "o painel conta uma
 * coisa e o Radar outra". Por isso o predicado é exportado, e não reescrito.
 *
 * ─── O que este arquivo NÃO decide ─────────────────────────────────────────
 *
 * Não inventa vocabulário de motivo (a issue deixa a lista "a discutir"), não
 * bloqueia comunicação e não decide o que fazer com um negócio JÁ encerrado —
 * a issue pergunta ao mantenedor se a classificação vale independente do
 * desfecho, e até essa resposta a operação aceita só negócio ABERTO, que é o
 * caso descrito (`negocio_encerrado`, 409).
 */

/** Teto do motivo. É texto que aparece na tela e na timeline, não um relatório. */
export const MAX_MOTIVO_NAO_COMERCIAL = 200;

/** O mínimo é "alguém escreveu alguma coisa": vazio não é motivo. */
export const MIN_MOTIVO_NAO_COMERCIAL = 3;

/**
 * As colunas da classificação — a lista viaja junto do `select` de quem lê
 * (`classificacao-comercial.ts`) para o teste de vocabulário do banco poder
 * compará-la com a migration sem duplicar string.
 */
export const COLUNAS_DA_CLASSIFICACAO = [
  "nao_comercial_em",
  "nao_comercial_motivo",
  "nao_comercial_por",
] as const;

/** O pedaço de linha que basta para decidir elegibilidade. */
export interface LinhaClassificavel {
  nao_comercial_em?: string | null;
  nao_comercial_motivo?: string | null;
}

/**
 * O predicado canônico: o negócio está FORA do comercial?
 *
 * Aceita `null`/`undefined` de propósito — linha que não pediu a coluna (ou
 * join que não veio) é comercial, que é o estado de sempre. Uma versão que
 * lançasse aqui obrigaria cada leitor a tratar o caso, e o caminho de erro de
 * uma lista seria "esconder o negócio", o oposto do que a issue pede.
 */
export function ehNaoComercial(linha: LinhaClassificavel | null | undefined): boolean {
  const quando = linha?.nao_comercial_em;
  return typeof quando === "string" && quando.trim() !== "";
}

/** Inverso explícito, para o leitor não precisar de `!` nem de dupla negação. */
export function ehComercial(linha: LinhaClassificavel | null | undefined): boolean {
  return !ehNaoComercial(linha);
}

/**
 * Filtro de lista: devolve só os comerciais, preservando a ordem. É o que as
 * leituras que já trazem as linhas usam (funil, radar) — o filtro no banco é a
 * primeira barreira, não a única, porque lista auxiliar pode vir de outro
 * `select`.
 */
export function apenasComerciais<T extends LinhaClassificavel>(linhas: readonly T[]): T[] {
  return linhas.filter((l) => ehComercial(l));
}

export type CodigoDeRecusaDoMotivo = "motivo_obrigatorio" | "motivo_curto" | "motivo_longo";

export interface RecusaDoMotivo {
  codigo: CodigoDeRecusaDoMotivo;
  mensagem: string;
}

/**
 * Normaliza o motivo digitado: uma linha só (quebra de linha num campo de
 * formulário viraria duas linhas na timeline), sem espaço sobrando. Nome de
 * funil e etiqueta seguem a mesma régua (`normalizarNome` no
 * `fatos-do-crm-do-contato`).
 */
export function normalizarMotivoDoNaoComercial(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;
  const limpo = bruto.replace(/\s+/g, " ").trim();
  return limpo === "" ? null : limpo;
}

/**
 * A recusa do motivo, ou `null` quando ele serve. Separada da normalização
 * porque a tela precisa da FRASE e o serviço precisa do CÓDIGO — e porque
 * testar as bordas (vazio, curto, longo, não-texto) não deve exigir banco.
 */
export function recusaDoMotivoDoNaoComercial(bruto: unknown): RecusaDoMotivo | null {
  const limpo = normalizarMotivoDoNaoComercial(bruto);
  if (limpo === null) {
    return {
      codigo: "motivo_obrigatorio",
      mensagem: "Informe o motivo da classificação como não comercial.",
    };
  }
  if (limpo.length < MIN_MOTIVO_NAO_COMERCIAL) {
    return {
      codigo: "motivo_curto",
      mensagem: `O motivo precisa de pelo menos ${MIN_MOTIVO_NAO_COMERCIAL} caracteres.`,
    };
  }
  if (limpo.length > MAX_MOTIVO_NAO_COMERCIAL) {
    return {
      codigo: "motivo_longo",
      mensagem: `O motivo passa de ${MAX_MOTIVO_NAO_COMERCIAL} caracteres; resuma o que decide o caso.`,
    };
  }
  return null;
}

/** A linha como o serviço a leu do banco (só o que a decisão precisa). */
export interface EstadoDaClassificacao {
  status: string;
  nao_comercial_em: string | null;
  nao_comercial_motivo: string | null;
}

export type DecisaoDaClassificacao =
  | { acao: "classificar"; motivo: string }
  /** Já estava assim com o MESMO motivo: repetir a operação não escreve nada. */
  | { acao: "nada"; motivo: string }
  | { acao: "recusar"; codigo: string; mensagem: string; httpStatus: number };

const mesmoMotivo = (a: string, b: string): boolean =>
  a.localeCompare(b, "pt-BR", { sensitivity: "base" }) === 0;

/**
 * A regra da classificação, pura. A ordem importa e é o que os testes medem:
 *
 * 1. motivo inválido é recusado ANTES de qualquer leitura de estado — corpo
 *    errado não depende do negócio;
 * 2. negócio encerrado é recusado (409): a issue pergunta ao mantenedor se a
 *    classificação vale independente de ganho/perda e essa resposta não existe;
 *    classificar um encerrado hoje mudaria métrica de desfecho sem decisão;
 * 3. repetição com o mesmo motivo é IDEMPOTENTE — a operação é um clique, e
 *    dois cliques não podem virar duas linhas na timeline;
 * 4. motivo DIFERENTE é conflito (409), nunca sobrescrita silenciosa: alguém
 *    revisou antes. Corrigir é reverter e classificar de novo, com rastro.
 */
export function decidirClassificacao(
  estado: EstadoDaClassificacao,
  motivoBruto: unknown,
): DecisaoDaClassificacao {
  const recusa = recusaDoMotivoDoNaoComercial(motivoBruto);
  if (recusa !== null) {
    return { acao: "recusar", codigo: recusa.codigo, mensagem: recusa.mensagem, httpStatus: 422 };
  }
  const motivo = normalizarMotivoDoNaoComercial(motivoBruto) as string;

  if (estado.status !== "open") {
    return {
      acao: "recusar",
      codigo: "negocio_encerrado",
      mensagem:
        "Só um negócio aberto pode ser classificado como não comercial. Este já tem desfecho (ganho ou perda).",
      httpStatus: 409,
    };
  }

  if (ehNaoComercial(estado)) {
    const atual = normalizarMotivoDoNaoComercial(estado.nao_comercial_motivo);
    if (atual !== null && mesmoMotivo(atual, motivo)) return { acao: "nada", motivo };
    return {
      acao: "recusar",
      codigo: "classificacao_conflitante",
      mensagem:
        "Este negócio já foi classificado por outra pessoa com outro motivo. Reveja antes de mudar a classificação.",
      httpStatus: 409,
    };
  }

  return { acao: "classificar", motivo };
}

export type DecisaoDaReversao = { acao: "reverter" } | { acao: "nada" };

/**
 * Reverter é apagar as três colunas — não há quarto estado. Repetir a reversão
 * num negócio já comercial não escreve nada (nem timeline): a tela pode mostrar
 * o botão, e dois cliques não podem gerar duas linhas de "voltou ao comercial".
 */
export function decidirReversao(estado: LinhaClassificavel): DecisaoDaReversao {
  return ehNaoComercial(estado) ? { acao: "reverter" } : { acao: "nada" };
}

/** O motivo para a timeline: o declarado, sem invenção quando veio vazio. */
export function motivoParaATimeline(motivo: string | null | undefined): string {
  const limpo = normalizarMotivoDoNaoComercial(motivo);
  return limpo ?? "sem motivo registrado";
}
