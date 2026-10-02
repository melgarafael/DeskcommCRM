import { requirePlatformAdminEscrita, type PlatformAdminContext } from "@/lib/auth/requirePlatformAdmin";
import { EscritaDePlatformAdminNegada, type RecusaDeEscritaDeAdmin } from "@/lib/auth/recusa-de-escrita-de-admin";

/**
 * `requirePlatformAdminEscrita()` para SERVER ACTION: a recusa volta como
 * `{ok:false, error}` em vez de lançar. Lançada, ela subia até o error boundary
 * e a pessoa via "algo deu errado" em vez de "seu acesso é somente leitura".
 * O resto (redirect de quem não é platform admin) segue lançando.
 * Rota de API usa o helper direto + `falhaDaEscritaDePlatformAdmin`.
 */
export async function escritaDeAdminOuRecusa(): Promise<
  { ok: true; ctx: PlatformAdminContext } | RecusaDeEscritaDeAdmin
> {
  try {
    return { ok: true, ctx: await requirePlatformAdminEscrita() };
  } catch (err) {
    if (err instanceof EscritaDePlatformAdminNegada) return { ok: false, error: err.code };
    throw err;
  }
}
