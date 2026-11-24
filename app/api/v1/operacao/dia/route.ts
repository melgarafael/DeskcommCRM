/**
 * GET /api/v1/operacao/dia?dia=YYYY-MM-DD — a Operação do dia (viewer+).
 *
 * O mesmo JSON que a tela `/app/operacao` desenha, e que ela pede de novo a
 * cada 30 s. Sem `dia`, é hoje no fuso da organização. A organização vem da
 * sessão (`requireRole`), nunca da query; os dados vêm pelo client da sessão,
 * então a RLS também filtra (`lib/operacao/ler-para-a-sessao.ts`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { lerOperacaoDaSessao } from "@/lib/operacao/ler-para-a-sessao";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "operacao_do_dia" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  try {
    const r = await lerOperacaoDaSessao(authz.org.orgId, req.nextUrl.searchParams.get("dia"));
    if (!r.ok) {
      return fail(
        "validation_failed",
        r.motivo === "dia_no_futuro" ? t("Escolha hoje ou um dia que já passou.") : t("Data inválida."),
        422,
        { requestId },
      );
    }
    return ok(r.operacao, { requestId, meta: { hoje: r.hoje } });
  } catch (err) {
    logger.error("operacao/dia: leitura falhou", {
      organization_id: authz.org.orgId,
      request_id: requestId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", t("Não deu para carregar a operação do dia agora."), 500, { requestId });
  }
}
