/**
 * Normalizador dedicado do Elementor Pro (ação "Webhook" do formulário) — irmão
 * de `lib/webhooks/respondi.ts` e `lib/webhooks/rdstation.ts`.
 *
 * ═══ O BUG ═══
 *
 * O Elementor manda o formulário em `application/x-www-form-urlencoded` com
 * notação de colchetes, UMA linha por propriedade de cada campo:
 *
 *   form[id]=57e8a20                     form[name]=form conversao
 *   fields[servico][id]=servico          fields[servico][type]=select
 *   fields[servico][title]=Selecione…    fields[servico][value]=projeto_customizado
 *
 * `mapInboundPayload` (inbound.ts) procura chave de topo chamada `nome`,
 * `telefone`, `email`… e aqui a chave inteira é `fields[servico][value]`. Os
 * TRÊS (nome/telefone/e-mail) batem `null`, a rota devolve 400 "Nenhum campo
 * mapeável" e nenhum lead entra — o mesmo desfecho do Respondi e do RD Station.
 *
 * A solução é a mesma deles: detecção ESTRITA da forma + normalizador dedicado,
 * chamado ANTES do genérico e SEM tocar nele. Qualquer outro envio (flat,
 * Zapier, n8n, o botão "Enviar lead de teste") segue `mapInboundPayload`
 * inalterado.
 *
 * ═══ O QUE O ELEMENTOR JÁ ENTREGA ═══
 *
 * Cada campo chega com `id` (nome interno), `title` (o rótulo), `type` (o tipo)
 * e `value`. Por isso nome, telefone e e-mail se acham pelo TIPO (`tel`,
 * `email`) e não só pelo nome da chave: o id é livre e `Telefone` (com T
 * maiúsculo) é um id válido.
 *
 * ═══ ESCOPO ═══
 *
 * Só a RECEPÇÃO. Os demais campos viram `custom_fields` pelo `id` (estável; o
 * rótulo o admin pode trocar). `required` e `raw_value` não são dado do lead.
 * O Elementor não manda identificador único do envio, então não há `externalId`.
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

/** Valor de campo: string, número/booleano, ou lista de strings (checkbox) juntada por ", ". */
function valor(v: unknown): string | null {
  if (Array.isArray(v)) {
    const partes = v.map((x) => str(x)).filter((x): x is string => x !== null);
    return partes.length ? partes.join(", ") : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return str(v);
}

interface CampoElementor {
  id: string;
  type: string | null;
  title: string | null;
  value: string | null;
}

interface Envio {
  campos: CampoElementor[];
  formId: string | null;
  formName: string | null;
}

/** `fields[<id>][<propriedade>]` — o id é tudo entre o primeiro `[` e o `]` seguinte. */
const CHAVE_DE_CAMPO = /^fields\[([^\]]+)\]\[(id|type|title|value)\]$/;

/**
 * Lê o envio nas DUAS formas em que o Elementor chega: chaves planas com
 * colchetes (form-urlencoded, o caso real) e o objeto aninhado equivalente
 * (`{ form: {...}, fields: { <id>: { id, type, title, value } } }`), que é como
 * um proxy ou uma versão que fale JSON entregaria o mesmo dado.
 */
function lerEnvio(payload: unknown): Envio | null {
  if (!isRecord(payload)) return null;

  const porId = new Map<string, Partial<Record<"id" | "type" | "title" | "value", unknown>>>();
  const pegar = (id: string) => {
    let c = porId.get(id);
    if (!c) porId.set(id, (c = {}));
    return c;
  };

  for (const [chave, v] of Object.entries(payload)) {
    const m = CHAVE_DE_CAMPO.exec(chave);
    if (m?.[1] && m[2]) pegar(m[1])[m[2] as "id" | "type" | "title" | "value"] = v;
  }
  if (isRecord(payload.fields)) {
    for (const [id, bruto] of Object.entries(payload.fields)) {
      if (!isRecord(bruto)) continue;
      const c = pegar(id);
      for (const p of ["id", "type", "title", "value"] as const) if (p in bruto) c[p] = bruto[p];
    }
  }

  const campos: CampoElementor[] = [];
  for (const [id, c] of porId) {
    campos.push({ id, type: str(c.type), title: str(c.title), value: valor(c.value) });
  }

  // Marcador inconfundível: pelo menos um campo que se declara (`id` igual à chave)
  // e traz `type`. Um formulário qualquer com uma chave `fields[x][value]` solta
  // não basta — é o que impede esta rota de capturar payload de outra origem.
  const seDeclara = [...porId.entries()].some(([id, c]) => c.id === id && str(c.type) !== null);
  if (!seDeclara) return null;

  const form = isRecord(payload.form) ? payload.form : {};
  return {
    campos,
    formId: str(payload["form[id]"]) ?? str(form.id),
    formName: str(payload["form[name]"]) ?? str(form.name),
  };
}

export function isElementorPayload(payload: unknown): boolean {
  return lerEnvio(payload) !== null;
}

// Mesmas chaves que o mapeador genérico reconhece (`DEFAULT_FIELD_MAP` em inbound.ts).
const IDS_DE_NOME = ["name", "nome", "full_name", "fullname", "nome_completo"];
const IDS_DE_TELEFONE = ["phone", "telefone", "whatsapp", "celular", "phone_number", "tel"];
const IDS_DE_EMAIL = ["email", "e-mail", "mail"];
const ROTULO_DE_NOME = /^\s*(seu\s+|your\s+)?(nome|name)\b/i;

/** Primeiro campo PREENCHIDO que satisfaz o critério. */
function primeiro(
  campos: CampoElementor[],
  ok: (c: CampoElementor) => boolean,
): CampoElementor | null {
  return campos.find((c) => c.value !== null && ok(c)) ?? null;
}

export interface ElementorMapped extends MappedLead {
  externalId: null;
}

/** Extrai identidade + campos extras do envio do Elementor. Puro, sem I/O. */
export function mapElementorPayload(payload: unknown): ElementorMapped {
  const envio = lerEnvio(payload) ?? { campos: [], formId: null, formName: null };
  const { campos } = envio;
  const idEm = (lista: string[]) => (c: CampoElementor) => lista.includes(c.id.toLowerCase());

  const nome =
    primeiro(campos, idEm(IDS_DE_NOME)) ??
    primeiro(campos, (c) => c.type === "text" && c.title !== null && ROTULO_DE_NOME.test(c.title));
  const telefone =
    primeiro(campos, (c) => c.type === "tel") ?? primeiro(campos, idEm(IDS_DE_TELEFONE));
  const email = primeiro(campos, (c) => c.type === "email") ?? primeiro(campos, idEm(IDS_DE_EMAIL));
  const usados = new Set([nome?.id, telefone?.id, email?.id]);

  const custom_fields: Record<string, string> = {};
  const source_metadata: Record<string, string> = {};
  for (const c of campos) {
    if (usados.has(c.id) || c.value === null) continue;
    if (c.id.toLowerCase().startsWith("utm_")) source_metadata[c.id.toLowerCase()] = c.value;
    else custom_fields[c.id] = c.value;
  }
  if (envio.formId) custom_fields.elementor_form_id = envio.formId;
  if (envio.formName) custom_fields.elementor_form_name = envio.formName;

  const phone = normalizePhoneBR(telefone?.value);
  // Telefone digitado que não normaliza não some: fica como rastro, igual ao caminho genérico.
  if (!phone && telefone?.value) source_metadata.raw_phone = telefone.value;

  return {
    name: nome?.value ?? null,
    phone,
    email: email?.value ?? null,
    custom_fields,
    source_metadata,
    externalId: null,
  };
}
