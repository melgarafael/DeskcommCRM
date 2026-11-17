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
 * As RESPOSTAS do formulário (o conteúdo das conversões) chegam ao card pelo
 * mesmo mapeador e pelo mesmo `field_map` de um envio plano — ver
 * `camposDoFormularioDoRd` e `mapRdStationPayload`.
 *
 * ═══ BATCH ═══
 *
 * O RD real observado manda 1 item em `leads[]`. Este módulo lê o PRIMEIRO
 * item. `leads[]` com múltiplos itens está FORA deste fix — a rota
 * (`webhooks/in/[token]`) cria 1 lead por request; suportar N exigiria mudança
 * estrutural na rota. Documentado no checkpoint.
 */
import type { FieldMap, MappedLead } from "@/lib/webhooks/inbound";
import {
  ehChaveDeAnuncio,
  mapInboundPayload,
  normalizePhoneBR,
} from "@/lib/webhooks/inbound";

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
  /**
   * As respostas do formulário, já achatadas e sem as chaves técnicas do RD
   * (`camposDoFormularioDoRd`). É o equivalente, no envelope, ao corpo plano de
   * um envio genérico — e é o que a rota passa para a tipagem dos campos
   * configurados na fonte (`normalizarCamposNumericos`).
   */
  camposDoFormulario: Record<string, unknown>;
}

/**
 * Chaves que o PRÓPRIO RD Station põe no conteúdo da conversão e que não são
 * resposta de ninguém: identificador e endereço da conversão, token da conta,
 * rastreio de tráfego e de navegador. Comparadas em minúsculas.
 *
 * Também entram aqui as chaves de onde `mapRdStationPayload` já tirou a
 * IDENTIDADE (`Nome`, `email_lead`, `Celular`, `phone_lead`): o caminho genérico
 * também não repete no card a chave que virou nome, telefone ou e-mail.
 *
 * Lista NOMEADA e FECHADA, na mesma postura de `CHAVES_DE_PLATAFORMA`
 * (`inbound.ts`): um formulário pode ter um campo legítimo com qualquer outro
 * nome, e descartá-lo em silêncio seria perder dado de cliente. O que ficar de
 * fora da lista por engano aparece no card e no histórico, onde se vê; o que
 * entrasse nela por engano sumiria sem rastro.
 *
 * `external_id` e `stage` são os campos RESERVADOS do contrato genérico (#2316):
 * no envio plano eles saem do mapeamento antes de virar campo do card, e aqui
 * também. No RD eles NÃO pedem nada — a idempotência do envelope é o
 * `rdstation:evt|lead` e a etapa reservada só é lida do corpo de topo.
 */
export const CHAVES_TECNICAS_DO_RD: ReadonlySet<string> = new Set([
  // identidade, já lida por `mapRdStationPayload`
  "nome",
  "email_lead",
  "celular",
  "phone_lead",
  // a conversão e a conta
  "identificador",
  "conversion_identifier",
  "conversion_url",
  "event_type",
  "token_rdstation",
  "created_at",
  // rastreio de tráfego e de navegador
  "traffic_source",
  "traffic_medium",
  "traffic_campaign",
  "traffic_value",
  "user_agent",
  "client_id",
  "client_tracking_id",
  "c_utmz",
  // reservados do contrato genérico
  "external_id",
  "stage",
]);

/** Prefixo dos blocos internos do RD (`__cdp__original_event` e afins). */
const PREFIXO_INTERNO_DO_RD = "__";

function ehChaveTecnicaDoRd(chave: string): boolean {
  const k = chave.trim().toLowerCase();
  return k.startsWith(PREFIXO_INTERNO_DO_RD) || CHAVES_TECNICAS_DO_RD.has(k);
}

/**
 * As respostas do formulário que chegaram no envelope, num objeto PLANO — a
 * mesma forma de um envio genérico, para passar pelo mesmo mapeador.
 *
 * ─── De onde, e quem vence ───────────────────────────────────────────────────
 *
 * Três camadas, da mais fraca para a mais forte:
 *
 * 1. `leads[0].custom_fields` — os campos personalizados da ficha do lead no RD;
 * 2. `first_conversion.content` — a primeira conversão;
 * 3. `last_conversion.content` — a conversão que DISPAROU este webhook, e por
 *    isso a resposta mais recente da pessoa.
 *
 * Uma camada só sobrepõe a anterior com VALOR: vazio ou ausente na última
 * conversão quer dizer "não perguntado desta vez", não "apague".
 *
 * ─── O que não entra ─────────────────────────────────────────────────────────
 *
 * As chaves técnicas (`CHAVES_TECNICAS_DO_RD`, prefixo `__`) e todo valor que
 * não seja texto, número ou booleano — objeto e lista aninhados são
 * descartados, como no genérico. O resto vai como chegou, com a chave original
 * (acentos e espaços inclusive): quem decide nome de campo, tipagem e destino é
 * o mapeador genérico, não este módulo.
 */
export function camposDoFormularioDoRd(payload: unknown): Record<string, unknown> {
  const lead = primeiroLead(payload) ?? {};
  const camadas = [
    isRecord(lead.custom_fields) ? lead.custom_fields : {},
    conversaoContent(lead, "first_conversion"),
    conversaoContent(lead, "last_conversion"),
  ];
  const campos: Record<string, unknown> = {};
  for (const camada of camadas) {
    for (const [chave, valor] of Object.entries(camada)) {
      if (ehChaveTecnicaDoRd(chave)) continue;
      if (typeof valor === "string") {
        if (!valor.trim()) continue;
      } else if (typeof valor !== "number" && typeof valor !== "boolean") {
        continue;
      }
      campos[chave] = valor;
    }
  }
  return campos;
}

/**
 * Extrai identidade + metadados seguros do envelope RD. Puro, sem I/O.
 * Reusa `normalizePhoneBR` — o telefone chega mascarado ("+55 (32) 9922-8971").
 *
 * ─── As respostas do formulário ──────────────────────────────────────────────
 *
 * Até aqui só a identidade e os `rd_*` chegavam ao card; as respostas do
 * formulário (orçamento, cidade preferida, o aceite da política)
 * ficavam no envelope e se perdiam. Agora elas saem achatadas
 * (`camposDoFormularioDoRd`) e passam pelo MESMO `mapInboundPayload` de um envio
 * plano, com o `field_map` da fonte: mesma regra de chave, mesma ida de `utm_*`
 * e das chaves de anúncio para `source_metadata`, mesmo descarte das chaves de
 * plataforma. Um mapeador só — um segundo, escrito aqui, divergiria do genérico
 * na primeira mudança.
 *
 * A IDENTIDADE continua sendo a do RD (`lead.name`, `mobile_phone`…): o nome,
 * o telefone e o e-mail que o mapeador genérico achar nas respostas NÃO a
 * substituem — só saem do card, como saem no envio plano.
 */
export function mapRdStationPayload(
  payload: unknown,
  fieldMap: FieldMap = {},
): RdStationMapped {
  const lead = primeiroLead(payload) ?? {};
  const first = conversaoContent(lead, "first_conversion");
  const last = conversaoContent(lead, "last_conversion");
  const camposDoFormulario = camposDoFormularioDoRd(payload);
  const doFormulario = mapInboundPayload(camposDoFormulario, fieldMap);

  const name = str(lead.name) ?? str(last.Nome) ?? str(first.Nome);
  const email =
    str(lead.email) ?? str(last.email_lead) ?? str(first.email_lead);
  const phoneRaw =
    str(lead.mobile_phone) ??
    str(lead.personal_phone) ??
    str(last.Celular) ??
    str(first.Celular) ??
    str(lead.phone);

  // As respostas primeiro; os `rd_*` por cima — são a prova de origem do card e
  // não podem ser sobrescritos por um campo de formulário de mesmo nome.
  const custom_fields: Record<string, string> = { ...doFormulario.custom_fields };
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
    // `utm_*` das respostas, como no genérico. As chaves de anúncio seguem SÓ a
    // régua de sempre do envelope (lead, primeira e última conversão): a ficha
    // do lead (`custom_fields`) não passa a decidir atribuição.
    source_metadata: {
      ...semChavesDeAnuncio(doFormulario.source_metadata),
      ...chavesDeAnuncio(lead, first, last),
    },
    externalId,
    camposDoFormulario,
  };
}

/** `source_metadata` do mapeador genérico sem as chaves de anúncio — essas seguem só a régua do envelope. */
function semChavesDeAnuncio(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([chave]) => !ehChaveDeAnuncio(chave)),
  );
}

/**
 * As chaves de anúncio do envelope do RD (issue #3149) — o clique com que a
 * pessoa chegou, e não o que ela respondeu.
 *
 * ─── Onde o RD põe o `fbclid` ────────────────────────────────────────────────
 *
 * O envelope tem TRÊS lugares para um campo do formulário, e um formulário
 * montado num anúncio pode entregar a chave em qualquer um deles: no item do
 * lead (`leads[0].fbclid`), na conversão mais recente ou na primeira
 * (`leads[0].last_conversion.content.fbclid`). Procurar num só perderia o
 * clique de quem usa os outros dois, e a falha seria silenciosa — o lead entra
 * sem atribuição e ninguém vê nada.
 *
 * A ordem é a da AUTORIDADE: `lead`, `first_conversion` e depois
 * `last_conversion`, que sobrepõe os anteriores por ser a conversão mais
 * recente. Mesma lista de chaves do caminho genérico (`CHAVES_DE_ANUNCIO`), e
 * mesmo destino: `source_metadata`, de onde a rota estampa a atribuição do
 * contato. Só as SETE chaves conhecidas entram — o resto do envelope continua
 * saindo como sempre saiu.
 */
function chavesDeAnuncio(
  ...origens: Array<Record<string, unknown>>
): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const origem of origens) {
    for (const [chave, bruto] of Object.entries(origem)) {
      if (!ehChaveDeAnuncio(chave)) continue;
      const valor =
        str(bruto) ?? (typeof bruto === "number" ? String(bruto) : null);
      if (valor !== null) metadata[chave.trim().toLowerCase()] = valor;
    }
  }
  return metadata;
}
