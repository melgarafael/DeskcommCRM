import { randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { concluirSeAssinadoEPago } from "@/lib/agencia/contratos/conclusao";
import { configDosContratos, pagamentoConfirmado, segredoConfere } from "@/lib/agencia/contratos/integracoes";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Aviso de pagamento da InfinitePay (docs/agencia/SPEC-contratos.md, K4). Público
 * no proxy (prefixo `/api/v1/webhooks/`). A InfinitePay não assina o aviso: a
 * autenticidade vem do segredo no caminho E da conferência ativa no
 * `payment_check` — só `paid: true` de lá marca o contrato como pago.
 * Responde rápido (a InfinitePay pede menos de 1 s) e processa depois.
 */
const avisoSchema = z.object({
  order_nsu: z.string().min(3).max(120),
  transaction_nsu: z.string().min(1).max(120),
  invoice_slug: z.string().min(1).max(120),
  receipt_url: z.string().url().max(500).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ segredo: string }> }) {
  const requestId = randomUUID();
  const { segredo } = await params;
  if (!segredoConfere(segredo, (await configDosContratos()).segredo)) return fail("forbidden", "Segredo inválido.", 403, { requestId });
  const p = avisoSchema.safeParse(await req.json().catch(() => null));
  if (!p.success) return fail("validation_error", "Aviso de pagamento incompleto.", 400, { requestId });

  const db = createAdminClient();
  const { data } = await db.from("agencia_contratos").select("id, pago_em").eq("pagamento_order_nsu", p.data.order_nsu).maybeSingle();
  const c = data as { id: string; pago_em: string | null } | null;
  if (!c) return ok({ recebido: true, contrato: false }, { requestId });
  if (c.pago_em) return ok({ recebido: true, ja_pago: true }, { requestId });

  after(async () => {
    try {
      const pago = await pagamentoConfirmado({ orderNsu: p.data.order_nsu, transactionNsu: p.data.transaction_nsu, slug: p.data.invoice_slug });
      if (!pago) {
        logger.warn("agência: aviso de pagamento que o payment_check não confirmou", { requestId, contrato: c.id });
        return;
      }
      await db
        .from("agencia_contratos")
        .update({
          pago_em: new Date().toISOString(),
          pagamento_slug: p.data.invoice_slug,
          pagamento_recibo: p.data.receipt_url ?? null,
          atualizado_em: new Date().toISOString(),
        })
        .eq("id", c.id)
        .is("pago_em", null);
      void audit({ action: "agencia.contrato_pago", organizationId: null, resourceType: "agencia_contrato", resourceId: c.id, metadata: { via: "infinitepay" }, requestId });
      await concluirSeAssinadoEPago(c.id, null);
    } catch (e) {
      logger.error("agência: aviso da InfinitePay falhou ao processar", { requestId, detalhe: e instanceof Error ? e.message : String(e) });
    }
  });
  return ok({ recebido: true }, { requestId });
}
