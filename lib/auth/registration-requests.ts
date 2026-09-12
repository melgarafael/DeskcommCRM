import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/smtp";

export type RegistrationKind = "create_organization" | "join_organization";

export type RegistrationIntent =
  | { kind: "create_organization"; organizationName: string }
  | { kind: "join_organization"; organizationId: string };

export async function createRegistrationRequest(userId: string, intent: RegistrationIntent) {
  const admin = createAdminClient();
  if (intent.kind === "join_organization") {
    const { data: organization } = await admin
      .from("organizations")
      .select("id")
      .eq("id", intent.organizationId)
      .eq("status", "active")
      .maybeSingle();
    if (!organization) throw new Error("registration_requested_organization_not_found");
  }

  const existing = await admin
    .from("registration_requests")
    .select("id, status")
    .eq("user_id", userId)
    .eq("kind", intent.kind)
    .eq("status", "pending")
    .maybeSingle();
  if (existing.data) return { created: false, id: existing.data.id, status: existing.data.status };
  if (existing.error) throw new Error(`registration_request_lookup_failed: ${existing.error.message}`);

  const query = admin.from("registration_requests");
  const { data, error } = intent.kind === "create_organization"
    ? await query.insert({ user_id: userId, kind: intent.kind, requested_organization_name: intent.organizationName }).select("id, status").single()
    : await query.insert({ user_id: userId, kind: intent.kind, requested_organization_id: intent.organizationId }).select("id, status").single();

  // O índice parcial protege a concorrência; o pedido pendente existente é a
  // resposta idempotente para clique repetido no link de confirmação.
  if (error && error.code === "23505") return { created: false, id: null };
  if (error) throw new Error(`registration_request_insert_failed: ${error.message}`);
  return { created: true, id: data.id, status: data.status };
}

export function registrationIntentFromMetadata(metadata: Record<string, unknown> | undefined): RegistrationIntent | null {
  const kind = metadata?.registration_kind;
  if (kind === "create_organization" && typeof metadata?.org_name === "string" && metadata.org_name.trim()) {
    return { kind, organizationName: metadata.org_name.trim() };
  }
  if (kind === "join_organization" && typeof metadata?.requested_organization_id === "string") {
    return { kind, organizationId: metadata.requested_organization_id };
  }
  return null;
}

export async function notifyRegistrationApprovers(intent: RegistrationIntent, applicantEmail: string) {
  const admin = createAdminClient();
  const recipientIds = intent.kind === "create_organization"
    ? (await admin.from("platform_admins").select("user_id").is("revoked_at", null)).data?.map((row) => row.user_id) ?? []
    : (await admin.from("user_organizations").select("user_id").eq("organization_id", intent.organizationId).eq("role", "admin").is("revoked_at", null)).data?.map((row) => row.user_id) ?? [];
  const recipients = (await Promise.all(recipientIds.map(async (id) => (await admin.auth.admin.getUserById(id)).data.user?.email ?? null))).filter((email): email is string => Boolean(email));
  if (!recipients.length) return { ok: false as const, error: "no_recipients" };
  const subject = intent.kind === "create_organization" ? "Nova solicitação para criar empresa" : "Nova solicitação para entrar na empresa";
  return sendEmail({ to: recipients, subject, text: `${applicantEmail} enviou uma solicitação. Acesse a aplicação para aprovar ou recusar.`, html: `<p>${applicantEmail.replace(/&/g, "&amp;").replace(/</g, "&lt;")} enviou uma solicitação.</p><p>Acesse a aplicação para aprovar ou recusar.</p>` });
}
