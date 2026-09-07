import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { googleRpc } from "@/lib/agenda/google/sync-store";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();if (denied) return denied;
  const requestId = randomUUID();const auth = await requireRole("agent", { requestId, resource: "agenda" });if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const parsed = z.object({ expected_domain_revision: z.string(), expected_google_local_revision: z.string(), etag: z.string().nullable(), choice: z.enum(["google", "local", "preserve_remote", "retry"]) }).strict().safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success) return fail("validation_failed", "Atualize o compromisso antes de decidir.", 422, { requestId });
  try {
    await googleRpc(await createClient(), "fn_google_resolve", { p_org: auth.org.orgId, p_id: id, p_revision: parsed.data.expected_domain_revision,
      p_local_revision: parsed.data.expected_google_local_revision, p_etag: parsed.data.etag, p_choice: parsed.data.choice });
    void audit({ action: "agenda.google_resolution_requested", organizationId: auth.org.orgId, actorUserId: auth.user.id, resourceType: "calendar_appointment", resourceId: id, requestId, metadata: { choice: parsed.data.choice } });
    return ok({ pending: true }, { requestId });
  } catch (e) {
    const stale = e instanceof Error && "code" in e && e.code === "40001";
    return fail(stale ? "conflict" : "forbidden", stale ? "O compromisso mudou. Atualize a comparação antes de decidir." : "Esta decisão pertence ao responsável pelo compromisso.", stale ? 409 : 403, { requestId });
  }
}
