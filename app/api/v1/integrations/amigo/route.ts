import { checkConnection } from "@/lib/amigo/connection";
import { agentOperations } from "@/lib/amigo/agent-permissions";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getAmigoConfig, saveAmigoConfig, disconnectAmigo } from "@/lib/amigo/store";
import { audit } from "@/lib/audit";
import { ok } from "@/lib/api/wrappers";
import { amigoFailure } from "./_shared";

export const dynamic = "force-dynamic";
const configInput = z.strictObject({
  token: z.string().trim().min(1).max(8192).optional(),
  active: z.boolean().optional(),
  default_place_id: z.number().int().positive().optional(),
  timezone: z.string().min(1).max(100).optional(),
  allow_same_day: z.boolean().nullable().optional(),
  months_ahead: z
    .union([z.literal(3), z.literal(6)])
    .nullable()
    .optional(),
  reminders_enabled: z.boolean().optional(),
  agent_operations: z
    .array(z.enum(agentOperations))
    .max(agentOperations.length)
    .refine((v) => new Set(v).size === v.length)
    .optional(),
});

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "amigo_config" });
  if (!auth.ok) return auth.response;
  try {
    return ok(await getAmigoConfig(auth.org.orgId), { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
export async function PUT(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "amigo_config" });
  if (!auth.ok) return auth.response;
  try {
    const input = configInput.parse(await req.json());
    const current = await getAmigoConfig(auth.org.orgId);
    if (current.connection_id)
      checkConnection(
        current.connection_id,
        req.headers.get("X-Amigo-Connection") ?? undefined,
        true,
      );
    const result = await saveAmigoConfig(auth.org.orgId, auth.user.id, input);
    await audit({
      action: "amigo.configured",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "amigo_connection",
      resourceId: result.connection_id,
      requestId,
      metadata: { active: result.active, credential_replaced: input.token !== undefined },
    });
    return ok(result, { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
export async function DELETE(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "amigo_config" });
  if (!auth.ok) return auth.response;
  try {
    const current = await getAmigoConfig(auth.org.orgId);
    if (current.connection_id)
      checkConnection(
        current.connection_id,
        req.headers.get("X-Amigo-Connection") ?? undefined,
        true,
      );
    await disconnectAmigo(auth.org.orgId);
    await audit({
      action: "amigo.disconnected",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "amigo_connection",
      requestId,
    });
    return ok({ disconnected: true }, { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
