/**
 * De falha de intervenção para resposta HTTP — um mapa só, quatro rotas.
 *
 * Vive separado de `intervencao.ts` porque aquele arquivo não conhece Next: ele
 * é a regra, e a regra é testada sem servidor. Aqui mora o que só existe na
 * borda — o código canônico e o status.
 */
import { fail } from "@/lib/api/wrappers";
import type { FalhaDaIntervencao } from "./intervencao";

export function respostaDaFalha(
  falha: FalhaDaIntervencao,
  requestId: string,
  t: (texto: string) => string,
) {
  switch (falha.codigo) {
    case "nao_encontrado":
      return fail("not_found", t(falha.mensagem), 404, { requestId });
    case "estado_incompativel":
    case "motor_ocupado":
      // 409, e a MENSAGEM carrega a diferença: "mudou de estado" e "o automático
      // está executando agora" pedem coisas diferentes de quem clicou (recarregar
      // vs. tentar de novo em instantes). O `details.motivo` deixa isso legível
      // por máquina sem inventar um código de erro por caso.
      return fail("state_conflict", t(falha.mensagem), 409, {
        requestId,
        details: { motivo: falha.codigo },
      });
    case "caminho_invalido":
      return fail("invalid_request", t(falha.mensagem), 400, { requestId, details: falha.detalhes });
    case "sem_caminho":
    case "escolha_necessaria":
      return fail("unprocessable_entity", t(falha.mensagem), 422, {
        requestId,
        details: { motivo: falha.codigo, ...(falha.detalhes as Record<string, unknown> | undefined) },
      });
    case "adiamento_invalido":
      return fail("validation_failed", t(falha.mensagem), 422, { requestId, details: falha.detalhes });
    case "erro_interno":
      // Texto de driver/Postgres — nunca traduzir (doutrina do repo).
      return fail("internal_error", falha.mensagem, 500, { requestId });
  }
}
