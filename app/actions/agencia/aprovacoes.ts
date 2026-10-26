"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { avisarClienteDaAprovacao, ligarAprovacoesNaOrganizacao } from "@/lib/agencia/aprovacoes/servico";
import { TIPOS_DE_APROVACAO } from "@/lib/agencia/aprovacoes/vocabulario";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Pedir aprovação ao cliente (docs/agencia/SPEC-aprovacoes.md) — do lado da
 * agência. Quem cria tarefa pode pedir aprovação do que fez, para os clientes
 * que atende.
 */

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

const pedidoSchema = z
  .object({
    clienteId: z.string().uuid(),
    tipo: z.enum(TIPOS_DE_APROVACAO),
    titulo: z.string().trim().min(2, "Dê um título ao que vai para aprovação.").max(200),
    descricao: z.string().trim().max(4000).nullable(),
    link: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .refine((v) => !v || /^https:\/\//i.test(v), "O link precisa começar com https://."),
    arquivoId: z.string().uuid().nullable(),
    tarefaId: z.string().uuid().nullable(),
    origemId: z.string().uuid().nullable(),
  })
  .refine((p) => !!p.link || !!p.arquivoId, "Cole o link ou escolha um arquivo do acervo.");
export type PedidoDeAprovacao = z.input<typeof pedidoSchema>;

export async function pedirAprovacao(entrada: PedidoDeAprovacao): Promise<ResultadoDaAcao<{ id: string; aviso: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    const p = pedidoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    if (!podeVerCliente(await carregarAlcance(ctx), d.clienteId)) return { ok: false as const, erro: "Você não atende esse cliente." };
    const db = createAdminClient();
    const { data: cliente } = await db.from("agencia_clientes").select("organization_id").eq("id", d.clienteId).maybeSingle();
    const organizationId = (cliente as { organization_id?: string | null } | null)?.organization_id;
    if (!organizationId) return { ok: false as const, erro: "Ligue o cliente a uma organização do CRM primeiro (ficha › Dados)." };

    // Link do arquivo do acervo, quando escolhido: tem de ser deste cliente.
    let link = d.link;
    if (d.arquivoId) {
      const { data: arq } = await db.from("agencia_arquivos").select("link, cliente_id").eq("id", d.arquivoId).maybeSingle();
      const a = arq as { link: string; cliente_id: string | null } | null;
      if (!a || a.cliente_id !== d.clienteId) return { ok: false as const, erro: "Arquivo não encontrado no acervo deste cliente." };
      link = link ?? a.link;
    }
    if (d.tarefaId) {
      const { data: t } = await db.from("agencia_tarefas").select("cliente_id").eq("id", d.tarefaId).maybeSingle();
      if ((t as { cliente_id?: string | null } | null)?.cliente_id !== d.clienteId) return { ok: false as const, erro: "A tarefa não é deste cliente." };
    }
    let versao = 1;
    if (d.origemId) {
      const { data: o } = await db.from("agencia_aprovacoes").select("versao, cliente_id").eq("id", d.origemId).maybeSingle();
      const origem = o as { versao: number; cliente_id: string } | null;
      if (!origem || origem.cliente_id !== d.clienteId) return { ok: false as const, erro: "Versão anterior não encontrada." };
      versao = Math.min(origem.versao + 1, 99);
    }

    const { data, error } = await db
      .from("agencia_aprovacoes")
      .insert({
        organization_id: organizationId,
        cliente_id: d.clienteId,
        tipo: d.tipo,
        titulo: d.titulo,
        descricao: d.descricao || null,
        link,
        arquivo_id: d.arquivoId,
        tarefa_id: d.tarefaId,
        versao,
        origem_id: d.origemId,
        pedido_por: ctx.user.id,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false as const, erro: "Não deu para pedir a aprovação." };
    const id = (data as { id: string }).id;

    await ligarAprovacoesNaOrganizacao(organizationId);
    // A tarefa ligada fica em Revisão enquanto o cliente olha.
    if (d.tarefaId) {
      await db.from("agencia_tarefas").update({ coluna: "revisao", concluida_em: null, atualizada_em: new Date().toISOString() }).eq("id", d.tarefaId).neq("coluna", "concluido");
    }
    const destino = await avisarClienteDaAprovacao({ aprovacaoId: id, clienteId: d.clienteId, tipo: d.tipo, titulo: d.titulo, versao }).catch(() => "sem_whatsapp" as const);
    await auditarAgencia("agencia.aprovacao_pedida", ctx.user.id, { tipo: "agencia_aprovacao", id }, { tipo: d.tipo, versao, aviso: destino });
    revalidatePath(`/agencia/clientes/${d.clienteId}`);
    const aviso = {
      grupo: "O grupo do cliente foi avisado.",
      responsavel: "O responsável foi avisado no WhatsApp.",
      sem_destino: "O cadastro não tem WhatsApp do cliente nem grupo: avise você.",
      sem_whatsapp: "O WhatsApp da agência não está configurado: avise você.",
    }[destino];
    return { ok: true as const, dados: { id, aviso } };
  });
}

export async function cancelarAprovacao(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    if (!idSchema.safeParse(id).success) return { ok: false as const, erro: "Aprovação inválida." };
    const db = createAdminClient();
    const { data } = await db.from("agencia_aprovacoes").select("cliente_id").eq("id", id).maybeSingle();
    const clienteId = (data as { cliente_id?: string } | null)?.cliente_id;
    if (!clienteId || !podeVerCliente(await carregarAlcance(ctx), clienteId)) return { ok: false as const, erro: "Aprovação não encontrada." };
    await db.from("agencia_aprovacoes").update({ situacao: "cancelado" }).eq("id", id).eq("situacao", "pendente");
    await auditarAgencia("agencia.aprovacao_cancelada", ctx.user.id, { tipo: "agencia_aprovacao", id });
    revalidatePath(`/agencia/clientes/${clienteId}`);
    return { ok: true as const };
  });
}
