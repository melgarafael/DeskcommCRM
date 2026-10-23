"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { contextoDaAgencia } from "@/lib/agencia/acesso";
import { auditarAgencia, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { normalizarWhatsapp } from "@/lib/agencia/convite";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O próprio perfil na área da agência (SPEC-avisos › `/agencia/perfil`).
 * Só mexe na linha do PRÓPRIO usuário — o id vem do `getUser()`, nunca da tela.
 */

const perfilSchema = z.object({
  nome: z.string().trim().min(2, "Informe o nome.").max(80),
  whatsapp: z.string().trim(),
  recebeWhatsapp: z.boolean(),
});

export async function salvarMeuPerfil(entrada: z.input<typeof perfilSchema>): Promise<ResultadoDaAcao> {
  const { decisao, user } = await contextoDaAgencia();
  if (decisao.tipo !== "liberado" || !user) return { ok: false, erro: "Seu acesso à área da agência não está ativo." };
  const p = perfilSchema.safeParse(entrada);
  if (!p.success) return { ok: false, erro: p.error.issues[0]?.message ?? "Dados inválidos." };
  const whatsapp = normalizarWhatsapp(p.data.whatsapp);
  if (!whatsapp) return { ok: false, erro: "WhatsApp inválido. Use DDD + número." };

  const db = createAdminClient();
  const { data: atual } = await db.from("agencia_membros").select("id").eq("user_id", user.id).maybeSingle();
  const id = (atual as { id?: string } | null)?.id;

  if (id) {
    const { error } = await db
      .from("agencia_membros")
      .update({ nome: p.data.nome, whatsapp, recebe_whatsapp: p.data.recebeWhatsapp })
      .eq("id", id);
    if (error) return { ok: false, erro: "Não deu para salvar. Tente de novo." };
    await auditarAgencia("agencia.membro_alterado", user.id, { tipo: "agencia_membro", id }, { proprio_perfil: true });
  } else {
    // Só o DONO chega aqui sem linha de membro: o guarda liberou e não há
    // membro. A linha nasce ativa e ligada ao próprio usuário, para ele
    // receber avisos (sininho e WhatsApp) como qualquer membro.
    if (!decisao.ehDono) return { ok: false, erro: "Seu acesso à área da agência não está ativo." };
    const { data, error } = await db
      .from("agencia_membros")
      .insert({
        user_id: user.id,
        nome: p.data.nome,
        email: user.email ?? `${user.id}@sem-email.invalid`,
        whatsapp,
        recebe_whatsapp: p.data.recebeWhatsapp,
        ve_todos_clientes: true,
        situacao: "ativo",
        ativado_em: new Date().toISOString(),
        criado_por: user.id,
      })
      .select("id")
      .single();
    if (error) {
      logger.error("agência: perfil do dono não gravou", { codigo: error.code, detalhe: error.message });
      return { ok: false, erro: error.code === "23505" ? "Já existe um membro com o seu e-mail." : "Não deu para salvar." };
    }
    await auditarAgencia("agencia.membro_ativado", user.id, { tipo: "agencia_membro", id: (data as { id: string }).id }, {
      proprio_perfil: true,
    });
  }
  revalidatePath("/agencia", "layout");
  return { ok: true };
}
