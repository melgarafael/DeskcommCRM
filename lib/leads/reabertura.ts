/**
 * RETOMAR UM NEGÓCIO PERDIDO — a escolha POR FUNIL (issue #1538).
 *
 * Há dois jeitos de tratar o cliente que volta meses depois de uma venda
 * perdida: reabrir o MESMO registro (o que o sistema faz hoje) ou abrir uma
 * nova tentativa. Reabrir conta a venda como 100% convertida e esconde a
 * primeira perda; abrir de novo mantém a perda registrada e permite derivar
 * "quantas tentativas até fechar" pela cadeia `crm_leads.retomado_de_lead_id`
 * (migration 0425).
 *
 * A escolha mora em `crm_pipelines.settings.reabertura` (jsonb — a OPÇÃO não
 * precisa de migration) e o padrão é `"mesmo_registro"`: um funil que não
 * declarou nada nenhum, ou que declarou outra coisa, continua se comportando
 * exatamente como hoje. Este módulo é a parte decidível da regra — lê a
 * escolha, decide se a escrita reabriria um negócio encerrado e monta o
 * payload da retomada. Quem fala com o banco é quem chama
 * (`app/api/v1/leads/[id]/move/route.ts`, `moveLeadHandler`, o lote e a rota
 * `/retomar`).
 */
import { traduzir } from "@/lib/i18n/dicionario";
import { CAMPOS_COPIAVEIS_NA_RETOMADA, pipelineConfigPatchSchema } from "@/lib/schemas/settings";

/** Os dois modos aceitos em `settings.reabertura`. */
export type ModoReabertura = "mesmo_registro" | "novo_negocio";

/** O modo de quem não declarou nada: o comportamento de antes desta issue. */
export const MODO_REABERTURA_PADRAO: ModoReabertura = "mesmo_registro";

/**
 * O código de wire que TODOS os caminhos devolvem quando a escrita reabriria
 * um negócio encerrado num funil `novo_negocio` — arrasto, lote, IA, automação
 * e MCP falam o mesmo código, porque quem recebe (tela ou integrador) tem de
 * conseguir reconhecer a recusa sem adivinhar de onde ela veio.
 */
export const CODIGO_REABERTURA_CRIA_NOVO = "reabertura_cria_novo";

/**
 * A recusa, UMA string para todos os call sites — mesma doutrina de
 * `RECUSA_DE_TROCA_DE_FUNIL`: a frase é CHAVE do dicionário, e dois literais
 * com o mesmo significado envelhecem em direções diferentes (quem reescreve um
 * esquece o outro e quem fala espanhol volta a ler português).
 *
 * Ela aponta a porta que resolve (`/retomar`), porque uma recusa sem saída é o
 * defeito que esta issue relata no clone.
 */
export const RECUSA_REABERTURA_CRIA_NOVO =
  "Este funil retoma como novo negócio: mover um negócio encerrado para uma etapa aberta não o reabre. Use POST /api/v1/leads/{id}/retomar para criar a nova tentativa.";

/** A retomada recusa quem aponta para um negócio que NÃO está encerrado. */
export const RECUSA_RETOMADA_LEAD_ABERTO =
  "Este negócio já está aberto: a retomada cria um negócio NOVO a partir de um encerrado. Para mudar de etapa, mova o negócio que já existe.";

/** Etapa de fechamento ou arquivada não recebe a nova tentativa. */
export const RECUSA_RETOMADA_ETAPA_INDISPONIVEL =
  "A etapa escolhida não está disponível para a retomada: escolha uma etapa aberta deste funil.";

/** Sem `stage_id`, a retomada cai aqui quando o funil não tem etapa aberta. */
export const RECUSA_RETOMADA_SEM_ETAPA =
  "Este funil não tem etapa aberta para receber a nova tentativa.";

/** A resposta de quem recusou: o mesmo par em rota (`fail`) e em handler (`ApiError`). */
export interface RecusaDeReabertura {
  codigo: string;
  mensagem: string;
}

/**
 * A escolha do funil. Qualquer coisa que não seja `"novo_negocio"` — ausente,
 * `null`, número, objeto, o modo antigo — cai no padrão de antes da issue:
 * `mesmo_registro`. Silencioso de propósito, como `motivosDoFunil` faz com
 * `lost_reasons`: um settings malformado não pode virar trava de negócio.
 */
export function modoDeReabertura(settings: unknown): ModoReabertura {
  const bruto = (settings as { reabertura?: unknown } | null | undefined)?.reabertura;
  const lido = pipelineConfigPatchSchema.shape.reabertura.safeParse(bruto);
  return lido.success && lido.data ? lido.data : MODO_REABERTURA_PADRAO;
}

/**
 * Os campos que a retomada copia da origem — a parte configurável do pedido
 * ("quais campos copiar é configurável"). A lista é FECHADA e mora no schema
 * do funil (`pipelineConfigPatchSchema.reabertura_campos`): um valor fora dela
 * é ignorado em vez de virar escrita surpresa no lead novo.
 */
export const CAMPOS_COPIAVEIS = CAMPOS_COPIAVEIS_NA_RETOMADA;

export type CampoCopiavel = (typeof CAMPOS_COPIAVEIS)[number];

/** O piso da issue: `custom_fields` e tags, que a proposta nomeia. */
export const CAMPOS_PADRAO_DA_RETOMADA: readonly CampoCopiavel[] = ["custom_fields", "tags"];

/**
 * Lê `settings.reabertura_campos`. Sem a chave, o piso da proposta; com a
 * chave, a lista filtrada pela whitelist — inclusive VAZIA, que significa
 * "copie só o contato": é uma escolha do operador, não um erro de leitura.
 */
export function camposCopiadosNaRetomada(settings: unknown): CampoCopiavel[] {
  const bruto = (settings as { reabertura_campos?: unknown } | null | undefined)?.reabertura_campos;
  if (!Array.isArray(bruto)) return [...CAMPOS_PADRAO_DA_RETOMADA];
  return bruto.filter((c): c is CampoCopiavel =>
    (CAMPOS_COPIAVEIS as readonly string[]).includes(c as string),
  );
}

/**
 * O veredito dos caminhos que escrevem etapa.
 *
 * Recusa SÓ quando as três condições se juntam: o funil é `novo_negocio`, o
 * negócio NÃO está aberto e a etapa de destino NÃO é de fechamento — levar um
 * encerrado para a etapa de ganho/perda não é reabertura, é outro desfecho, e
 * aí quem decide é o trigger (`fn_crm_lead_close_on_stage`) e o motivo da
 * perda, como sempre.
 *
 * `idioma` opcional: em `{}`/handler o idioma vem do contexto; num lugar sem
 * ele a frase sai em pt-BR, que é o texto-fonte.
 */
export function recusaReabertura(p: {
  modo: ModoReabertura;
  statusAtual: string | null | undefined;
  etapaDestino: { is_won?: boolean | null; is_lost?: boolean | null };
  idioma?: Parameters<typeof traduzir>[1];
}): RecusaDeReabertura | null {
  if (p.modo !== "novo_negocio") return null;
  if ((p.statusAtual ?? "open") === "open") return null;
  if (p.etapaDestino.is_won || p.etapaDestino.is_lost) return null;
  return {
    codigo: CODIGO_REABERTURA_CRIA_NOVO,
    mensagem: traduzir(RECUSA_REABERTURA_CRIA_NOVO, p.idioma ?? "pt-BR"),
  };
}
