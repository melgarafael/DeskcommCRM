/**
 * O convite de membro da equipe (docs/agencia/SPEC-equipe.md › Convite).
 *
 * O token em claro só existe no link: o banco guarda o SHA-256. Vazar a tabela
 * não entrega convite nenhum, e o token não aparece em log.
 *
 * As regras de validade são puras (`situacaoDoConvite`), testadas sem banco.
 */
import { createHash, randomBytes } from "node:crypto";

/** Quanto tempo o link vale. */
export const VALIDADE_DO_CONVITE_MS = 7 * 24 * 60 * 60 * 1000;

export function gerarTokenDeConvite(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDoToken(token) };
}

export function hashDoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** O formato que `gerarTokenDeConvite` produz: 32 bytes em base64url = 43 caracteres. */
export function tokenTemFormatoValido(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export interface LinhaDoConvite {
  expira_em: string;
  aceito_em: string | null;
  revogado_em: string | null;
}

export type SituacaoDoConvite = "valido" | "inexistente" | "expirado" | "aceito" | "revogado";

export function situacaoDoConvite(linha: LinhaDoConvite | null, agora: Date): SituacaoDoConvite {
  if (!linha) return "inexistente";
  if (linha.revogado_em) return "revogado";
  if (linha.aceito_em) return "aceito";
  if (new Date(linha.expira_em).getTime() <= agora.getTime()) return "expirado";
  return "valido";
}

export const FRASE_DA_SITUACAO: Record<Exclude<SituacaoDoConvite, "valido">, string> = {
  inexistente: "Este convite não existe. Confira o link ou peça um novo.",
  expirado: "Este convite expirou. Peça um novo a quem administra a agência.",
  aceito: "Este convite já foi usado. Entre com o seu e-mail e senha.",
  revogado: "Este convite foi cancelado. Peça um novo a quem administra a agência.",
};

/** O link que vai no WhatsApp e na tela. `base` é a URL pública da instalação. */
export function linkDoConvite(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/agencia/convite/${token}`;
}

/** E-mails comparados como o Supabase Auth compara: sem caixa e sem espaço. */
export function mesmoEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Normaliza um WhatsApp brasileiro digitado de qualquer jeito para E.164.
 * Aceita "(11) 91234-5678", "11912345678", "+55 11 91234-5678", "5511912345678".
 * Número de fora do Brasil precisa vir com "+" e o código do país.
 */
export function normalizarWhatsapp(entrada: string): string | null {
  const bruto = entrada.trim();
  const digitos = bruto.replace(/\D/g, "");
  if (bruto.startsWith("+")) {
    return /^[1-9]\d{7,14}$/.test(digitos) ? `+${digitos}` : null;
  }
  if (/^55\d{10,11}$/.test(digitos)) return `+${digitos}`;
  if (/^\d{10,11}$/.test(digitos)) return `+55${digitos}`;
  return null;
}
