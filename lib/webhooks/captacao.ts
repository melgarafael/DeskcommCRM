/**
 * O REGISTRO DURÁVEL de cada formulário que chegou — o que a tela "Leads
 * recebidos" lê.
 *
 * Distinto do arquivo forense (`webhook_events_log`), que existe para depurar
 * webhook e é PODADO pelo cron a cada 5 min: corpo em D+7, linha em D+90
 * (migration 0163). Ver o cabeçalho da migration 0174 para o argumento inteiro.
 *
 * Escreve com o admin client (a rota de captação é pública e não tem sessão),
 * então TODA chamada carrega o `organization_id` resolvido da FONTE — nunca do
 * body. Nunca lança: um erro ao gravar histórico não pode derrubar a captação
 * do lead, que é o que o cliente do outro lado está esperando.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { logger } from "@/lib/logger";

/** No que a captação deu. Espelha o CHECK de `webhook_lead_captures.outcome`. */
export type DesfechoDaCaptacao = "criado" | "duplicado" | "recusado";

/**
 * Por que uma captação foi recusada. Vocabulário só do TypeScript — a coluna
 * NÃO tem CHECK de propósito: um motivo novo não pode fazer o `update.sh` de um
 * clone quebrar sobre linhas antigas (doutrina de vocabulário aberto do
 * CLAUDE.md).
 */
export type MotivoDaRecusa =
  | "sem_campo_mapeavel"
  | "assinatura_invalida"
  | "assinatura_indecifravel"
  | "erro_ao_criar_lead"
  /** A régua de campos obrigatórios barrou a criação (#2297, caminho 4). */
  | "recusa_da_regra"
  /** Recusa que não é nem do funil nem da etapa da fonte — o rótulo não mente. */
  | "erro_inesperado";

/** O que a tela mostra para cada motivo, em português de gente. */
export const MOTIVO_DA_RECUSA_LABEL: Record<MotivoDaRecusa, string> = {
  sem_campo_mapeavel:
    "O envio não trazia nome, telefone nem e-mail reconhecíveis — confira os nomes dos campos do formulário.",
  assinatura_invalida:
    "A assinatura não conferiu. Quem enviou não usou o segredo configurado nesta fonte.",
  assinatura_indecifravel:
    "O segredo de assinatura desta fonte não pôde ser lido nesta instalação, então nada entra por ela. Cadastre a assinatura de novo na fonte.",
  erro_ao_criar_lead:
    "Os dados chegaram, mas o lead não pôde ser criado — confira se o funil e a etapa da fonte ainda existem.",
  recusa_da_regra:
    "Os dados chegaram, mas a régua de campos obrigatórios recusou o negócio: a etapa do funil exige um campo que o formulário não trouxe.",
  erro_inesperado:
    "Os dados chegaram, mas a criação do negócio falhou por outro motivo — não é nem o funil nem a etapa da fonte.",
};

/**
 * O motivo CERTO para uma recusa de `createLeadHandler` (#2297, caminho 4).
 *
 * O rótulo de `erro_ao_criar_lead` promete "funil e etapa da fonte", e essa
 * promessa só é verdadeira para os códigos que SÃO sobre funil e etapa. Qualquer
 * outra recusa — a régua de campos obrigatórios na frente, uma falha interna —
 * mostrava a frase errada na tela "Leads recebidos", que é justamente onde quem
 * depura a fonte procura por que nada entrou.
 *
 * A isenção da rota (`exigirCamposDaEtapa: false`, decisão do #2295) continua
 * intacta: isto é vocabulário do rótulo, não da régua. O vocabulário da coluna
 * `reject_reason` é ABERTO por decisão escrita no cabeçalho deste arquivo —
 * nenhum CHECK a validar —, então um código novo cai em `erro_inesperado` até
 * ser nomeado aqui.
 */
export function motivoDaRecusaDaCriacao(erro: unknown): MotivoDaRecusa {
  const codigo = erro instanceof ApiError ? erro.code : "";
  if (codigo === "required_fields_missing") return "recusa_da_regra";
  if (codigo === "not_found" || codigo === "stage_pipeline_mismatch") return "erro_ao_criar_lead";
  return "erro_inesperado";
}

export interface CaptacaoParaRegistrar {
  organizationId: string;
  webhookSourceId: string | null;
  sourceName: string;
  leadId?: string | null;
  contactId?: string | null;
  outcome: DesfechoDaCaptacao;
  rejectReason?: MotivoDaRecusa | null;
  capturedName?: string | null;
  capturedPhone?: string | null;
  capturedEmail?: string | null;
  /** Todo o resto do formulário, como chegou. É PII. */
  fields?: Record<string, unknown>;
  utm?: Record<string, string>;
  remoteIp?: string | null;
  userAgent?: string | null;
  /** A página que hospedava o formulário (Origin ou Referer). */
  origin?: string | null;
  requestId?: string | null;
}

/** Teto por campo — um site pode mandar um textarea inteiro, e a tela é uma tabela. */
const MAX_TAMANHO_DE_VALOR = 2000;
const MAX_CAMPOS = 60;

/**
 * Corta o que veio grande demais em vez de recusar a linha inteira.
 *
 * Recusar faria o histórico perder a captação por causa de um campo — e é
 * exatamente do formulário estranho que quem está depurando precisa do
 * registro. O corte é visível: o valor termina em `…`.
 */
export function limitarCampos(entrada: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  let n = 0;
  for (const [chave, valor] of Object.entries(entrada)) {
    if (n >= MAX_CAMPOS) break;
    n += 1;
    saida[chave] = limitarValor(valor);
  }
  return saida;
}

/**
 * O teto vale para QUALQUER valor, não só para string.
 *
 * A versão anterior cortava só o ramo `typeof valor === "string"`, e todo o
 * resto caía num `else` que guardava o valor INTEIRO. Um formulário que manda
 * um campo aninhado — um array de itens de carrinho, um objeto de endereço,
 * qualquer JSON — entrava sem limite nenhum, enquanto a prosa deste módulo (e o
 * cálculo de retenção em `retencao-da-captacao.ts:20`, que dimensiona a tabela
 * em "60 campos × 2.000 caracteres") prometia o contrário.
 *
 * Quem manda o corpo é o site do cliente, então o tamanho não é escolha nossa:
 * é a superfície de quem quiser encher a tabela que a tela lê.
 *
 * Valor pequeno passa INTACTO, com o tipo original — o número continua número e
 * o objeto continua objeto. Só quando o JSON dele passa do teto é que vira a
 * string cortada, porque aí guardar "quase o objeto" seria guardar um objeto
 * que não é o que chegou. O `…` no fim é o mesmo sinal visível de sempre.
 */
function limitarValor(valor: unknown): unknown {
  if (typeof valor === "string") {
    return valor.length > MAX_TAMANHO_DE_VALOR
      ? `${valor.slice(0, MAX_TAMANHO_DE_VALOR)}…`
      : valor;
  }
  if (valor === null || valor === undefined || typeof valor !== "object") return valor;

  // `JSON.stringify` devolve `undefined` para valor não serializável e LANÇA em
  // referência circular. Nos dois casos o certo é registrar que havia algo ali
  // e seguir — a captação inteira não pode cair por causa de um campo.
  let serializado: string | undefined;
  try {
    serializado = JSON.stringify(valor);
  } catch {
    return "[valor não serializável]";
  }
  if (serializado === undefined) return "[valor não serializável]";
  return serializado.length > MAX_TAMANHO_DE_VALOR
    ? `${serializado.slice(0, MAX_TAMANHO_DE_VALOR)}…`
    : valor;
}

/**
 * A página de onde o formulário veio.
 *
 * `Origin` primeiro (é só o esquema+host, e é o que o browser manda em POST
 * cross-origin); `Referer` como plano B, cortado na query string — ela costuma
 * carregar os mesmos utm_* que já vão em coluna própria, e às vezes token de
 * sessão de quem preencheu.
 */
export function origemDaPagina(headers: Headers): string | null {
  const origin = headers.get("origin");
  if (origin && origin !== "null") return origin.slice(0, 500);
  const referer = headers.get("referer");
  if (!referer) return null;
  const semQuery = referer.split("?")[0] ?? referer;
  return semQuery.slice(0, 500);
}

export async function registrarCaptacao(
  admin: SupabaseClient,
  captacao: CaptacaoParaRegistrar,
): Promise<void> {
  const { error } = await admin.from("webhook_lead_captures").insert({
    organization_id: captacao.organizationId,
    webhook_source_id: captacao.webhookSourceId,
    source_name: captacao.sourceName,
    lead_id: captacao.leadId ?? null,
    contact_id: captacao.contactId ?? null,
    outcome: captacao.outcome,
    reject_reason: captacao.rejectReason ?? null,
    captured_name: captacao.capturedName ?? null,
    captured_phone: captacao.capturedPhone ?? null,
    captured_email: captacao.capturedEmail ?? null,
    fields: limitarCampos(captacao.fields ?? {}),
    utm: captacao.utm ?? {},
    remote_ip: captacao.remoteIp ?? null,
    user_agent: captacao.userAgent?.slice(0, 500) ?? null,
    origin: captacao.origin ?? null,
    request_id: captacao.requestId ?? null,
  });

  // Falha ABERTA na ação (o lead entra de qualquer jeito) e ABERTA na
  // informação: a causa vai para o log nomeada. Um "não gravou o histórico" em
  // silêncio seria indistinguível de "não chegou nada", que é justamente a
  // pergunta que esta tabela veio responder.
  if (error) {
    logger.error("[webhooks.captacao] não foi possível registrar o histórico da captação", {
      organizationId: captacao.organizationId,
      webhookSourceId: captacao.webhookSourceId,
      outcome: captacao.outcome,
      errorCode: error.code,
      errorMessage: error.message,
    });
  }
}
