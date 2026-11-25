import { fail } from "@/lib/api/wrappers";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Os setores de atendimento são MÓDULO OPCIONAL da instalação, desligado por
 * padrão (doc 213, `lib/instalacao/modulos.ts`). Desligado, nenhuma rota de
 * setor existe: 404, a mesma resposta de uma rota nunca instalada — o mesmo
 * desenho de `seModuloB2bDesligado`. Toda rota de setor chama isto antes de
 * autorizar: o módulo desligado não tem regra de papel para responder.
 *
 * ─── A EMPRESA (#3868, F2 da #4871) ────────────────────────────────────────
 *
 * `organizacaoId` é OPCIONAL porque este é um portão de BIBLIOTECA, chamado de
 * sete pontos (as rotas de setor, a fila da conversa e o filtro por setor da
 * lista de tarefas). Sete dos oito chamadores perguntam antes de autorizar, e
 * ali a empresa ainda não existe no contexto — eles se declaram sem ela. Quem
 * TEM a empresa em mãos (o filtro de tarefas, que já recebeu `organizationId`)
 * a passa, e a decisão vira a de `moduloLigado`: linha da empresa vence,
 * ausência herda a instalação, instalação desligada é teto e falha de leitura
 * da empresa fecha. Sem o argumento, o comportamento é o de hoje — só a
 * instalação, com a chamada de dois argumentos de sempre.
 */
export async function seSetoresDesligado(
  requestId: string,
  organizacaoId?: string | null,
): Promise<Response | null> {
  const admin = createAdminClient();
  const ligado = organizacaoId
    ? await moduloLigado(admin, "setores", organizacaoId)
    : await moduloLigado(admin, "setores");
  if (ligado) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}
