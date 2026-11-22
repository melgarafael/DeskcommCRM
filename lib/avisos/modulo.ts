import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O aviso do admin para a equipe (#1418) é MÓDULO OPCIONAL da instalação,
 * desligado por padrão (`lib/instalacao/modulos.ts`): muita instalação tem uma
 * ou duas pessoas, e um recado para a equipe não serve a elas. Desligado, a
 * rota não existe: 404, a mesma resposta de uma rota nunca instalada — o mesmo
 * desenho de `seSetoresDesligado`. A rota chama isto antes de autorizar.
 *
 * ─── A EMPRESA (#3868, F2 da #4871) ────────────────────────────────────────
 *
 * `organizacaoId` é OPCIONAL porque este é um portão de BIBLIOTECA: chamado de
 * rota, de ação e de trabalho de fundo, e a maioria dos chamadores pergunta
 * ANTES de saber de que empresa é a requisição. Quem tem a empresa em mãos a
 * passa, e aí a decisão é a de `moduloLigado`: a linha da empresa vence, a
 * ausência dela herda a instalação, instalação desligada é teto e falha de
 * leitura da empresa fecha. Quem NÃO passa vê exatamente o que via antes (só a
 * instalação) — e a chamada continua com dois argumentos, porque o contrato dos
 * chamadores antigos é vigiado por `toHaveBeenCalledWith(expect.anything(), "avisos")`.
 */
export async function seAvisosDesligado(
  requestId: string,
  organizacaoId?: string | null,
): Promise<Response | null> {
  const admin = createAdminClient();
  const ligado = organizacaoId
    ? await moduloLigado(admin, "avisos", organizacaoId)
    : await moduloLigado(admin, "avisos");
  if (ligado) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}
