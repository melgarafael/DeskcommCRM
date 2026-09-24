import { ok } from "@/lib/api/wrappers";
import { extensionFailure, requireExtensionPlatform } from "@/lib/extensions/http";
import { listarModulos } from "@/lib/modulos/service";

export const dynamic = "force-dynamic";

/** Catálogo de módulos instaláveis + o que já está instalado nesta instância (ADR-0002, D3). */
export async function GET(): Promise<Response> {
  try {
    const authz = await requireExtensionPlatform();
    if (!authz.ok) return authz.response;
    return ok(await listarModulos(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return extensionFailure(error);
  }
}
