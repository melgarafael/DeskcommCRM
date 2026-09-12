/**
 * Normalizador dedicado do RD Station — irmão de `lib/webhooks/respondi.ts`.
 *
 * ═══ O BUG, MEDIDO ═══
 *
 * O "webhook de lead" do RD Station (RD Station Marketing / CDP) manda o lead
 * dentro de um envelope `{ "leads": [ { ... } ] }`. `mapInboundPayload`
 * (inbound.ts) só olha CHAVE DE TOPO — objeto/array aninhado é descartado por
 * desenho ("v1"). Resultado: `name`/`phone`/`email` batem `null` para os TRÊS,
 * a rota devolve 400 "Nenhum campo mapeável" (depois de já ter gravado
 * `webhook_events_log` e a linha `recusado` em `webhook_lead_captures`), e
 * nenhum lead entra. Medido em produção (JBA, 2026-09-08): 5 recebimentos
 * reais recusados, 0 lead. Ver `JBA-RDSTATION-WEBHOOK-DIAGNOSTICO.txt`.
 *
 * É o mesmo caso do Respondi (achado 2026-08-25), e a solução é a mesma:
 * detecção ESTRITA da forma + normalizador dedicado, chamado ANTES do genérico
 * e SEM tocar no genérico. Qualquer outro envio (flat, Zapier, n8n, o botão
 * interno "Enviar lead de teste") segue `mapInboundPayload` inalterado.
 *
 * ═══ TELEFONE ═══
 *
 * O celular do formulário vem em `leads[0].mobile_phone` (fallback
 * `personal_phone`, depois os rótulos `Celular` das conversões). O
 * `leads[0].phone` do RD é o "telefone comercial" e chega `null` na esmagadora
 * maioria dos envios — NUNCA usar a ausência dele como sinal de "sem telefone".
 *
 * ═══ ESCOPO ═══
 *
 * Só a RECEPÇÃO do webhook. NÃO integra com a API do RD Station.
 *
 * ═══ BATCH ═══
 *
 * O RD real observado manda 1 item em `leads[]`. Este módulo lê o PRIMEIRO
 * item. `leads[]` com múltiplos itens está FORA deste fix — a rota
 * (`webhooks/in/[token]`) cria 1 lead por request; suportar N exigiria mudança
 * estrutural na rota. Documentado no checkpoint.
 */
import type { MappedLead } from "@/lib/webhooks/inbound";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** String não-vazia (trim) ou null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * `leads[0]` resolvido. Aceita `leads` como array OU, defensivamente, como
 * string JSON que parseia para um array (form-urlencoded, ou provedor que
 * serializa o campo). `null` quando a forma não é a do RD.
 */
function primeiroLead(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  let leads: unknown = payload.leads;
  if (typeof leads === "string") {
    const s = leads.trim();
    if (!s) return null;
    try {
      leads = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(leads) || leads.length === 0) return null;
  const first = leads[0];
  return isRecord(first) ? first : null;
}

/** O `content` de `first_conversion` / `last_conversion`, ou `{}`. */
function conversaoContent(
  lead: Record<string, unknown>,
  qual: "first_conversion" | "last_conversion",
): Record<string, unknown> {
  const c = lead[qual];
  if (!isRecord(c)) return {};
  return isRecord(c.content) ? c.content : {};
}

/** `__cdp__original_event.event_uuid` — o identificador por CONVERSÃO (last primeiro). */
function cdpEventUuid(lead: Record<string, unknown>): string | null {
  for (const qual of ["last_conversion", "first_conversion"] as const) {
    const cdp = conversaoContent(lead, qual).__cdp__original_event;
    if (isRecord(cdp)) {
      const u = str(cdp.event_uuid);
      if (u) return u;
    }
  }
  return null;
}

export interface RdStationPayloadShape {
  leads: unknown;
}

/**
 * True só quando o payload tem a forma inconfundível do RD Station: uma chave
 * `leads` (array, ou string JSON que parseia para array) cujo primeiro item é
 * um objeto com PELO MENOS um marcador do RD — `id` string acompanhado de um
 * campo de identidade, ou uma das conversões (`first_conversion`/
 * `last_conversion`). Deliberadamente estrita para nunca capturar por engano
 * um payload de outra origem (mesma postura de `isRespondiPayload`).
 */
export function isRdStationPayload(payload: unknown): payload is RdStationPayloadShape {
  const lead = primeiroLead(payload);
  if (!lead) return false;
  const temConversao =
    isRecord(lead.first_conversion) || isRecord(lead.last_conversion);
  const temIdentidadeRd =
    typeof lead.id === "string" &&
    ("name" in lead || "email" in lead || "mobile_phone" in lead || "personal_phone" in lead);
  return temConversao || temIdentidadeRd;
}

export interface RdStationMapped extends MappedLead {
  externalId: string | null;
}

/**
 * Extrai identidade + metadados seguros do envelope RD. Puro, sem I/O.
 * Reusa `normalizePhoneBR` — o telefone chega mascarado ("+55 (32) 9922-8971").
 */
export function mapRdStationPayload(payload: unknown): RdStationMapped {
  const lead = primeiroLead(payload) ?? {};
  const first = conversaoContent(lead, "first_conversion");
  const last = conversaoContent(lead, "last_conversion");

  const name = str(lead.name) ?? str(last.Nome) ?? str(first.Nome);
  const email =
    str(lead.email) ?? str(last.email_lead) ?? str(first.email_lead);
  const phoneRaw =
    str(lead.mobile_phone) ??
    str(lead.personal_phone) ??
    str(last.Celular) ??
    str(first.Celular) ??
    str(lead.phone);

  const custom_fields: Record<string, string> = {};
  const setCf = (k: string, v: string | null): void => {
    if (v !== null) custom_fields[k] = v;
  };
  // Só metadados úteis e seguros — nada de traffic_source/user_agent/blobs.
  setCf("rd_lead_id", str(lead.id));
  setCf("rd_lead_uuid", str(lead.uuid));
  setCf("rd_lead_stage", str(lead.lead_stage));
  setCf("rd_public_url", str(lead.public_url));
  setCf("rd_number_conversions", str(lead.number_conversions));
  setCf(
    "rd_conversion_identifier",
    str(last.conversion_identifier) ??
      str(first.conversion_identifier) ??
      str(last.identificador) ??
      str(first.identificador),
  );
  setCf("rd_conversion_url", str(last.conversion_url) ?? str(first.conversion_url));
  const evtUuid = cdpEventUuid(lead);
  setCf("rd_event_uuid", evtUuid);

  const leadId = str(lead.id);
  const externalId = evtUuid
    ? `rdstation:evt:${evtUuid}`
    : leadId
      ? `rdstation:lead:${leadId}`
      : null;

  return {
    name,
    phone: normalizePhoneBR(phoneRaw),
    email,
    custom_fields,
    source_metadata: {},
    externalId,
  };
}
