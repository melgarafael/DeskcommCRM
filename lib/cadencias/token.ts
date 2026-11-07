/** Links públicos separados por finalidade; falta de segredo recusa, nunca usa piso conhecido. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type FinalidadeDoLink = "abertura" | "descadastro";
export interface CadenciaLinkPayload {
  enrollment_id: string;
  organization_id: string;
  cadence_id: string;
  lead_id: string;
  passo_id: string;
}

const payloadSchema = z.object({
  enrollment_id: z.string().uuid(), organization_id: z.string().uuid(),
  cadence_id: z.string().uuid(), lead_id: z.string().uuid(), passo_id: z.string().min(1).max(200),
  finalidade: z.enum(["abertura", "descadastro"]),
}).strict();

function assinatura(body: string, finalidade: FinalidadeDoLink): Buffer | null {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret?.trim()) return null;
  return createHmac("sha256", secret).update(`cadencias:v1:${finalidade}:${body}`).digest();
}

export function signCadenciaLink(payload: CadenciaLinkPayload, finalidade: FinalidadeDoLink): string {
  const body = Buffer.from(JSON.stringify({ ...payload, finalidade })).toString("base64url");
  const sig = assinatura(body, finalidade);
  if (!sig) throw new Error("cadencia_link_secret_missing");
  return `${body}.${sig.toString("base64url")}`;
}

export function verifyCadenciaLink(token: string, finalidade: FinalidadeDoLink): CadenciaLinkPayload | null {
  if (token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, encoded] = parts;
  if (!body || !encoded) return null;
  const expected = assinatura(body, finalidade);
  if (!expected) return null;
  try {
    const provided = Buffer.from(encoded, "base64url");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.finalidade !== finalidade) return null;
    const { finalidade: _finalidade, ...payload } = parsed.data;
    return payload;
  } catch { return null; }
}
