import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A agência que administra clientes é MÓDULO OPCIONAL da instalação, desligado
 * de fábrica (doc 321, `lib/instalacao/modulos.ts`). Desligado, nenhuma rota de
 * agência existe: 404, a mesma resposta de uma rota nunca instalada — o desenho
 * de `seSetoresDesligado`. Toda rota de agência chama isto ANTES de autorizar.
 * O banco tem o mesmo portão (`fn_agencias_ligado`), então a rota fechada não é
 * a única coisa entre a agência e o cliente.
 */
export async function seAgenciasDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "agencias")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}
