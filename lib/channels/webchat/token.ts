/**
 * Token de visitante do chat no site: base64url(JSON {v:1, cs, vis, iat, exp}) + "." +
 * HMAC-SHA256 em base64url. A chave sai de `INTERNAL_SECRET` com o prefixo de domínio
 * `webchat-visitante:v1:`, no mesmo molde de `lib/cadencias/token.ts`.
 * Trocar o segredo invalida todos os tokens. Ler nunca lança: devolve `{ ok: false, motivo }`.
 * `agora` é sempre injetado; nada aqui lê o relógio.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const DIA_EM_MS = 24 * 60 * 60 * 1000;
const VALIDADE_EM_MS = 30 * DIA_EM_MS;
const RENOVAR_QUANDO_FALTAR_MS = 7 * DIA_EM_MS;
const PREFIXO_DE_DOMINIO = "webchat-visitante:v1:";
const TAMANHO_MAXIMO = 4096;

export interface AssinarTokenDeVisitanteParams {
  channelSessionId: string;
  visitanteId: string;
  agora: Date;
}

export type MotivoDeFalhaDoToken = "formato" | "assinatura" | "vencido" | "segredo_ausente";

export type LeituraDoTokenDeVisitante =
  | {
      ok: true;
      channelSessionId: string;
      visitanteId: string;
      expiraEm: Date;
      renovar: boolean;
    }
  | { ok: false; motivo: MotivoDeFalhaDoToken };

const corpoSchema = z
  .object({
    v: z.literal(1),
    cs: z.string().uuid(),
    vis: z.string().uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

function assinatura(corpo: string): Buffer | null {
  const segredo = process.env.INTERNAL_SECRET;
  if (!segredo?.trim()) return null;
  return createHmac("sha256", segredo).update(`${PREFIXO_DE_DOMINIO}${corpo}`).digest();
}

export function assinarTokenDeVisitante(p: AssinarTokenDeVisitanteParams): string {
  const emitidoEm = p.agora.getTime();
  const corpo = Buffer.from(
    JSON.stringify({
      v: 1,
      cs: p.channelSessionId,
      vis: p.visitanteId,
      iat: emitidoEm,
      exp: emitidoEm + VALIDADE_EM_MS,
    }),
  ).toString("base64url");
  const sig = assinatura(corpo);
  if (!sig) throw new Error("webchat_token_secret_missing");
  return `${corpo}.${sig.toString("base64url")}`;
}

export function lerTokenDeVisitante(token: string, agora: Date): LeituraDoTokenDeVisitante {
  try {
    if (!process.env.INTERNAL_SECRET?.trim()) return { ok: false, motivo: "segredo_ausente" };
    if (typeof token !== "string" || token.length === 0 || token.length > TAMANHO_MAXIMO) {
      return { ok: false, motivo: "formato" };
    }
    const partes = token.split(".");
    if (partes.length !== 2) return { ok: false, motivo: "formato" };
    const [corpo, enviada] = partes;
    if (!corpo || !enviada) return { ok: false, motivo: "formato" };

    const esperada = assinatura(corpo);
    if (!esperada) return { ok: false, motivo: "segredo_ausente" };
    const recebida = Buffer.from(enviada, "base64url");
    if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) {
      return { ok: false, motivo: "assinatura" };
    }

    const conteudo: unknown = JSON.parse(Buffer.from(corpo, "base64url").toString("utf8"));
    const parsed = corpoSchema.safeParse(conteudo);
    if (!parsed.success) return { ok: false, motivo: "formato" };

    const { cs, vis, exp } = parsed.data;
    const faltam = exp - agora.getTime();
    if (faltam <= 0) return { ok: false, motivo: "vencido" };

    return {
      ok: true,
      channelSessionId: cs,
      visitanteId: vis,
      expiraEm: new Date(exp),
      renovar: faltam < RENOVAR_QUANDO_FALTAR_MS,
    };
  } catch {
    return { ok: false, motivo: "formato" };
  }
}
