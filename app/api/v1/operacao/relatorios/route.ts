import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/operacao/relatorios — "Gerar agora / regenerar" o relatório de um
 * dia (manager+).
 *
 * Corpo: `{ dia?: "YYYY-MM-DD" }` (sem `dia`, hoje no fuso da organização).
 * Regera POR CIMA da linha do dia (`on conflict (organization_id, dia) do
 * update`): repetir o clique substitui, nunca duplica. A organização vem da
 * sessão; a escrita é pelo service role com ela escrita
 * (`lib/operacao/relatorio-diario.ts`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { resolverDia } from "@/lib/operacao/regras";
import { contextoDaOrganizacao, gerarRelatorioDiario } from "@/lib/operacao/relatorio-diario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({ dia: z.string().max(10).optional() }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "relatorio_operacao_diario" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  let body: unknown = {};
  try {
    const texto = await req.text();
    body = texto.trim() === "" ? {} : JSON.parse(texto);
  } catch {
    return fail("validation_failed", t("JSON inválido."), 422, { requestId });
  }
  const parsed = corpoSchema.safeParse(body);
  if (!parsed.success) return fail("validation_failed", t("Payload inválido."), 422, { requestId });

  const admin = createAdminClient();
  try {
    const contexto = await contextoDaOrganizacao(admin, orgId);
    const pedido = resolverDia(parsed.data.dia, contexto.fuso);
    if (!pedido.ok) {
      return fail(
        "validation_failed",
        pedido.motivo === "dia_no_futuro" ? t("Escolha hoje ou um dia que já passou.") : t("Data inválida."),
        422,
        { requestId },
      );
    }
    const r = await gerarRelatorioDiario({
      admin,
      orgId,
      dia: pedido.dia,
      geradoPor: "usuario",
      substituir: true,
      contexto,
    });
    if (r.gravou) {
      void audit({
        action: "operacao.relatorio_gerado",
        organizationId: orgId,
        actorUserId: authz.user.id,
        resourceType: "relatorio_operacao_diario",
        resourceId: r.id,
        requestId,
        metadata: {
          dia: pedido.dia,
          gerado_por: "usuario",
          novas: r.conteudo.contadores.novas.total,
          com_entrada: r.conteudo.contadores.com_entrada.total,
          aguardando: r.conteudo.aguardando.length,
        },
      });
    }
    return ok({ id: r.id, dia: pedido.dia }, { requestId, status: 201 });
  } catch (err) {
    logger.error("operacao/relatorios: geração falhou", {
      organization_id: orgId,
      request_id: requestId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", t("Não deu para gerar o relatório agora."), 500, { requestId });
  }
}
