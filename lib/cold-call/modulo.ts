import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O Cold Call (#3933) é MÓDULO OPCIONAL da instalação, desligado por padrão
 * (`lib/instalacao/modulos.ts`). Desligado, as rotas de `/api/v1/cold-call`
 * não existem: 404, a mesma resposta de uma rota nunca instalada. As rotas
 * chamam isto DEPOIS de autorizar, para que quem não está logado receba o 401
 * de sempre e não descubra pelo código se o módulo está ligado.
 */
export async function seColdCallDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "cold_call")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}
