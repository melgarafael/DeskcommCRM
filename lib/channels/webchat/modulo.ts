import type { SupabaseClient } from "@supabase/supabase-js";

import { moduloLigado } from "@/lib/instalacao/modulos";

/**
 * O chat no site (`canal_webchat`) é MÓDULO OPCIONAL da instalação, desligado de fábrica.
 *
 * Ligado pela instalação (`MODULO_CANAL_WEBCHAT` em `platform_config`) e não desligado pela
 * empresa (`organization_modules`). Sem linha, ou com valor que não seja `ligado`, é desligado:
 * a régua de `moduloLigado` é falha fechada.
 */
export async function chatNoSiteLigado(admin: SupabaseClient, organizationId: string): Promise<boolean> {
  return moduloLigado(admin, "canal_webchat", organizationId);
}
