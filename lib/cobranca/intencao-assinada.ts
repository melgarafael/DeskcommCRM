import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const VALIDADE_DA_INTENCAO_MS = 7 * 24 * 60 * 60 * 1_000;
const schema = z.object({
  versao: z.literal(1), usuario_id: z.string().uuid(), plano_id: z.string().uuid(),
  organization_id: z.string().uuid(), nonce: z.string().uuid(), emitida_em: z.number().int().nonnegative(),
  expira_em: z.number().int().positive(), assinatura: z.string().regex(/^[a-f0-9]{64}$/),
});
type Intencao = z.infer<typeof schema>;
function assinar(p: Omit<Intencao, "assinatura">, segredo: string): string {
  return createHmac("sha256", segredo).update("cobranca-cadastro-v1\0").update(JSON.stringify([
    p.versao, p.usuario_id, p.organization_id, p.plano_id, p.nonce, p.emitida_em, p.expira_em,
  ])).digest("hex");
}

/** A auditoria aceita INSERT de tenants; somente este HMAC prova a origem. */
export function criarIntencaoDeContratacao(
  usuarioId: string, planoId: string, agora = Date.now(), segredo = process.env.INTERNAL_SECRET,
): Intencao | null {
  if (!segredo) return null; // Sem segredo válido, continuação manual; nunca chave pública de fallback.
  const p = { versao: 1 as const, usuario_id: usuarioId, organization_id: randomUUID(), plano_id: planoId, nonce: randomUUID(),
    emitida_em: agora, expira_em: agora + VALIDADE_DA_INTENCAO_MS };
  const checked = schema.safeParse({ ...p, assinatura: assinar(p, segredo) });
  return checked.success ? checked.data : null;
}

export function verificarIntencaoDeContratacao(
  bruto: unknown, usuarioId: string, planoId: string, agora = Date.now(), segredo = process.env.INTERNAL_SECRET,
): Intencao | null {
  if (!segredo) return null;
  const checked = schema.safeParse(bruto);
  if (!checked.success) return null;
  const p = checked.data;
  if (p.usuario_id !== usuarioId || p.plano_id !== planoId || p.emitida_em > agora || p.expira_em < agora ||
      p.expira_em !== p.emitida_em + VALIDADE_DA_INTENCAO_MS) return null;
  const esperada = assinar(p, segredo);
  return timingSafeEqual(Buffer.from(p.assinatura, "hex"), Buffer.from(esperada, "hex")) ? p : null;
}
