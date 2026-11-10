/**
 * QUEM JÁ COMPROU NÃO É CAPTAÇÃO (#3644) — a regra, pura, e a leitura da última
 * venda.
 *
 * ═══ O defeito, medido ═══
 *
 * `garantirLeadDaConversa` decidia "é cliente?" só por `contacts.first_service_at`
 * (com a regra da agenda ligada). Quem COMPROU sem nunca ter agendado nada tem a
 * coluna nula, então a conversa do dia seguinte nascia no funil padrão —
 * "Aquisição › Abordagem" — como se a pessoa fosse lead frio. Em produção isso
 * distorce o funil de entrada (ele mede quem é novo) e esconde que a conversa é
 * pós-venda ou recompra.
 *
 * ═══ Por que a VENDA, e não mais uma data no contato ═══
 *
 * `crm_leads.status = 'won'` já é a verdade gravada de que houve compra, em
 * qualquer funil da organização, e o índice que a consulta usa já existe
 * (`crm_leads_org_contact`). Carimbar uma segunda coluna em `contacts` seria
 * criar um segundo lugar para o mesmo fato — e é daí que a divergência nasce
 * (a coluna ficaria para trás no dia em que o ganho for desfeito).
 *
 * ═══ O que este arquivo NÃO decide ═══
 *
 * O destino. Quem escolhe o funil continua sendo `funilDeEntrada`, com o
 * booleano que sai daqui — `is_client_pipeline`, ou o padrão quando não há
 * funil de clientes marcado. Nenhum nome de funil aparece neste arquivo.
 *
 * ═══ As duas decisões, e o que cada uma evita ═══
 *
 *   1. **cliente** — a conversa nasce no funil de clientes (ou no padrão, sem
 *      funil marcado). Evita medir recompra como captação.
 *   2. **pós-venda** (`pos_venda_dias`) — dentro da janela, NÃO nasce card
 *      nenhum: o "chegou certinho?" de dois dias depois da compra não é uma
 *      demanda nova. Fora da janela, ou com a janela em 0 (o padrão), nasce.
 *
 * ⚠️ TODA FALHA CAI NO COMPORTAMENTO DE ANTES: sem venda, sem data legível, sem
 * a chave ligada, o resultado é "não é cliente por venda" — e o lead nasce onde
 * nascia. Segurar a conversa por causa de uma leitura que falhou seria trocar um
 * funil errado (visível e corrigível) por uma pessoa que sumiu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { formatValorDoNegocio } from "@/lib/money";

/** A última venda do contato, como o roteamento precisa dela. */
export interface VendaAnterior {
  leadId: string;
  pipelineId: string;
  /** Nome do funil da venda, só para o texto da timeline. Pode faltar. */
  pipelineNome: string | null;
  /** `crm_leads.closed_at` — o dia em que o ganho foi marcado. */
  fechadaEm: string | null;
  valorCents: number | null;
  moeda: string | null;
}

export interface DecisaoPelaVenda {
  /** Conta como cliente (o chamador soma isto ao critério da agenda). */
  cliente: boolean;
  /** Dentro da janela de pós-venda: não abre negócio nenhum. */
  posVenda: boolean;
  /** Dias desde a última venda; `null` quando não há venda ou data legível. */
  diasDesdeAVenda: number | null;
  /** Texto para a atividade do negócio novo; `null` sem venda. */
  motivo: string | null;
}

const SEM_VENDA: DecisaoPelaVenda = {
  cliente: false,
  posVenda: false,
  diasDesdeAVenda: null,
  motivo: null,
};

const UM_DIA_MS = 86_400_000;

/**
 * Dias inteiros entre a venda e agora, nunca negativos.
 *
 * Data no FUTURO (relógio torto, importação com data errada) conta como `0`, e
 * não como "muito tempo atrás": é o lado que erra para o card nascer e para a
 * janela de pós-venda valer — o oposto seguraria a conversa por causa de um
 * carimbo que ninguém conferiu.
 */
export function diasDesde(fechadaEm: string | null, agora: Date = new Date()): number | null {
  if (!fechadaEm) return null;
  const quando = new Date(fechadaEm).getTime();
  if (!Number.isFinite(quando)) return null;
  return Math.max(0, Math.floor((agora.getTime() - quando) / UM_DIA_MS));
}

/** "hoje" / "há 1 dia" / "há 12 dias" — sem zero nem singular torto. */
function textoDoTempo(dias: number | null): string | null {
  if (dias === null) return null;
  if (dias === 0) return "hoje";
  return `há ${dias} ${dias === 1 ? "dia" : "dias"}`;
}

/**
 * O texto que a timeline mostra na atividade `lead_created`:
 *
 *   Cliente voltou a escrever · última venda há 12 dias (Vendas, R$ 1.200,00)
 *
 * Cada pedaço só entra se existir — nome de funil apagado, valor não informado
 * ou data ausente não deixam parêntese vazio nem "há null dias". O valor sai na
 * moeda do NEGÓCIO (`formatValorDoNegocio`), nunca convertido.
 */
export function motivoDaVolta(venda: VendaAnterior, dias: number | null): string {
  const partes: string[] = [];
  if (venda.pipelineNome) partes.push(venda.pipelineNome);
  const valor =
    typeof venda.valorCents === "number"
      ? formatValorDoNegocio(venda.valorCents, venda.moeda || "BRL")
      : null;
  if (valor) partes.push(valor);

  const tempo = textoDoTempo(dias);
  const quando = tempo ? `última venda ${tempo}` : "última venda registrada";
  return `Cliente voltou a escrever · ${quando}${partes.length > 0 ? ` (${partes.join(", ")})` : ""}`;
}

/**
 * A REGRA, sem banco. Três perguntas, nesta ordem:
 *
 *   1. a chave está ligada? — desligada, o resultado é o comportamento de antes
 *      desta issue existir (nem cliente, nem pós-venda);
 *   2. existe venda ganha? — sem ela, ninguém vira cliente por venda;
 *   3. a conversa caiu DENTRO da janela de pós-venda? — então não nasce card.
 *
 * A janela conta o dia da venda como `0` e vale ATÉ `pos_venda_dias` inclusive
 * (`dias <= pos_venda_dias`): "30 dias" com a compra há exatos 30 dias é o último
 * dia da janela, e é o lado que erra para não abrir card — que é o pedido da
 * issue ("dentro dele, nenhuma negociação nova é aberta"). `pos_venda_dias = 0`
 * desliga a janela: nunca há pós-venda, o card sempre nasce.
 */
export function decidirPelaVenda(entrada: {
  /** `settings.crm.cliente_pela_venda`. */
  pelaVenda: boolean;
  /** `settings.crm.pos_venda_dias` — já saneado (0–365). */
  posVendaDias: number;
  venda: VendaAnterior | null;
  /** Injetável para o teste não depender do relógio. */
  agora?: Date;
}): DecisaoPelaVenda {
  const { pelaVenda, posVendaDias, venda } = entrada;
  if (!pelaVenda || !venda) return SEM_VENDA;

  const dias = diasDesde(venda.fechadaEm, entrada.agora ?? new Date());
  const motivo = motivoDaVolta(venda, dias);

  if (posVendaDias > 0 && dias !== null && dias <= posVendaDias) {
    return { cliente: false, posVenda: true, diasDesdeAVenda: dias, motivo };
  }
  return { cliente: true, posVenda: false, diasDesdeAVenda: dias, motivo };
}

/**
 * A última venda GANHA do contato, em qualquer funil da organização.
 *
 * O negócio aberto não é assunto daqui — quem o recusa é o passo anterior de
 * `garantirLeadDaConversa` (`ja_existe`), e refazer a checagem aqui só criaria
 * uma segunda régua para o mesmo fato. O que esta leitura responde é "houve
 * compra?", com a data e o valor que o texto da timeline cita.
 *
 * ⚠️ CUSTA UMA CONSULTA A MAIS, e só quando a chave está ligada E não há negócio
 * aberto — ou seja, no caminho em que um card vai NASCER, nunca na mensagem
 * número dez de uma conversa que já tem card. O nome do funil é a SEGUNDA
 * consulta, e só quando existe venda: é enfeite de texto, e falhar nela não pode
 * custar o roteamento.
 *
 * Falha de leitura devolve `null` (ninguém é cliente por venda) e vai para o
 * log: o card nasce no funil de antes, que é visível e corrigível.
 */
export async function lerVendaAnterior(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<VendaAnterior | null> {
  const { data, error } = await db
    .from("crm_leads")
    .select("id,pipeline_id,closed_at,updated_at,value_cents,currency")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "won")
    // Ganho sem `closed_at` (linha antiga, importada) não pode vencer a venda de
    // ontem: os nulos vão para o fim, e a data de atualização desempata.
    .order("closed_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn("[cliente-pela-venda] leitura da última venda falhou", {
      organization_id: organizationId,
      contact_id: contactId,
      error: error.message.slice(0, 160),
    });
    return null;
  }
  if (!data) return null;

  const venda = data as {
    id: string;
    pipeline_id: string;
    closed_at: string | null;
    value_cents: number | null;
    currency: string | null;
  };

  return {
    leadId: venda.id,
    pipelineId: venda.pipeline_id,
    pipelineNome: await nomeDoFunil(db, organizationId, venda.pipeline_id),
    fechadaEm: venda.closed_at,
    valorCents: venda.value_cents,
    moeda: venda.currency,
  };
}

/**
 * O nome do funil da venda, só para o texto. `null` em qualquer tropeço — o
 * motivo perde o parêntese e o roteamento não depende disto.
 */
async function nomeDoFunil(
  db: SupabaseClient,
  organizationId: string,
  pipelineId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("crm_pipelines")
    .select("name")
    .eq("organization_id", organizationId)
    .eq("id", pipelineId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { name?: string | null }).name ?? null;
}
