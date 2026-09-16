import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;
export type AdvomaxMatchStatus = "client" | "person" | "ambiguous" | "not_found";

type MatchResponse = {
  status: AdvomaxMatchStatus;
  correspondencias: Array<{ codigo: number; cliente: boolean }>;
};

const RECHECK_MS = 24 * 60 * 60 * 1_000;

export function deveIdentificarNoAdvomax(checkedAt: string | null, now = Date.now()): boolean {
  if (!checkedAt) return true;
  const checked = Date.parse(checkedAt);
  return !Number.isFinite(checked) || now - checked >= RECHECK_MS;
}

export function parseAdvomaxMatch(value: unknown): MatchResponse | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    !["client", "person", "ambiguous", "not_found"].includes(String(row.status)) ||
    !Array.isArray(row.correspondencias) ||
    !row.correspondencias.every((item) => {
      if (!item || typeof item !== "object") return false;
      const match = item as Record<string, unknown>;
      return (
        Number.isInteger(match.codigo) &&
        Number(match.codigo) > 0 &&
        typeof match.cliente === "boolean"
      );
    })
  )
    return null;
  const parsed = row as MatchResponse;
  if (parsed.status === "not_found" && parsed.correspondencias.length !== 0) return null;
  if (parsed.status === "ambiguous" && parsed.correspondencias.length < 2) return null;
  if (
    (parsed.status === "client" || parsed.status === "person") &&
    parsed.correspondencias.length !== 1
  )
    return null;
  const unica = parsed.correspondencias[0];
  if (parsed.status === "client" && unica?.cliente !== true) return null;
  if (parsed.status === "person" && unica?.cliente !== false) return null;
  return parsed;
}

/** Best-effort: nunca impede a entrada da mensagem do WhatsApp. */
export async function identificarContatoNoAdvomax(
  admin: Admin,
  input: { organizationId: string; contactId: string; requestId?: string },
): Promise<void> {
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) return;
  try {
    const [{ data: contact }, { data: existingLink }] = await Promise.all([
      admin
        .from("contacts")
        .select("phone_number,advomax_match_checked_at,is_anonymized")
        .eq("organization_id", input.organizationId)
        .eq("id", input.contactId)
        .maybeSingle(),
      admin
        .from("advomax_contact_links" as never)
        .select("id,status")
        .eq("organization_id", input.organizationId)
        .eq("contact_id", input.contactId)
        .maybeSingle(),
    ]);
    if (!contact?.phone_number || contact.is_anonymized || existingLink) return;
    if (!deveIdentificarNoAdvomax(contact.advomax_match_checked_at)) return;

    const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
    const response = await fetch(
      `${base}/integracoes/crm/pessoas/por-telefone?telefone=${encodeURIComponent(contact.phone_number)}`,
      {
        headers: {
          "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
          "X-CRM-Organization-Id": input.organizationId,
        },
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) return;
    const body = parseAdvomaxMatch(await response.json().catch(() => null));
    if (!body) return;

    let status = body.status;
    const unica = body.correspondencias.length === 1 ? body.correspondencias[0] : null;
    if ((status === "client" || status === "person") && unica) {
      const { error } = await admin.from("advomax_contact_links" as never).insert({
        organization_id: input.organizationId,
        contact_id: input.contactId,
        pessoa_codigo: unica.codigo,
        status: "linked",
        authority_source: "advomax_phone",
        authority_epoch: 1,
        last_synced_at: new Date().toISOString(),
      } as never);
      if (error?.code === "23505") status = "ambiguous";
      else if (error) throw error;
      else
        await audit({
          action: "contact.advomax_link_reconciled",
          organizationId: input.organizationId,
          resourceType: "advomax_contact_link",
          requestId: input.requestId,
          metadata: {
            contact_id: input.contactId,
            pessoa_codigo: unica.codigo,
            source: "phone_match",
          },
        });
    }

    const { error: updateError } = await admin
      .from("contacts")
      .update({
        advomax_match_status: status,
        advomax_match_count: body.correspondencias.length,
        advomax_match_checked_at: new Date().toISOString(),
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId);
    if (updateError) throw updateError;
  } catch (error) {
    logger.warn("advomax: identificação automática do contato falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      detail: error instanceof Error ? error.message.slice(0, 160) : "desconhecido",
    });
  }
}
