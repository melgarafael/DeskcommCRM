"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { enfileirarWhatsappDaAgencia } from "@/lib/agencia/whatsapp/enfileirar";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";

const horario = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário inválido.");

const configSchema = z.object({
  canalId: z.string().uuid().nullable(),
  janelaInicio: horario,
  janelaFim: horario,
});

/**
 * Qual canal é o WhatsApp da agência e o horário dos avisos
 * (SPEC-whatsapp-agencia › Tela). A organização dona do canal é LIDA do banco
 * pelo id do canal — nunca aceita do formulário.
 */
export async function salvarWhatsappDaAgencia(entrada: z.input<typeof configSchema>): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    const p = configSchema.safeParse(entrada);
    if (!p.success) return { ok: false, erro: p.error.issues[0]?.message ?? "Dados inválidos." };
    const db = createAdminClient();

    let organizationId: string | null = null;
    if (p.data.canalId) {
      const { data } = await db
        .from("channel_sessions")
        .select("organization_id, archived_at")
        .eq("id", p.data.canalId)
        .maybeSingle();
      const canal = data as { organization_id: string; archived_at: string | null } | null;
      if (!canal || canal.archived_at) return { ok: false, erro: "Esse WhatsApp não está mais conectado." };
      organizationId = canal.organization_id;
    }

    const { error } = await db
      .from("agencia_config")
      .update({
        canal_organization_id: organizationId,
        canal_session_id: p.data.canalId,
        janela_inicio: p.data.janelaInicio,
        janela_fim: p.data.janelaFim,
        atualizado_em: new Date().toISOString(),
        atualizado_por: ctx.user.id,
      })
      .eq("id", true);
    if (error) return { ok: false, erro: "Não deu para salvar. Tente de novo." };
    await auditarAgencia("agencia.whatsapp_configurado", ctx.user.id, null, {
      canal_id: p.data.canalId,
      janela: `${p.data.janelaInicio}-${p.data.janelaFim}`,
    });
    revalidatePath("/agencia/configuracoes");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

/**
 * Mensagem de teste para o WhatsApp de quem clicou. Precisa ter um número
 * cadastrado no perfil — o dono cadastra o seu em Perfil.
 */
export async function enviarTesteDoWhatsapp(): Promise<ResultadoDaAcao> {
  try {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    const { data } = await createAdminClient()
      .from("agencia_membros")
      .select("whatsapp")
      .eq("user_id", ctx.user.id)
      .maybeSingle();
    const whatsapp = (data as { whatsapp?: string } | null)?.whatsapp;
    if (!whatsapp) return { ok: false, erro: "Cadastre seu WhatsApp em Perfil para receber o teste." };
    const marca = await marcaDaSaida(null);
    const r = await enfileirarWhatsappDaAgencia({
      motivo: "teste",
      referenciaId: null,
      telefone: whatsapp,
      corpo: `✅ Teste do WhatsApp da ${marca.nome}. Se chegou, os avisos da equipe vão sair por este número.`,
    });
    if (!r.enfileirado) {
      return {
        ok: false,
        erro: r.motivo === "sem_configuracao" ? "Escolha e salve o WhatsApp da agência primeiro." : "Não deu para enfileirar o teste.",
      };
    }
    await auditarAgencia("agencia.whatsapp_teste_enviado", ctx.user.id, null, { via: "configuracoes" });
    revalidatePath("/agencia/configuracoes");
    return { ok: true };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}
