/**
 * O VALOR RECORRENTE DO NEGÓCIO — a régua pura da fatia 1 da issue #3602.
 *
 * ─── O que este módulo decide (e o que ele NÃO decide) ───────────────────────
 *
 * `crm_leads.value_cents` continua sendo o VALOR ÚNICO do contrato — setup,
 * implantação, matrícula, avaliação. Ao lado dele o negócio passou a guardar:
 *
 *   `recurring_value_cents` — quanto entra por período (a mensalidade);
 *   `recurring_period`      — a periodicidade; a v1 conhece UMA (`monthly`);
 *   `recurring_months`      — a duração em meses; `null` = sem prazo.
 *
 * Três colunas e nenhuma delas derivada: o produto NÃO soma o único com o
 * recorrente em lugar nenhum. Somar é o defeito que a issue descreve ("ou o
 * setup, e o negócio parece 6× menor; ou tudo num número, e ninguém sabe quanto
 * entra todo mês"). O que a tela mostra é a SOMA EXPLÍCITA de duas parcelas
 * visíveis — R$ 3.000 + R$ 500/mês —, nunca um total só.
 *
 * As regras que moram aqui são as que o banco, o handler, o card, o painel e a
 * última compra precisam responder IGUAL:
 *
 *  1. recorrente ausente/nulo significa "não há recorrência" — e aí
 *     periodicidade e duração são nulas TAMBÉM (o trio não pode ficar órfão:
 *     `recurring_months = 12` sem mensalidade é dado que mente);
 *  2. recorrente presente SEM periodicidade nasce MENSAL (a v1 só tem essa, e o
 *     default é do PRODUTO, não do formulário: o MCP e o webhook também gravam);
 *  3. o rótulo de quem lê é `"R$ 500/mês"` — e `null` quando não há recorrência,
 *     para nenhuma tela inventar "/mês" num negócio de valor único.
 *
 * O que NÃO mora aqui: formatação de moeda (é do `lib/money.ts`, a fonte única
 * da régua ×100) e o preço do contrato (único + recorrente × meses). Esse
 * segundo é decisão de PRODUTO da fatia 2 — enquanto os painéis não separam os
 * dois, um "valor do contrato" na tela seria um número que ninguém pediu.
 */
import { MOEDA_PADRAO, formatValorDoNegocio, parseReaisToCents } from "@/lib/money";

/** A periodicidade da v1. `text` no banco (vocabulário aberto, como o `layer`). */
export const PERIODICIDADE_PADRAO = "monthly";

/** As periodicidades que este build conhece — o CHECK da migration espelha. */
export const PERIODICIDADES: readonly string[] = [PERIODICIDADE_PADRAO];

/** Como a periodicidade aparece colada ao valor (`R$ 500/mês`). */
export const ROTULO_DA_PERIODICIDADE: Record<string, string> = {
  monthly: "/mês",
};

/** O trio como ele existe na linha do banco. */
export interface RecorrenciaDoNegocio {
  recurring_value_cents: number | null;
  recurring_period: string | null;
  recurring_months: number | null;
}

/** O que uma escrita pode mencionar — cada chave é opcional. */
export interface RecorrenciaNoPatch {
  recurring_value_cents?: number | null;
  recurring_period?: string | null;
  recurring_months?: number | null;
}

const CAMPOS = ["recurring_value_cents", "recurring_period", "recurring_months"] as const;

/**
 * Esta escrita menciona o recorrente?
 *
 * É o que separa "não mexi no recorrente" (o PATCH não toca nas colunas) de
 * "limpei o recorrente" (`recurring_value_cents: null`, que zera o trio). Sem a
 * distinção, todo PATCH de título apagaria a mensalidade do negócio.
 */
export function mencionaRecorrencia(patch: RecorrenciaNoPatch): boolean {
  return CAMPOS.some((campo) => patch[campo] !== undefined);
}

/**
 * O trio que vai para o banco, já coerente.
 *
 * Recorrente nulo limpa periodicidade e duração; recorrente presente sem
 * periodicidade ganha a mensal. Duração não informada continua `null` (= sem
 * prazo), que é estado legítimo — "sem prazo" é diferente de "12 meses".
 */
export function recorrenciaParaGravar(patch: RecorrenciaNoPatch): RecorrenciaDoNegocio {
  const valor = patch.recurring_value_cents ?? null;
  if (valor === null) {
    return { recurring_value_cents: null, recurring_period: null, recurring_months: null };
  }
  return {
    recurring_value_cents: valor,
    recurring_period: patch.recurring_period ?? PERIODICIDADE_PADRAO,
    recurring_months: patch.recurring_months ?? null,
  };
}

/**
 * `"R$ 500/mês"` — ou `null` quando o negócio não tem recorrência.
 *
 * A moeda é a do NEGÓCIO (a organização é a reserva, como no `value_cents`), e a
 * régua é `formatValorDoNegocio`: valor de negócio é ×100 em QUALQUER moeda
 * (inclusive guarani), e é o mesmo formatador do card e do total da coluna.
 *
 * `semCentavos` acompanha quem chama (o card não mostra centavos; o painel
 * mostra). `sufixo` existe para a tela traduzir ("/mes" em espanhol) sem
 * duplicar a regra de qual texto cabe em qual periodicidade.
 */
/** O que o formulário conseguiu ler dos dois campos de texto. */
export type LeituraDoFormulario =
  | { ok: true; trio: RecorrenciaDoNegocio }
  | { ok: false; campo: "valor" | "meses"; motivo: "valor_invalido" | "duracao_invalida" | "duracao_sem_mensalidade" };

/**
 * Lê os dois campos como o formulário os entrega (texto) e devolve o trio que
 * vai para a API — OU o motivo da recusa, para o campo certo ficar vermelho.
 *
 * Existe porque TRÊS formulários escrevem o negócio (criar, editar pelo funil,
 * editar pelo dossiê) e todos têm o mesmo par de campos: mensalidade em texto
 * (a moeda da organização decide a vírgula, #3331) e duração em meses. Sem uma
 * régua só, "1.500" viraria 1,5 em um formulário e 1.500 no outro — o defeito
 * que o `parseReaisToCents` já pagou caro neste produto.
 *
 * Duração sem mensalidade é RECUSA, não descarte silencioso: quem digitou "12"
 * espera 12 meses gravados, e o banco recusa o órfão de propósito (o CHECK da
 * 9028 exige o trio coerente).
 */
export function lerRecorrenciaDoFormulario(
  reais: string,
  meses: string,
  moeda: string = MOEDA_PADRAO,
): LeituraDoFormulario {
  const textoDoValor = reais.trim();
  let centavos: number | null = null;
  if (textoDoValor.length > 0) {
    centavos = parseReaisToCents(textoDoValor, moeda);
    if (centavos === null) return { ok: false, campo: "valor", motivo: "valor_invalido" };
  }

  const textoDosMeses = meses.trim();
  if (textoDosMeses.length === 0) {
    return { ok: true, trio: recorrenciaParaGravar({ recurring_value_cents: centavos }) };
  }
  if (centavos === null) {
    return { ok: false, campo: "valor", motivo: "duracao_sem_mensalidade" };
  }
  // Só dígitos: "12 meses" e "1,5" são recusados em vez de virarem 12 e 1 em
  // silêncio — a duração é um número de meses inteiro, e o CHECK do banco
  // aceita 1..600. A régua da tela e a do banco têm de ser a MESMA, senão o
  // usuário vê "salvo" e a requisição volta 400.
  if (!/^\d+$/.test(textoDosMeses)) {
    return { ok: false, campo: "meses", motivo: "duracao_invalida" };
  }
  const duracao = Number.parseInt(textoDosMeses, 10);
  if (duracao < 1 || duracao > 600) {
    return { ok: false, campo: "meses", motivo: "duracao_invalida" };
  }
  return {
    ok: true,
    trio: recorrenciaParaGravar({ recurring_value_cents: centavos, recurring_months: duracao }),
  };
}

export function rotuloDaRecorrencia(
  recurringValueCents: number | null | undefined,
  periodicidade: string | null | undefined,
  moeda: string = MOEDA_PADRAO,
  opcoes: { semCentavos?: boolean; sufixo?: string } = {},
): string | null {
  if (recurringValueCents === null || recurringValueCents === undefined) return null;
  const sufixo =
    opcoes.sufixo ??
    ROTULO_DA_PERIODICIDADE[periodicidade ?? PERIODICIDADE_PADRAO] ??
    ROTULO_DA_PERIODICIDADE[PERIODICIDADE_PADRAO]!;
  return `${formatValorDoNegocio(recurringValueCents, moeda, { semCentavos: opcoes.semCentavos })}${sufixo}`;
}
