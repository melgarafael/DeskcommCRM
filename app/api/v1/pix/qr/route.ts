/**
 * POST /api/v1/pix/qr — gera PNG do BR Code (data URL) a partir do payload EMV.
 * Usado pelo composer para anexar o QR da cobrança/chave.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import QRCode from "qrcode";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  payload: z.string().trim().min(20).max(512),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pix_keys" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  try {
    const dataUrl = await QRCode.toDataURL(parsed.data.payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
      type: "image/png",
    });
    return ok({ data_url: dataUrl }, { requestId });
  } catch {
    return fail("internal_error", t("Não foi possível gerar o QR Code."), 500, { requestId });
  }
}
