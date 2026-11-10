/**
 * Links públicos separados por finalidade; falta de segredo recusa, nunca usa piso conhecido.
 * O de descadastro carrega só o id opaco do destinatário do envio
 * (`email_cadence_recipients`): nada de e-mail na URL, e ele resolve mesmo
 * depois de o negócio e a inscrição terem sido apagados.
 */
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
export interface DescadastroLinkPayload {
  destinatario_id: string;
}

const aberturaSchema = z.object({
  enrollment_id: z.string().uuid(), organization_id: z.string().uuid(),
  cadence_id: z.string().uuid(), lead_id: z.string().uuid(), passo_id: z.string().min(1).max(200),
  finalidade: z.literal("abertura"),
}).strict();
const descadastroSchema = z.object({
  destinatario_id: z.string().uuid(), finalidade: z.literal("descadastro"),
}).strict();

function assinatura(body: string, finalidade: FinalidadeDoLink): Buffer | null {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret?.trim()) return null;
  return createHmac("sha256", secret).update(`cadencias:v1:${finalidade}:${body}`).digest();
}

export function signCadenciaLink(payload: CadenciaLinkPayload, finalidade: "abertura"): string;
export function signCadenciaLink(payload: DescadastroLinkPayload, finalidade: "descadastro"): string;
export function signCadenciaLink(payload: CadenciaLinkPayload | DescadastroLinkPayload, finalidade: FinalidadeDoLink): string {
  const body = Buffer.from(JSON.stringify({ ...payload, finalidade })).toString("base64url");
  const sig = assinatura(body, finalidade);
  if (!sig) throw new Error("cadencia_link_secret_missing");
  return `${body}.${sig.toString("base64url")}`;
}

export function verifyCadenciaLink(token: string, finalidade: "abertura"): CadenciaLinkPayload | null;
export function verifyCadenciaLink(token: string, finalidade: "descadastro"): DescadastroLinkPayload | null;
export function verifyCadenciaLink(token: string, finalidade: FinalidadeDoLink): CadenciaLinkPayload | DescadastroLinkPayload | null {
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
    const conteudo: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (finalidade === "descadastro") {
      const descadastro = descadastroSchema.safeParse(conteudo);
      return descadastro.success ? { destinatario_id: descadastro.data.destinatario_id } : null;
    }
    const parsed = aberturaSchema.safeParse(conteudo);
    if (!parsed.success) return null;
    const { finalidade: _finalidade, ...payload } = parsed.data;
    return payload;
  } catch { return null; }
}
