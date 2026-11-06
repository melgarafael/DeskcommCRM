/**
 * O ESTADO da conexão por um clique — o que vai ao provedor na ida e volta na URL.
 *
 * A volta da página de cadastro chega por navegação de outro site: o cookie de
 * sessão (Strict) não viaja, e a URL é a única coisa que liga a volta à ida.
 * Por isso a ida assina organização, pessoa e perfil do provedor, e a volta só
 * é concluída quando a assinatura confere, o prazo não venceu e a organização
 * é a da sessão que concluiu.
 *
 * O estado sozinho NÃO prova a conta: quem prova é o provedor, listando a conta
 * no perfil assinado aqui (`contaConectadaNoPerfil`). O estado prova a outra
 * metade — que o perfil é o desta organização, e não um que alguém colou.
 *
 * Mesmo formato de `lib/agenda/google/estado.ts` (carga em base64url + HMAC
 * SHA-256 em hex, comparado em tempo constante), com o perfil na carga. Segredo
 * injetado: quem chama passa `env.INTERNAL_SECRET`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** A página da Meta pode pedir QR no celular e conferência de dados: meia hora. */
export const VALIDADE_DO_ESTADO_MS = 30 * 60 * 1000;

export interface EstadoDaVolta {
  organizationId: string;
  userId: string;
  profileId: string;
  expiraEmMs: number;
}

/** O que cabe num segmento de URL sem escape: é o que a rota de volta aceita. */
export const FORMATO_DO_ESTADO = /^[A-Za-z0-9_-]{20,600}\.[0-9a-f]{64}$/;

function segredoValido(segredo: string): string {
  const s = segredo?.trim() ?? "";
  if (s.length < 16)
    throw new Error(
      "INTERNAL_SECRET ausente ou curto demais: a volta da conexão não teria como ser verificada",
    );
  return s;
}

function assinar(carga: string, segredo: string): Buffer {
  return createHmac("sha256", segredo).update(carga, "utf8").digest();
}

export function emitirEstadoDaVolta(
  dados: { organizationId: string; userId: string; profileId: string },
  opcoes: { segredo: string; agora: Date; validadeMs?: number },
): string {
  const segredo = segredoValido(opcoes.segredo);
  const campos = [dados.organizationId, dados.userId, dados.profileId].map((c) => c?.trim() ?? "");
  // O ponto separa a carga: um campo com ponto partiria em dois na volta.
  if (campos.some((c) => !c || c.includes(".")))
    throw new Error("estado da volta com campo vazio ou com ponto");
  const nonce = randomBytes(8).toString("hex");
  const expira = opcoes.agora.getTime() + (opcoes.validadeMs ?? VALIDADE_DO_ESTADO_MS);
  const carga = [...campos, nonce, String(expira)].join(".");
  return `${Buffer.from(carga, "utf8").toString("base64url")}.${assinar(carga, segredo).toString("hex")}`;
}

/** `null` para tudo o que não for um estado nosso, íntegro e no prazo. Nunca lança por entrada ruim. */
export function verificarEstadoDaVolta(
  token: string | null | undefined,
  opcoes: { segredo: string; agora: Date },
): EstadoDaVolta | null {
  if (!token || !FORMATO_DO_ESTADO.test(token)) return null;
  const segredo = segredoValido(opcoes.segredo);
  const [codificada = "", assinaturaHex = ""] = token.split(".");
  const carga = Buffer.from(codificada, "base64url").toString("utf8");
  const esperada = assinar(carga, segredo);
  const recebida = Buffer.from(assinaturaHex, "hex");
  if (recebida.length !== esperada.length || !timingSafeEqual(recebida, esperada)) return null;
  const campos = carga.split(".");
  if (campos.length !== 5) return null;
  const [organizationId = "", userId = "", profileId = "", , expiraTexto = ""] = campos;
  const expiraEmMs = Number(expiraTexto);
  if (!Number.isFinite(expiraEmMs) || expiraEmMs <= opcoes.agora.getTime()) return null;
  return { organizationId, userId, profileId, expiraEmMs };
}
