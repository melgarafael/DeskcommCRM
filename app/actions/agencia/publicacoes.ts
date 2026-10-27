"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { horaLocal, instanteDoDia } from "@/lib/agencia/calendario/regras";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { FORMATOS, REDES, mudouOConteudo, problemaParaAgendar, type Formato, type Rede, type SituacaoDaPublicacao } from "@/lib/agencia/publicacoes/regras";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

import { pedirAprovacao } from "./aprovacoes";

/** Calendário de publicações (docs/agencia/SPEC-publicacoes.md) — tudo com `publicacoes.gerenciar`. */

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

const CAMPOS = "id, cliente_id, titulo, rede, formato, quando, legenda, midia_url, situacao, auto_publicar";
interface Linha {
  id: string;
  cliente_id: string;
  titulo: string;
  rede: Rede;
  formato: Formato;
  quando: string;
  legenda: string | null;
  midia_url: string | null;
  situacao: SituacaoDaPublicacao;
  auto_publicar: boolean;
}

/** Lê a publicação e confere que a pessoa alcança o cliente dela. */
async function daPessoa(id: string) {
  const ctx = await exigirPermissao("publicacoes.gerenciar");
  if (!idSchema.safeParse(id).success) return { ctx, linha: null };
  const db = createAdminClient();
  const { data } = await db.from("agencia_publicacoes").select(CAMPOS).eq("id", id).maybeSingle();
  const linha = data as Linha | null;
  if (!linha || !podeVerCliente(await carregarAlcance(ctx), linha.cliente_id)) return { ctx, linha: null };
  return { ctx, linha };
}

const publicacaoSchema = z.object({
  id: z.string().uuid().nullable(),
  clienteId: z.string().uuid("Escolha o cliente."),
  titulo: z.string().trim().min(2, "Dê um nome à publicação.").max(200),
  rede: z.enum(REDES),
  formato: z.enum(FORMATOS),
  dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Escolha o dia."),
  hora: z.string().regex(/^\d{2}:\d{2}$/, "Escolha a hora."),
  legenda: z.string().trim().max(5000),
  midiaUrl: z
    .string()
    .trim()
    .max(2000)
    .refine((v) => !v || /^https:\/\//i.test(v), "O link da mídia precisa começar com https://."),
  responsavelId: z.string().uuid().nullable(),
});
export type EntradaDaPublicacao = z.input<typeof publicacaoSchema>;

export async function salvarPublicacao(entrada: EntradaDaPublicacao): Promise<ResultadoDaAcao<{ id: string; aviso: string | null }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("publicacoes.gerenciar");
    const p = publicacaoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    if (!podeVerCliente(await carregarAlcance(ctx), d.clienteId)) return { ok: false as const, erro: "Você não atende esse cliente." };
    const db = createAdminClient();
    const agora = new Date().toISOString();
    const campos = {
      cliente_id: d.clienteId,
      titulo: d.titulo,
      rede: d.rede,
      formato: d.formato,
      quando: instanteDoDia(d.dia, d.hora).toISOString(),
      legenda: d.legenda || null,
      midia_url: d.midiaUrl || null,
      responsavel_id: d.responsavelId,
      atualizado_em: agora,
    };

    if (!d.id) {
      const { data, error } = await db.from("agencia_publicacoes").insert({ ...campos, criado_por: ctx.user.id }).select("id").single();
      if (error || !data) return { ok: false as const, erro: "Não deu para salvar a publicação." };
      const id = (data as { id: string }).id;
      await auditarAgencia("agencia.publicacao_salva", ctx.user.id, { tipo: "agencia_publicacao", id }, { nova: true });
      revalidatePath("/agencia/publicacoes");
      return { ok: true as const, dados: { id, aviso: null } };
    }

    const { linha } = await daPessoa(d.id);
    if (!linha || linha.cliente_id !== d.clienteId) return { ok: false as const, erro: "Publicação não encontrada." };
    if (linha.situacao === "publicada" || linha.situacao === "publicando") return { ok: false as const, erro: "Publicação que já foi ao ar não muda mais." };

    // Mudou o que o cliente aprovou → aprovar de novo. Mudou só a data de uma agendada → agendar de novo.
    let situacao: SituacaoDaPublicacao = linha.situacao;
    let aviso: string | null = null;
    const conteudo = mudouOConteudo(
      { legenda: linha.legenda, midiaUrl: linha.midia_url, formato: linha.formato, rede: linha.rede },
      { legenda: campos.legenda, midiaUrl: campos.midia_url, formato: d.formato, rede: d.rede },
    );
    if (conteudo && ["em_aprovacao", "aprovada", "agendada", "falhou"].includes(situacao)) {
      situacao = "rascunho";
      aviso = "O conteúdo mudou: a publicação voltou para rascunho e precisa ser aprovada de novo.";
      await db.from("agencia_aprovacoes").update({ situacao: "cancelado" }).eq("publicacao_id", linha.id).eq("situacao", "pendente");
    } else if (situacao === "agendada" && campos.quando !== new Date(linha.quando).toISOString()) {
      situacao = "aprovada";
      aviso = "A data mudou: agende de novo.";
    }
    const { error } = await db
      .from("agencia_publicacoes")
      .update({ ...campos, situacao, ...(situacao !== linha.situacao ? { auto_publicar: false } : {}) })
      .eq("id", linha.id)
      .not("situacao", "in", "(publicada,publicando)");
    if (error) return { ok: false as const, erro: "Não deu para salvar a publicação." };
    await auditarAgencia("agencia.publicacao_salva", ctx.user.id, { tipo: "agencia_publicacao", id: linha.id }, { situacao });
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const, dados: { id: linha.id, aviso } };
  });
}

/** P3: manda para o cliente aprovar pela porta da Fase 7 (que também pede `tarefas.criar`). */
export async function pedirAprovacaoDaPublicacao(id: string): Promise<ResultadoDaAcao<{ aviso: string }>> {
  return seguro(async () => {
    const { linha } = await daPessoa(id);
    if (!linha) return { ok: false as const, erro: "Publicação não encontrada." };
    if (linha.situacao !== "rascunho" && linha.situacao !== "falhou") return { ok: false as const, erro: "Só rascunho vai para aprovação." };
    if (!linha.midia_url) return { ok: false as const, erro: "Cole o link da mídia antes de pedir a aprovação." };
    const video = linha.formato === "reels" || linha.formato === "video";
    const r = await pedirAprovacao({
      clienteId: linha.cliente_id,
      tipo: video ? "video" : "arte",
      titulo: linha.titulo,
      descricao: linha.legenda ? `Legenda:\n${linha.legenda}` : null,
      link: linha.midia_url,
      arquivoId: null,
      tarefaId: null,
      origemId: null,
    });
    if (!r.ok) return r;
    const db = createAdminClient();
    await db.from("agencia_aprovacoes").update({ publicacao_id: linha.id }).eq("id", r.dados.id);
    await db.from("agencia_publicacoes").update({ situacao: "em_aprovacao", comentario: null, erro: null, auto_publicar: false, atualizado_em: new Date().toISOString() }).eq("id", linha.id);
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const, dados: { aviso: r.dados.aviso } };
  });
}

/** P5: agenda a aprovada — com ou sem "publicar sozinho". */
export async function agendarPublicacao(id: string, autoPublicar: boolean): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const { ctx, linha } = await daPessoa(id);
    if (!linha) return { ok: false as const, erro: "Publicação não encontrada." };
    const problema = problemaParaAgendar(
      { situacao: linha.situacao, rede: linha.rede, formato: linha.formato, quando: linha.quando, midiaUrl: linha.midia_url, autoPublicar },
      new Date(),
    );
    if (problema) return { ok: false as const, erro: problema };
    if (autoPublicar) {
      const db = createAdminClient();
      const { data: c } = await db.from("agencia_clientes").select("organization_id").eq("id", linha.cliente_id).maybeSingle();
      const orgId = (c as { organization_id: string | null } | null)?.organization_id;
      if (!orgId) return { ok: false as const, erro: "Ligue o cliente a uma organização do CRM primeiro (ficha › Dados)." };
      const { data: con } = await db.from("social_insights_connections").select("status, access_token_encrypted").eq("organization_id", orgId).maybeSingle();
      if (!(con as { access_token_encrypted: string | null } | null)?.access_token_encrypted) {
        return { ok: false as const, erro: "A organização do cliente não tem a Meta conectada. Conecte em Insights › Redes sociais, ou agende sem publicar sozinho." };
      }
    }
    const db = createAdminClient();
    const { data } = await db
      .from("agencia_publicacoes")
      .update({ situacao: "agendada", auto_publicar: autoPublicar, erro: null, atualizado_em: new Date().toISOString() })
      .eq("id", linha.id)
      .in("situacao", ["aprovada", "falhou"])
      .select("id");
    if (!data?.length) return { ok: false as const, erro: "A publicação mudou enquanto você olhava. Recarregue." };
    await auditarAgencia("agencia.publicacao_agendada", ctx.user.id, { tipo: "agencia_publicacao", id: linha.id }, { auto_publicar: autoPublicar });
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const };
  });
}

/** P4: o caminho de toda rede — marcar à mão, com o link do post se houver. */
export async function marcarComoPublicada(id: string, postUrl: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const { ctx, linha } = await daPessoa(id);
    if (!linha) return { ok: false as const, erro: "Publicação não encontrada." };
    const url = postUrl.trim();
    if (url && !/^https:\/\//i.test(url)) return { ok: false as const, erro: "O link do post precisa começar com https://." };
    if (linha.situacao === "publicando") return { ok: false as const, erro: "A central está publicando agora: espere um minuto." };
    if (linha.situacao === "publicada" || linha.situacao === "cancelada") return { ok: false as const, erro: "Essa publicação já foi encerrada." };
    const agora = new Date().toISOString();
    await gravar(linha.id, { situacao: "publicada", post_url: url || null, publicada_em: agora, erro: null, auto_publicar: false, atualizado_em: agora });
    await auditarAgencia("agencia.publicacao_marcada_publicada", ctx.user.id, { tipo: "agencia_publicacao", id: linha.id }, { situacao_antes: linha.situacao });
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const };
  });
}

export async function cancelarPublicacao(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const { ctx, linha } = await daPessoa(id);
    if (!linha) return { ok: false as const, erro: "Publicação não encontrada." };
    if (linha.situacao === "publicada" || linha.situacao === "publicando") return { ok: false as const, erro: "Publicação que já foi ao ar não se cancela aqui." };
    const db = createAdminClient();
    await gravar(linha.id, { situacao: "cancelada", auto_publicar: false, atualizado_em: new Date().toISOString() });
    await db.from("agencia_aprovacoes").update({ situacao: "cancelado" }).eq("publicacao_id", linha.id).eq("situacao", "pendente");
    await auditarAgencia("agencia.publicacao_cancelada", ctx.user.id, { tipo: "agencia_publicacao", id: linha.id });
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const };
  });
}

async function gravar(id: string, campos: Record<string, unknown>) {
  await createAdminClient().from("agencia_publicacoes").update(campos).eq("id", id).not("situacao", "in", "(publicada,publicando)");
}

/**
 * Arrastar o post para outro dia no calendário (plano de 27/10, item 3): mantém
 * a hora. Agendado que muda de data volta a "aprovada" — agenda-se de novo,
 * como ao editar a data no painel.
 */
export async function moverPublicacao(id: string, dia: string): Promise<ResultadoDaAcao<{ aviso: string | null }>> {
  return seguro(async () => {
    const { ctx, linha } = await daPessoa(id);
    if (!linha) return { ok: false as const, erro: "Publicação não encontrada." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return { ok: false as const, erro: "Dia inválido." };
    if (["publicada", "publicando", "cancelada"].includes(linha.situacao)) return { ok: false as const, erro: "Publicação encerrada não muda de dia." };
    const quando = instanteDoDia(dia, horaLocal(linha.quando)).toISOString();
    if (quando === new Date(linha.quando).toISOString()) return { ok: true as const, dados: { aviso: null } };
    const voltaParaAprovada = linha.situacao === "agendada";
    const { data } = await createAdminClient()
      .from("agencia_publicacoes")
      .update({ quando, ...(voltaParaAprovada ? { situacao: "aprovada", auto_publicar: false } : {}), atualizado_em: new Date().toISOString() })
      .eq("id", linha.id)
      .not("situacao", "in", "(publicada,publicando,cancelada)")
      .select("id");
    if (!data?.length) return { ok: false as const, erro: "A publicação mudou enquanto você olhava. Recarregue." };
    await auditarAgencia("agencia.publicacao_salva", ctx.user.id, { tipo: "agencia_publicacao", id: linha.id }, { arrastada_para: dia });
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const, dados: { aviso: voltaParaAprovada ? "A data mudou: agende de novo." : null } };
  });
}
