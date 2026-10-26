import { randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { concluirSeAssinadoEPago } from "@/lib/agencia/contratos/conclusao";
import { configDosContratos, documentoAssinadoNaZapsign, segredoConfere } from "@/lib/agencia/contratos/integracoes";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Aviso da ZapSign (docs/agencia/SPEC-contratos.md, K4). Público no proxy (prefixo
 * `/api/v1/webhooks/`): quem chama é a ZapSign. A autenticidade vem de DUAS
 * coisas — o segredo no caminho (cifrado em `agencia_config`) e a conferência
 * ativa: o documento é lido de volta na API da ZapSign com o token da agência, e
 * só o que ELA disser conta. O corpo do aviso nunca marca nada sozinho.
 */
const avisoSchema = z.object({
  event_type: z.string().max(60).optional(),
  token: z.string().min(8).max(100),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ segredo: string }> }) {
  const requestId = randomUUID();
  const { segredo } = await params;
  if (!segredoConfere(segredo, (await configDosContratos()).segredo)) return fail("forbidden", "Segredo inválido.", 403, { requestId });
  const p = avisoSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return fail("validation_error", "Aviso sem documento.", 400, { requestId });

  const db = createAdminClient();
  const { data } = await db
    .from("agencia_contratos")
    .select("id, assinado_em, situacao")
    .eq("zapsign_doc_token", p.data.token)
    .maybeSingle();
  const c = data as { id: string; assinado_em: string | null; situacao: string } | null;
  // Documento que não é de contrato nosso: 200 para a ZapSign não insistir.
  if (!c) return ok({ recebido: true, contrato: false }, { requestId });

  after(async () => {
    try {
      const doc = await documentoAssinadoNaZapsign(p.data.token);
      if (doc.recusado) {
        await db.from("agencia_contratos").update({ zapsign_situacao: "refused", atualizado_em: new Date().toISOString() }).eq("id", c.id);
        return;
      }
      if (!doc.assinado || c.assinado_em) return;
      await db
        .from("agencia_contratos")
        .update({ assinado_em: doc.quando ?? new Date().toISOString(), zapsign_situacao: "signed", atualizado_em: new Date().toISOString() })
        .eq("id", c.id)
        .is("assinado_em", null);
      void audit({ action: "agencia.contrato_assinado", organizationId: null, resourceType: "agencia_contrato", resourceId: c.id, metadata: { via: "zapsign" }, requestId });
      await concluirSeAssinadoEPago(c.id, null);
    } catch (e) {
      logger.error("agência: aviso da ZapSign falhou ao processar", { requestId, detalhe: e instanceof Error ? e.message : String(e) });
    }
  });
  return ok({ recebido: true }, { requestId });
}
