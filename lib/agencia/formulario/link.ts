/**
 * O link do formulário de acesso (docs/agencia/SPEC-cofre-e-formulario.md, F2):
 * mesmo desenho do convite — o token em claro só existe no link, o banco guarda
 * o SHA-256, vale 72 h, e a regra de validade é pura.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { gerarTokenDeConvite, hashDoToken, tokenTemFormatoValido } from "../convite";
import { respostasSchema, type Respostas } from "./perguntas";

export const VALIDADE_DO_FORMULARIO_MS = 72 * 60 * 60 * 1000;

export type SituacaoDoLink = "valido" | "enviado" | "cancelado" | "expirado" | "inexistente";

export function situacaoDoLink(
  linha: { situacao: string; expira_em: string } | null,
  agora: Date,
): SituacaoDoLink {
  if (!linha) return "inexistente";
  if (linha.situacao === "enviado") return "enviado";
  if (linha.situacao === "cancelado") return "cancelado";
  if (new Date(linha.expira_em).getTime() <= agora.getTime()) return "expirado";
  return "valido";
}

export const FRASE_DO_LINK: Record<Exclude<SituacaoDoLink, "valido">, string> = {
  enviado: "Este formulário já foi enviado. Obrigado! Se precisar corrigir algo, fale com a agência.",
  cancelado: "Este link foi substituído por um mais novo. Peça o link atualizado à agência.",
  expirado: "Este link venceu (vale 72 horas). Peça um novo à agência.",
  inexistente: "Link inválido. Confira se copiou o endereço inteiro.",
};

export function novoToken(): { token: string; hash: string } {
  return gerarTokenDeConvite();
}

export function linkDoFormulario(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/agencia/formulario/${token}`;
}

export interface FormularioAberto {
  id: string;
  clienteId: string;
  clienteNome: string;
  situacao: SituacaoDoLink;
  expiraEm: string;
  rascunho: Respostas | null;
}

/** Lê o formulário pelo token do link. Token com formato errado nem vai ao banco. */
export async function lerFormularioPorToken(token: string): Promise<FormularioAberto | null> {
  if (!tokenTemFormatoValido(token)) return null;
  const { data } = await createAdminClient()
    .from("agencia_formularios")
    .select("id, cliente_id, situacao, expira_em, rascunho, agencia_clientes(nome)")
    .eq("token_hash", hashDoToken(token))
    .maybeSingle();
  const l = data as {
    id: string;
    cliente_id: string;
    situacao: string;
    expira_em: string;
    rascunho: unknown;
    agencia_clientes: { nome: string } | null;
  } | null;
  if (!l) return null;
  const r = respostasSchema.safeParse(l.rascunho ?? {});
  return {
    id: l.id,
    clienteId: l.cliente_id,
    clienteNome: l.agencia_clientes?.nome ?? "",
    situacao: situacaoDoLink(l, new Date()),
    expiraEm: l.expira_em,
    rascunho: r.success && Object.keys((l.rascunho as object) ?? {}).length ? r.data : null,
  };
}
