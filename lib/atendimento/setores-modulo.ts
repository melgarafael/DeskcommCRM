import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Os setores de atendimento são MÓDULO OPCIONAL da instalação, desligado por
 * padrão (doc 213, `lib/instalacao/modulos.ts`). Desligado, nenhuma rota de
 * setor existe: 404, a mesma resposta de uma rota nunca instalada — o mesmo
 * desenho de `seModuloB2bDesligado`. Toda rota de setor chama isto antes de
 * autorizar: o módulo desligado não tem regra de papel para responder.
 */
export async function seSetoresDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "setores")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}
