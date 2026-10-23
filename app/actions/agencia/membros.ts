"use server";

import { revalidatePath } from "next/cache";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { gerarTokenDeConvite, linkDoConvite, VALIDADE_DO_CONVITE_MS } from "@/lib/agencia/convite";
import { enviarConvitePeloWhatsapp } from "@/lib/agencia/whatsapp/convite";
import {
  edicaoDeMembroSchema,
  idSchema,
  membroSchema,
  primeiroErro,
  type EntradaDaEdicaoDeMembro,
  type EntradaDoMembro,
} from "@/lib/agencia/schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Membros da equipe (docs/agencia/SPEC-equipe.md › Convite). Toda action começa
 * por `exigirPermissao("equipe.gerenciar")` — a tela esconde o botão, mas é aqui
 * que a recusa vale.
 */

export interface ConviteEmitido {
  link: string;
  /** `true` quando o link também saiu pelo WhatsApp da agência. */
  enviadoPeloWhatsapp: boolean;
}

async function emitirConvite(membroId: string, autor: string, nome: string, whatsapp: string): Promise<ConviteEmitido> {
  const db = createAdminClient();
  const { token, hash } = gerarTokenDeConvite();
  // Um convite vivo por membro: emitir um novo revoga os anteriores.
  await db
    .from("agencia_convites")
    .update({ revogado_em: new Date().toISOString() })
    .eq("membro_id", membroId)
    .is("aceito_em", null)
    .is("revogado_em", null);
  const { data, error } = await db
    .from("agencia_convites")
    .insert({
      membro_id: membroId,
      token_hash: hash,
      expira_em: new Date(Date.now() + VALIDADE_DO_CONVITE_MS).toISOString(),
      criado_por: autor,
    })
    .select("id")
    .single();
  if (error) throw new Error(`convite: ${error.message}`);

  const link = linkDoConvite(env.NEXT_PUBLIC_APP_URL, token);
  const enviadoPeloWhatsapp = await enviarConvitePeloWhatsapp({
    conviteId: (data as { id: string }).id,
    nome,
    whatsapp,
    link,
  });
  return { link, enviadoPeloWhatsapp };
}

export async function convidarMembro(entrada: EntradaDoMembro): Promise<ResultadoDaAcao<ConviteEmitido>> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    const p = membroSchema.safeParse(entrada);
    if (!p.success) return { ok: false, erro: primeiroErro(p.error) };
    const { nome, email, whatsapp, funcoes, veTodosClientes } = p.data;
    const db = createAdminClient();

    const { data, error } = await db
      .from("agencia_membros")
      .insert({ nome, email, whatsapp, ve_todos_clientes: veTodosClientes, criado_por: ctx.user.id })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return { ok: false, erro: "Já existe um membro com esse e-mail." };
      logger.error("agência: falha ao cadastrar membro", { codigo: error.code, detalhe: error.message });
      return { ok: false, erro: "Não deu para cadastrar. Tente de novo." };
    }
    const membroId = (data as { id: string }).id;

    const erroFuncoes = await gravarFuncoes(membroId, funcoes);
    if (erroFuncoes) return { ok: false, erro: erroFuncoes };

    const convite = await emitirConvite(membroId, ctx.user.id, nome, whatsapp);
    await auditarAgencia("agencia.membro_convidado", ctx.user.id, { tipo: "agencia_membro", id: membroId }, {
      funcoes,
      ve_todos_clientes: veTodosClientes,
      pelo_whatsapp: convite.enviadoPeloWhatsapp,
    });
    revalidatePath("/agencia/equipe");
    return { ok: true, dados: convite };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

export async function editarMembro(entrada: EntradaDaEdicaoDeMembro): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    const p = edicaoDeMembroSchema.safeParse(entrada);
    if (!p.success) return { ok: false, erro: primeiroErro(p.error) };
    const { id, nome, whatsapp, funcoes, veTodosClientes } = p.data;
    const { error } = await createAdminClient()
      .from("agencia_membros")
      .update({ nome, whatsapp, ve_todos_clientes: veTodosClientes })
      .eq("id", id);
    if (error) {
      logger.error("agência: falha ao editar membro", { codigo: error.code, detalhe: error.message });
      return { ok: false, erro: "Não deu para salvar. Tente de novo." };
    }
    const erroFuncoes = await gravarFuncoes(id, funcoes);
    if (erroFuncoes) return { ok: false, erro: erroFuncoes };
    await auditarAgencia("agencia.membro_alterado", ctx.user.id, { tipo: "agencia_membro", id }, {
      funcoes,
      ve_todos_clientes: veTodosClientes,
    });
    revalidatePath("/agencia/equipe");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

/** Troca o conjunto de funções do membro pelo informado. */
async function gravarFuncoes(membroId: string, funcoes: string[]): Promise<string | null> {
  const db = createAdminClient();
  const { error: e1 } = await db.from("agencia_membros_funcoes").delete().eq("membro_id", membroId);
  if (e1) return "Não deu para gravar as funções.";
  const { error: e2 } = await db
    .from("agencia_membros_funcoes")
    .insert(funcoes.map((funcao_id) => ({ membro_id: membroId, funcao_id })));
  if (e2) {
    logger.error("agência: falha ao gravar funções do membro", { codigo: e2.code, detalhe: e2.message });
    return "Não deu para gravar as funções.";
  }
  return null;
}

export async function desativarMembro(id: string): Promise<ResultadoDaAcao> {
  return mudarSituacao(id, "desativado");
}

export async function reativarMembro(id: string): Promise<ResultadoDaAcao> {
  return mudarSituacao(id, "ativo");
}

async function mudarSituacao(id: string, situacao: "ativo" | "desativado"): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    if (!idSchema.safeParse(id).success) return { ok: false, erro: "Membro inválido." };
    const db = createAdminClient();
    const { data: atual } = await db.from("agencia_membros").select("user_id, situacao").eq("id", id).maybeSingle();
    const linha = atual as { user_id: string | null; situacao: string } | null;
    if (!linha) return { ok: false, erro: "Membro não encontrado." };
    // Reativar quem nunca aceitou o convite não dá acesso: volta a "convidado".
    const destino = situacao === "ativo" && !linha.user_id ? "convidado" : situacao;
    const { error } = await db
      .from("agencia_membros")
      .update({ situacao: destino, desativado_em: destino === "desativado" ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) return { ok: false, erro: "Não deu para salvar. Tente de novo." };
    await auditarAgencia(
      situacao === "desativado" ? "agencia.membro_desativado" : "agencia.membro_reativado",
      ctx.user.id,
      { tipo: "agencia_membro", id },
    );
    revalidatePath("/agencia/equipe");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

export async function reenviarConvite(id: string): Promise<ResultadoDaAcao<ConviteEmitido>> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    if (!idSchema.safeParse(id).success) return { ok: false, erro: "Membro inválido." };
    const { data } = await createAdminClient()
      .from("agencia_membros")
      .select("nome, whatsapp, situacao")
      .eq("id", id)
      .maybeSingle();
    const m = data as { nome: string; whatsapp: string; situacao: string } | null;
    if (!m) return { ok: false, erro: "Membro não encontrado." };
    if (m.situacao !== "convidado") return { ok: false, erro: "Este membro já aceitou o convite." };
    const convite = await emitirConvite(id, ctx.user.id, m.nome, m.whatsapp);
    await auditarAgencia("agencia.convite_reenviado", ctx.user.id, { tipo: "agencia_membro", id }, {
      pelo_whatsapp: convite.enviadoPeloWhatsapp,
    });
    revalidatePath("/agencia/equipe");
    return { ok: true, dados: convite };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

export async function revogarConvite(id: string): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    if (!idSchema.safeParse(id).success) return { ok: false, erro: "Membro inválido." };
    const { error } = await createAdminClient()
      .from("agencia_convites")
      .update({ revogado_em: new Date().toISOString() })
      .eq("membro_id", id)
      .is("aceito_em", null)
      .is("revogado_em", null);
    if (error) return { ok: false, erro: "Não deu para cancelar. Tente de novo." };
    await auditarAgencia("agencia.convite_revogado", ctx.user.id, { tipo: "agencia_membro", id });
    revalidatePath("/agencia/equipe");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}
