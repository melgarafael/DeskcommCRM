import { ok } from "@/lib/api/wrappers";
import { extensionFailure, extensionId, requireExtensionPlatform } from "@/lib/extensions/http";
import { girarSegredoDaInstalacao } from "@/lib/extensions/girar-segredo";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

/**
 * Gera (ou gira) o segredo de uma instalação `connected` (spec 33, F2, emenda 3). O segredo em claro
 * sai SÓ nesta resposta, com `Cache-Control: no-store`. Sem `Idempotency-Key` e sem recibo: repetir o
 * pedido gera outro segredo, e um recibo reproduziria o valor em claro.
 * Só sessão de quem administra a instalação, como a rota `switch`: não entra em
 * `lib/auth/public-paths.ts` e nenhum token alcança esta rota.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const denied = await requireSupportWrite();
    if (denied) return denied;
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    const id = extensionId((await context.params).id);
    const girado = await girarSegredoDaInstalacao(authz.user.id, id);
    return ok(girado, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return extensionFailure(error);
  }
}
