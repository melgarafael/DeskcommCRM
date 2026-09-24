import { z } from "zod";

import { ok } from "@/lib/api/wrappers";
import { extensionFailure, operationKey, requireExtensionPlatform } from "@/lib/extensions/http";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { instalarModulo } from "@/lib/modulos/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const bodySchema = z.object({ modulo: z.string().min(1).max(40) });

/** Instala um módulo NA INSTÂNCIA (ADR-0002, D3) — administrador da instalação, nunca por
 * organização. Corpo e cabeçalho seguem o mesmo contrato das extensões: `Idempotency-Key`
 * decide se um pedido repetido reexecuta ou só devolve o recibo anterior. */
export async function POST(request: Request): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    const key = operationKey(request);
    const input = bodySchema.parse(await request.json());
    return ok(await instalarModulo(authz.user.id, key, input.modulo));
  } catch (error) {
    return extensionFailure(error);
  }
}
