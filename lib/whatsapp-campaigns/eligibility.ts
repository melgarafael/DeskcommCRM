/**
 * Elegibilidade de destinatário de campanha — reusa is_blocked / telefone.
 * Opt-out no produto já materializa contacts.is_blocked.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type SkipReason =
  | "blocked"
  | "opt_out"
  | "invalid_phone"
  | "missing_phone"
  | "cross_tenant"
  | "session_unavailable"
  | "anonymized"
  | "merged";

export interface EligibilityOk {
  ok: true;
  contact: {
    id: string;
    phone_number: string;
    display_name: string | null;
    name: string | null;
    person_id: string | null;
    is_blocked: boolean;
  };
}

export async function checkContactEligibility(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<EligibilityOk | { ok: false; reason: SkipReason }> {
  const { data, error } = await admin
    .from("contacts")
    .select(
      "id, organization_id, phone_number, display_name, name, person_id, is_blocked, is_anonymized, is_merged_into, blocked_reason",
    )
    .eq("id", contactId)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "cross_tenant" };
  if (data.organization_id !== organizationId) return { ok: false, reason: "cross_tenant" };
  if (data.is_anonymized) return { ok: false, reason: "anonymized" };
  if (data.is_merged_into) return { ok: false, reason: "merged" };
  if (data.is_blocked) {
    const reason = String(data.blocked_reason ?? "").toLowerCase();
    if (reason.includes("opt") || reason.includes("stop")) {
      return { ok: false, reason: "opt_out" };
    }
    return { ok: false, reason: "blocked" };
  }
  if (!data.phone_number) return { ok: false, reason: "missing_phone" };
  if (!/^\+\d{10,15}$/.test(data.phone_number)) return { ok: false, reason: "invalid_phone" };

  return {
    ok: true,
    contact: {
      id: data.id,
      phone_number: data.phone_number,
      display_name: data.display_name,
      name: data.name,
      person_id: data.person_id,
      is_blocked: data.is_blocked,
    },
  };
}

export { classifySendError } from "@/lib/whatsapp-campaigns/classify-error";
