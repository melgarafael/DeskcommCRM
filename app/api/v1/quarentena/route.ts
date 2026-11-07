import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listarQuarentena, resumoDaQuarentena } from "@/lib/entrada/quarentena";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/v1/quarentena — a FILA do filtro de spam (#4026).
 *
 * ## A quarentena é VISÍVEL, e é o ponto inteiro
 *
 * Reter sem mostrar seria descartar com passos extras: a mensagem existe em
 * `messages`, mas ninguém sabe que ela está lá esperando. Esta rota é a lista
 * que o humano abre para ver o que foi retido (texto, contato, confiança e os
 * sinais que dispararam) e liberar uma por uma em `/api/v1/quarentena/[id]/liberar`.
 *
 * ## Quem vê
 *
 * Piso `agent`: é triagem de caixa de entrada, não relatório de gestão. Quem
 * atende precisa saber que há mensagem retida — quem gerencia decide o limiar
 * (`/api/v1/settings/atendimento`).
 *
 * ## `perdidas` no corpo
 *
 * O resumo traz `perdidas` = linhas de quarentena sem a mensagem correspondente.
 * É o contador de perda da issue e tem de ser SEMPRE zero: se um dia não for,
 * alguma poda apagou mensagem retida e o alarme tem de aparecer na tela, não no
 * log de um job.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "quarentena" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const limiteBruto = Number(new URL(req.url).searchParams.get("limite"));
  const limite = Number.isFinite(limiteBruto) && limiteBruto > 0 ? limiteBruto : 50;

  const admin = createAdminClient();
  try {
    const [itens, resumo] = await Promise.all([
      listarQuarentena(admin, { organizationId: authz.org.orgId, limite }),
      resumoDaQuarentena(admin, authz.org.orgId),
    ]);
    return ok({ itens, resumo }, { requestId });
  } catch (erro) {
    return fail(
      "internal_error",
      erro instanceof Error ? erro.message : t("Não foi possível listar a quarentena."),
      500,
      { requestId },
    );
  }
}
