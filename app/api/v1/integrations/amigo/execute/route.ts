import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { amigoOperations } from "@/lib/amigo/contracts";
import { executeAmigo } from "@/lib/amigo/service";
import { ok } from "@/lib/api/wrappers";
import { amigoFailure } from "../_shared";

const inputSchema = z.strictObject({
  operation: z.enum(amigoOperations),
  input: z.record(z.string(), z.unknown()),
  contact_id: z.uuid().optional(),
  operation_key: z.string().min(1).max(200).optional(),
});
export async function POST(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "amigo_operation" });
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await req.json());
    const result = await executeAmigo(
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
      input.operation,
      input.input,
      z
        .string()
        .min(1)
        .max(200)
        .optional()
        .parse(req.headers.get("Idempotency-Key") ?? input.operation_key),
    );
    return ok(result, { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
