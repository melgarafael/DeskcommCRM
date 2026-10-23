"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { criarAviso } from "@/lib/agencia/avisos/criar";
import { idSchema } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/** "Enviar aviso de teste" na lista da equipe (SPEC-avisos › Tela). */
export async function enviarAvisoDeTeste(membroId: string): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("equipe.gerenciar");
    if (!idSchema.safeParse(membroId).success) return { ok: false, erro: "Membro inválido." };
    const n = await criarAviso({
      alvo: { tipo: "membros", ids: [membroId] },
      tipo: "teste",
      titulo: "Aviso de teste",
      corpo: "Se você recebeu isto, os avisos da agência estão chegando.",
      link: "/agencia",
    });
    if (n === 0) return { ok: false, erro: "Este membro não está ativo." };
    await auditarAgencia("agencia.whatsapp_teste_enviado", ctx.user.id, { tipo: "agencia_membro", id: membroId }, { via: "aviso" });
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

const antecedenciaSchema = z
  .array(z.number().int().min(1).max(7))
  .max(7)
  .transform((dias) => [...new Set(dias)].sort((a, b) => b - a));

/** A antecedência dos avisos de prazo, igual para a equipe toda (A3). */
export async function salvarAntecedencia(dias: number[]): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    const p = antecedenciaSchema.safeParse(dias);
    if (!p.success) return { ok: false, erro: "Escolha dias entre 1 e 7." };
    const { error } = await createAdminClient()
      .from("agencia_config")
      .update({ avisos_antecedencia: p.data, atualizado_em: new Date().toISOString(), atualizado_por: ctx.user.id })
      .eq("id", true);
    if (error) return { ok: false, erro: "Não deu para salvar. Tente de novo." };
    await auditarAgencia("agencia.avisos_configurados", ctx.user.id, null, { antecedencia: p.data });
    revalidatePath("/agencia/configuracoes");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}
