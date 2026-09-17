import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

const CONSUMER_KEY = "advomax.contratacao";
const RETRY_MS = 5 * 60_000;

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

type Lead = {
  id: string;
  status: string;
  title: string;
  description: string | null;
  contact_id: string | null;
};
type Contact = { id: string; name: string | null; display_name: string | null; email: string | null; phone_number: string | null };
type Link = { contact_id: string; pessoa_codigo: number; status: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function codigoPessoaValido(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

async function vincularProcesso(
  admin: ReturnType<typeof createAdminClient>,
  row: EventRow,
  contactId: string,
  processoCodigo: number,
): Promise<HandlerResult | null> {
  const actor = typeof row.metadata?.actor_user_id === "string" && UUID_RE.test(row.metadata.actor_user_id)
    ? row.metadata.actor_user_id
    : null;
  const { error } = await admin.from("advomax_contact_process_links" as never).insert({
    organization_id: row.organization_id,
    contact_id: contactId,
    processo_codigo: processoCodigo,
    created_by: actor,
  } as never);
  if (!error || error.code === "23505") return null;
  return { ...resultado("retry", "vínculo do processo não foi persistido"), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
}

async function confirmarOuCriarVinculo(
  admin: ReturnType<typeof createAdminClient>,
  row: EventRow,
  contactId: string,
  link: Link | null,
  pessoaCodigo: number,
): Promise<HandlerResult | null> {
  if (link) {
    return link.pessoa_codigo === pessoaCodigo ? null : resultado("error", "recibo_pessoa_inconsistente");
  }

  const actor = typeof row.metadata?.actor_user_id === "string" && UUID_RE.test(row.metadata.actor_user_id)
    ? row.metadata.actor_user_id
    : null;
  const { error } = await admin.from("advomax_contact_links" as never).insert({
    organization_id: row.organization_id,
    contact_id: contactId,
    pessoa_codigo: pessoaCodigo,
    status: "linked",
    authority_source: "crm_contract",
    last_synced_at: new Date().toISOString(),
    created_by: actor,
  } as never);
  if (!error) return null;
  if (error.code !== "23505") {
    return { ...resultado("retry", "vínculo CRM não foi persistido"), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
  }

  const reread = await admin.from("advomax_contact_links" as never)
    .select("pessoa_codigo,status")
    .eq("organization_id", row.organization_id)
    .eq("contact_id", contactId)
    .eq("status", "linked")
    .maybeSingle();
  if (reread.error) {
    return { ...resultado("retry", "leitura do vínculo CRM falhou"), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
  }
  const existing = reread.data as { pessoa_codigo?: unknown } | null;
  return existing && existing.pessoa_codigo === pessoaCodigo
    ? null
    : resultado("error", "conflito_de_vinculo_crm");
}

async function emailDoUsuario(admin: ReturnType<typeof createAdminClient>, row: EventRow, createdBy: string | null): Promise<string | null> {
  const actor = typeof row.metadata?.actor_user_id === "string" ? row.metadata.actor_user_id : null;
  for (const id of [actor, createdBy]) {
    if (!id) continue;
    const { data } = await admin.auth.admin.getUserById(id);
    const email = data.user?.email?.trim().toLowerCase();
    if (email) return email;
  }
  return null;
}

async function handle(row: EventRow): Promise<HandlerResult> {
  if (!row.entity_id) return resultado("skipped", "sem_lead");
  const base = process.env.ADVOMAX_API_URL?.trim().replace(/\/$/, "");
  const key = process.env.ADVOMAX_CRM_INTEGRATION_KEY?.trim();
  if (!base || !key) return resultado("skipped", "integracao_advomax_nao_configurada");

  const admin = createAdminClient();
  const { data: lead, error: leadError } = await admin
    .from("crm_leads")
    .select("id,status,title,description,contact_id")
    .eq("id", row.entity_id)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  if (leadError) return { ...resultado("retry", `leitura do lead falhou: ${leadError.message}`), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
  if (!lead) return resultado("skipped", "lead_inexistente");
  const typedLead = lead as Lead;
  if (typedLead.status !== "won") return resultado("skipped", "nao_e_ganho");
  if (!typedLead.contact_id) return resultado("skipped", "lead_sem_contato");

  const [contactResult, linkResult, organizationResult] = await Promise.all([
    admin.from("contacts").select("id,name,display_name,email,phone_number").eq("organization_id", row.organization_id).eq("id", typedLead.contact_id).maybeSingle(),
    admin.from("advomax_contact_links" as never).select("contact_id,pessoa_codigo,status").eq("organization_id", row.organization_id).eq("contact_id", typedLead.contact_id).eq("status", "linked").maybeSingle(),
    admin.from("organizations").select("created_by").eq("id", row.organization_id).eq("status", "active").maybeSingle(),
  ]);
  if (contactResult.error || linkResult.error || organizationResult.error) {
    return { ...resultado("retry", "leitura do vínculo Advomax falhou"), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
  }
  const contact = contactResult.data as Contact | null;
  const nome = contact?.display_name?.trim() || contact?.name?.trim();
  if (!nome) return resultado("skipped", "contato_sem_nome");
  const link = linkResult.data as Link | null;
  const email = await emailDoUsuario(admin, row, (organizationResult.data as { created_by?: string | null } | null)?.created_by ?? null);
  if (!email) return { ...resultado("retry", "usuario_advomax_sem_email"), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };

  const response = await fetch(`${base}/integracoes/crm/contratacoes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CRM-Integration-Key": key,
      "X-CRM-Organization-Id": row.organization_id,
      "X-CRM-User-Email": email,
      "X-CRM-Idempotency-Key": `lead:${typedLead.id}:won:v1`,
    },
    body: JSON.stringify({
      lead_id: typedLead.id,
      pessoa_codigo: link?.pessoa_codigo ?? null,
      nome,
      email: contact?.email ?? null,
      telefone: contact?.phone_number ?? null,
      titulo_processo: typedLead.title,
      descricao: typedLead.description,
      pasta: `CRM-${typedLead.id.slice(0, 32)}`,
      criar_processo: true,
      tipo_parte: "PA",
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response) return { ...resultado("retry", "Gestão indisponível"), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
  if (response.ok) {
    const body = await response.json().catch(() => null) as { pessoa_codigo?: unknown; processo_codigo?: unknown } | null;
    if (!body || !codigoPessoaValido(body.pessoa_codigo) || !codigoPessoaValido(body.processo_codigo)) {
      return resultado("error", "recibo_gestao_invalido");
    }
    const vinculo = await confirmarOuCriarVinculo(admin, row, typedLead.contact_id, link, body.pessoa_codigo);
    if (vinculo) return vinculo;
    const processo = await vincularProcesso(admin, row, typedLead.contact_id, body.processo_codigo);
    if (processo) return processo;
    return resultado("ok", "cliente_e_caso_sincronizados");
  }
  if (response.status >= 500 || response.status === 429) {
    return { ...resultado("retry", `Gestão respondeu ${response.status}`), retry_at: new Date(Date.now() + RETRY_MS).toISOString() };
  }
  return resultado("error", `Gestão recusou a contratação (${response.status})`);
}

export const advomaxContratacaoHandler: EventHandler = {
  key: CONSUMER_KEY,
  events: ["lead.won", "lead.stage_changed"],
  handle,
};
