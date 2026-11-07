import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { checkConnection } from "@/lib/amigo/connection";
import { getAmigoConfig } from "@/lib/amigo/store";
import { linkAmigoPatient } from "@/lib/amigo/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { amigoFailure } from "../_shared";

export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "amigo_links" });
  if (!auth.ok) return auth.response;
  try {
    const contactId = z
      .uuid()
      .optional()
      .parse(new URL(req.url).searchParams.get("contact_id") ?? undefined);
    if (!contactId && !roleAtLeast(auth.org.role, "manager"))
      return fail("forbidden", "Selecione o contato para consultar os vínculos.", 403, {
        requestId,
      });
    const config = await getAmigoConfig(auth.org.orgId);
    if (!config.connection_id)
      return ok({ links: [], appointments: [], operations: [] }, { requestId });
    checkConnection(
      config.connection_id,
      req.headers.get("X-Amigo-Connection") ?? undefined,
      Boolean(contactId),
    );
    const db = createAdminClient();
    if (contactId) {
      const { data: contact, error } = await db
        .from("contacts")
        .select("id")
        .eq("organization_id", auth.org.orgId)
        .eq("id", contactId)
        .maybeSingle();
      if (error || !contact)
        return fail("not_found", "Contato não encontrado.", 404, { requestId });
    }
    let query = db
      .from("amigo_patient_links")
      .select("patient_id,contact_id,lead_id")
      .eq("organization_id", auth.org.orgId)
      .eq("connection_id", config.connection_id);
    if (contactId) query = query.eq("contact_id", contactId);
    const { data: links, error } = await query.limit(500);
    if (error) throw new Error("links");
    let appointments = db
      .from("amigo_appointment_links")
      .select("id,attendance_id,appointment_id,patient_id,remote_status,remote_data,synced_at")
      .eq("organization_id", auth.org.orgId)
      .eq("connection_id", config.connection_id);
    if (contactId)
      appointments = appointments.in(
        "patient_id",
        (links ?? []).map((l) => l.patient_id),
      );
    const { data: appointmentRows, error: appointmentError } = await appointments
      .order("synced_at", { ascending: false })
      .limit(500);
    if (appointmentError) throw new Error("appointments");
    const { data: operations, error: operationError } = roleAtLeast(auth.org.role, "manager")
      ? await db
          .from("amigo_operations")
          .select("id,operation,state,created_at,updated_at,target_id")
          .eq("organization_id", auth.org.orgId)
          .eq("connection_id", config.connection_id)
          .in("state", ["prepared", "sent", "uncertain"])
          .order("created_at", { ascending: false })
          .limit(100)
      : { data: [], error: null };
    if (operationError) throw new Error("operations");
    return ok(
      { links: links ?? [], appointments: appointmentRows ?? [], operations: operations ?? [] },
      { requestId },
    );
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
export async function POST(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "amigo_links" });
  if (!auth.ok) return auth.response;
  try {
    const input = z
      .strictObject({
        patient_id: z.number().int().positive(),
        contact_id: z.uuid(),
        lead_id: z.uuid().optional(),
      })
      .parse(await req.json());
    const result = await linkAmigoPatient(
      {
        organizationId: auth.org.orgId,
        actor: { type: "user", id: auth.user.id, role: auth.org.role },
        role: auth.org.role,
        requestId,
        contactId: input.contact_id,
        expectedConnectionId: z
          .uuid()
          .optional()
          .parse(req.headers.get("X-Amigo-Connection") ?? undefined),
      },
      input,
    );
    return ok(result, { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
