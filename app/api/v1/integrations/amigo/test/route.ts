import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { loadAmigoConnection } from "@/lib/amigo/store";
import { AmigoDomainError } from "@/lib/amigo/access";
import { requestAmigo } from "@/lib/amigo/transport";
import { ok } from "@/lib/api/wrappers";
import { amigoFailure } from "../_shared";

export async function POST(req: Request) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "amigo_config" });
  if (!auth.ok) return auth.response;
  try {
    const input = z
      .strictObject({ token: z.string().trim().min(1).max(8192).optional() })
      .parse(await req.json());
    const token = input.token ?? (await loadAmigoConnection(auth.org.orgId))?.token;
    if (!token)
      throw new AmigoDomainError(
        "amigo_not_configured",
        422,
        "Informe o token para testar a conexão.",
      );
    const result = await requestAmigo(token, "places", {});
    return ok({ valid: true, places: result.data }, { requestId });
  } catch (error) {
    return amigoFailure(error, requestId);
  }
}
