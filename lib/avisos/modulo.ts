import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O aviso do admin para a equipe (#1418) é MÓDULO OPCIONAL da instalação,
 * desligado por padrão (`lib/instalacao/modulos.ts`): muita instalação tem uma
 * ou duas pessoas, e um recado para a equipe não serve a elas. Desligado, a
 * rota não existe: 404, a mesma resposta de uma rota nunca instalada — o mesmo
 * desenho de `seSetoresDesligado`. A rota chama isto antes de autorizar.
 */
export async function seAvisosDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "avisos")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}
