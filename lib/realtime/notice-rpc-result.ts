import { fail, ok } from "@/lib/api/wrappers";
/** Never forward a Postgres message/detail, source row or credential to a rejected caller. */
export function noticeRpcResult(
  result: { data: unknown; error: { code?: string } | null },
  requestId: string,
) {
  if (!result.error) return ok(result.data, { requestId });
  switch (result.error.code) {
    case "PT401":
      return fail("unauthorized", "Sessão encerrada.", 401, { requestId });
    case "PT403":
    case "42501":
      return fail("forbidden", "Acesso negado.", 403, { requestId });
    case "PT409":
      return fail("conflict", "Aviso alterado ou indisponível.", 409, {
        requestId,
      });
    case "22023":
    case "22P02":
      return fail("validation_failed", "Recibo inválido.", 422, { requestId });
    default:
      return fail(
        "internal_error",
        "Falha ao consultar ou confirmar avisos.",
        500,
        { requestId },
      );
  }
}
