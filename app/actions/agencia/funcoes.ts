"use server";

import { revalidatePath } from "next/cache";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { funcaoSchema, primeiroErro, type EntradaDaFuncao } from "@/lib/agencia/schemas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Criar ou editar uma função da equipe (docs/agencia/SPEC-equipe.md › Funções).
 * Nunca apaga: desativar é `ativa = false` — tarefas antigas seguem apontando.
 */
export async function salvarFuncao(entrada: EntradaDaFuncao): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    const p = funcaoSchema.safeParse(entrada);
    if (!p.success) return { ok: false, erro: primeiroErro(p.error) };
    const { id, nome, cor, permissoes, ativa } = p.data;
    const db = createAdminClient();

    if (id) {
      const { error } = await db
        .from("agencia_funcoes")
        .update({ nome, cor, permissoes, ativa, atualizada_em: new Date().toISOString() })
        .eq("id", id);
      if (error) return falha(error);
      await auditarAgencia("agencia.funcao_alterada", ctx.user.id, { tipo: "agencia_funcao", id }, { nome, permissoes, ativa });
    } else {
      const { data: ultima } = await db
        .from("agencia_funcoes")
        .select("ordem")
        .order("ordem", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data, error } = await db
        .from("agencia_funcoes")
        .insert({ nome, cor, permissoes, ativa, ordem: ((ultima as { ordem?: number } | null)?.ordem ?? 0) + 1 })
        .select("id")
        .single();
      if (error) return falha(error);
      await auditarAgencia("agencia.funcao_criada", ctx.user.id, { tipo: "agencia_funcao", id: (data as { id: string }).id }, { nome, permissoes });
    }

    revalidatePath("/agencia/equipe", "layout");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

function falha(error: { code?: string; message: string }): { ok: false; erro: string } {
  if (error.code === "23505") return { ok: false, erro: "Já existe uma função com esse nome." };
  logger.error("agência: falha ao salvar função", { codigo: error.code, detalhe: error.message });
  return { ok: false, erro: "Não deu para salvar. Tente de novo." };
}
