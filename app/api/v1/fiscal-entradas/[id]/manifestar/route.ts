/**
 * POST /api/v1/fiscal-entradas/[id]/manifestar — declara ciência da nota.
 *
 * Sem manifestação, a SEFAZ não libera o XML completo (regra dela, não
 * nossa) — e sem XML não há itens para importar. A ciência (210210) é o
 * evento seguro de rotina: diz "vi a nota", sem confirmar a operação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { manifestarNaSefaz, type ContextoEntrada } from "@/lib/fiscal/entrada";
import { carregarContextoSped } from "@/lib/fiscal/sped-payload";
import { resolverProvedor } from "@/lib/fiscal/provedor";
import {
  COLUNAS_DA_ENTRADA,
  manifestarEntradaSchema,
  type EntradaFiscal,
} from "@/lib/schemas/fiscal-entrada";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "fiscal-entradas" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const parsed = manifestarEntradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (parsed.data.evento === "210240" && (parsed.data.justificativa ?? "").trim().length < 15) {
    return fail("validation_failed", "Operação não realizada exige justificativa (15+ letras).", 422, { requestId });
  }

  const supabase = await createClient();
  const { data: linha } = await supabase
    .from("fiscal_entradas")
    .select(COLUNAS_DA_ENTRADA)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const entrada = linha as unknown as EntradaFiscal | null;
  if (!entrada) return fail("not_found", "Entrada não encontrada.", 404, { requestId });
  if (entrada.status === "importada") {
    return fail("invalid_state_transition", "Entrada já importada — manifestação não muda mais nada.", 409, { requestId });
  }
  if (entrada.status === "ignorada") {
    return fail("invalid_state_transition", "Entrada ignorada — reative antes de manifestar.", 409, { requestId });
  }

  const { data: cfgRaw } = await supabase
    .from("fiscal_settings")
    .select("provedor")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (resolverProvedor({ provedor: (cfgRaw as unknown as { provedor?: string | null } | null)?.provedor ?? null }) !== "spednfe") {
    return fail("validation_failed", "Sem emissor fiscal com certificado.", 422, { requestId });
  }
  const ctx = await carregarContextoSped(authz.org.orgId);
  if (!ctx || !ctx.emitente.uf || !ctx.emitente.certificado_path || !ctx.senhaCertificado) {
    return fail("validation_failed", "Faltam UF, certificado (.pfx) ou senha na configuração fiscal.", 422, { requestId });
  }
  const ctxEntrada: ContextoEntrada = {
    ambiente: ctx.emitente.ambiente,
    cnpj: (ctx.emitente.emitente_documento ?? "").replace(/\D/g, ""),
    razao: ctx.emitente.emitente_documento ?? "",
    ie: ctx.emitente.ie ?? "",
    uf: ctx.emitente.uf,
    certificadoPath: ctx.emitente.certificado_path,
    senhaCertificado: ctx.senhaCertificado,
  };

  const resultado = await manifestarNaSefaz(ctxEntrada, entrada.chave, parsed.data.evento, parsed.data.justificativa);
  if (!resultado.ok) {
    return fail("upstream_unavailable", resultado.erro ?? "SEFAZ inalcançável.", 502, { requestId });
  }

  await supabase
    .from("fiscal_entradas")
    .update({
      manifestacao: resultado.manifestacao,
      manifestada_em: new Date().toISOString(),
      status: "manifestada",
    })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal_entrada.manifestada",
    resourceType: "fiscal_entradas",
    resourceId: id,
    requestId,
  });

  return ok({ manifestacao: resultado.manifestacao, protocolo: resultado.protocolo }, { requestId });
}
