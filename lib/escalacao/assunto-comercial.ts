import type { SupabaseClient } from "@supabase/supabase-js";

import { CAMADA_RESTRICAO_COMERCIAL } from "@/lib/agent-engine/guardrails/camadas-da-org";

/**
 * Triagem conservadora de valores/negociação, nunca valida preço ou condição.
 *
 * Número sozinho NÃO é preço: data e hora com ponto ("dia 15.10 às 14.30"),
 * frequência ("2x ao dia") e porcentagem solta ("40% de visão") passavam por
 * valor e mandavam à equipe conversa de clínica e de agenda. O número só conta
 * com contexto de preço: moeda, parcela ("em 3x", "10x de") ou "% off".
 */
const normalizar = (texto: string): string => texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function contemAssuntoComercialRestrito(texto: string): boolean {
  const normal = normalizar(texto);
  return /\b(?:precos?|prec[io]+s?|custa\w*|custos?|quanto (?:fica|sai|e|seria)|descont\w*|negoci\w*|parcel\w*|pagamento\w*|pagar|pag[ao]s?|pix|boleto\w*|credito|debito|promoc\w*|oferta\w*|orcamento\w*|reais|gratis|gratuit\w*|barat\w*|caro|cobran\w*|cobra(?:m|r|mos)?|reembolso\w*|estorno\w*|investimentos?|mensalidades?|anuidades?|sem juros)\b/u.test(normal)
    // "valor" só quando é o do produto: "qual o valor?", "valor da consulta" — não "valor nutricional".
    || /\bvalor(?:es)?(?=\s*(?:$|[?!.,;]|d[aeo]s?\b|total\b|final\b|a vista\b|pra\b|para\b|com desconto\b))/u.test(normal)
    || /(?:r\$|us\$|\$|€|£)\s*\d/u.test(normal)
    || /\b(?:em|ate|de)\s+\d{1,2}\s*x\b|\b\d{1,2}\s*x\s*(?:de\b|sem juros\b|no cartao\b)/u.test(normal)
    // "em 10 vezes" é parcela; "2 vezes ao dia" é remédio e não chega aqui.
    || /\b(?:em|ate)\s+\d{1,2}\s*vezes\b|\b\d{1,2}\s*vezes\s+no cartao\b/u.test(normal)
    || /\b\d+(?:[.,]\d+)?\s*%\s*off\b/u.test(normal)
    // ponytail: vírgula com 2 casas é preço ("299,90"); com ponto é data/hora, e não conta.
    || /\b\d+,\d{2}\b/u.test(normal)
    || /\b(?:fica|sai|apenas|somente|a partir de)\s*(?:por|em)?\s*\d/u.test(normal);
}

/**
 * A trava de SAÍDA (`commercialRestrictionGate`): tudo o que a entrada pega e mais.
 *
 * Pode ser mais estrita que a triagem de entrada porque o custo do erro é outro:
 * na entrada, um falso positivo manda à equipe uma conversa que a IA atenderia;
 * aqui, só barra uma resposta que a IA escreveu e passa a conversa adiante. O que
 * entra só aqui: moeda sem número colado ("R$", "BRL", "USD", "EUR"), "valor" e
 * "à vista" soltos, as palavras de preço em espanhol e inglês, moeda por extenso
 * ("cem euros"), decimal com ponto em posição de preço ("por 299.90", "299.90
 * cada"), honorários/abatimento/cupom/pesos, parcela com valor depois ("10 vezes
 * de 29", "10 vezes 99", "3x 600", "12x 50", "12x150") e inteiro ou milhar depois de verbo de preço ("faço
 * 1800", "por 1.800"). "N vezes" sozinho é frequência ("remarcou 3 vezes", "use 2
 * vezes diariamente") e não conta; "em/até N vezes", "N vezes sem juros" e "N vezes
 * no cartão" já vêm da entrada. Data e hora com ponto continuam fora: sem palavra
 * de preço por perto, "15.10 às 14.30" não é dinheiro.
 */
const PRECO_SO_NA_SAIDA: readonly RegExp[] = [
  /(?:r|us)\$|€|£|\b(?:brl|usd|eur)\b/u,
  /\b(?:valor(?:es)?|a vista|descuent\w*|cuotas?|cuesta\w*|precios?|prices?|pricing|costs?|costos?|discounts?|dolar(?:es)?|dollars?|euros?)\b/u,
  /\b(?:por|cada)\s+\d+[.,]\d{2}\b|\b\d+[.,]\d{2}\s*(?:cada|por mes|ao mes|mensais)\b/u,
  /\b(?:honorarios?|abatimentos?|cupo(?:m|ns))\b|\b\d[\d.,]*\s*pesos\b/u,
  // Parcela com o valor colado: "10 vezes de 29", "3x 600", "12x de 150", "12x150".
  // ponytail: na forma "Nx" o valor precisa de 3 dígitos ou centavos — "foto 3x4" e
  // "3x12 repetições" ficam de fora, e "10x 50" também (vai pela palavra de preço, se houver).
  /\b\d{1,2}\s*vezes\s+de\s+(?:r\$\s*)?\d|\b\d{1,2}\s*x\s*(?:de\s+)?(?:r\$\s*)?(?:\d{3,}|\d+[.,]\d{2})(?![\d/:-])/u,
  // Parcela com espaço e sem "de": "10 vezes 99", "12x 50", "3 vezes 200". O valor tem 2+
  // dígitos e não é seguido de unidade nem frequência ("2x 30 minutos", "3 vezes 10 repetições").
  // ponytail: a lista de unidades é a régua; outra contagem ("3x 10 agachamentos") barra e vai à equipe.
  /\b\d{1,2}(?:\s*vezes|x)\s+(?:r\$\s*)?\d{2,}(?![\d/:-]|[.,]\d|\s*(?:x|cm|mm|m|metros?|kg|g|mg|ml|l|h|min|minutos?|horas?|dias?|semanas?|meses|repeti\w*|series?|comprimidos?|gotas?|ao dia|por (?:dia|semana)|diariamente)\b)/u,
  // Inteiro ou milhar com ponto depois de verbo/preposição de preço ("por 1.800",
  // "faço 1800"). Ano, hora, telefone e porcentagem ficam de fora; "mais de 1.000
  // clientes" também. ponytail: a lista de quantificadores antes de "de" é a régua; contagem
  // que vier com outra palavra ("turma de 300 alunos") barra o envio e vai à equipe.
  /(?:\b(?:por|faco|fazer|sai a|saindo a)|(?<!\b(?:mais|menos|cerca|acima|alem)\s)\bde)\s+(?!(?:19|20)\d{2}\b)(?:\d{1,3}(?:\.\d{3})+|\d{3,})(?![\d,]|[-/:.]\d|\s*%)/u,
];

export function contemAssuntoComercialNaSaida(texto: string): boolean {
  if (contemAssuntoComercialRestrito(texto)) return true;
  const normal = normalizar(texto);
  return PRECO_SO_NA_SAIDA.some((re) => re.test(normal));
}

/**
 * A saída deste corpo fica barrada pela restrição comercial? Uma decisão só para
 * os dois caminhos que mandam texto ao cliente: a cadeia (`runBeforeSend`) e o
 * atalho inline do texto fixo do follow-up (`enviarTextoFixoPendente`), que não
 * passa por ela. Só lê a escolha da organização quando o corpo tem cara de preço.
 *
 * Falha FECHADA: a leitura que estoura vale como restrição ligada. O pior
 * desfecho é uma mensagem com preço barrada numa org que não restringiu (vai à
 * equipe); o contrário seria a IA negociando numa org que proibiu.
 */
export async function restricaoComercialBarra(
  body: string,
  lerEscolha: () => Promise<boolean>,
  avisar: (mensagem: string, contexto: Record<string, unknown>) => void,
): Promise<boolean> {
  if (!contemAssuntoComercialNaSaida(body)) return false;
  try {
    return await lerEscolha();
  } catch (err) {
    avisar("restrição comercial não lida — tratada como ligada (falha fechada)", {
      error: err instanceof Error ? err.message.slice(0, 120) : "erro desconhecido",
    });
    return true;
  }
}

/**
 * A organização ligou "valores e negociação com a equipe" (painel Segurança do agente)?
 *
 * Lida à PARTE de `lerCamadasDaOrg`, e não por esquecimento: aquela leitura falha
 * ABERTA (devolve "sem escolha" quando estoura), e aqui a falha precisa ser
 * FECHADA. Leitura que lança derruba o turno — o job volta para a fila e tenta de
 * novo — em vez de virar permissão silenciosa para a IA negociar.
 */
export async function comercialExigeHumano(
  db: { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ enabled: unknown }> }> },
  organizationId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    "select enabled from org_guardrail_layers where organization_id = $1 and layer = $2",
    [organizationId, CAMADA_RESTRICAO_COMERCIAL],
  );
  return rows[0]?.enabled === true;
}

/** `comercialExigeHumano` para quem só tem o client do Supabase (o atalho inline). Erro LANÇA. */
export async function comercialExigeHumanoViaSupabase(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("org_guardrail_layers")
    .select("enabled")
    .eq("organization_id", organizationId)
    .eq("layer", CAMADA_RESTRICAO_COMERCIAL)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { enabled?: unknown } | null)?.enabled === true;
}
