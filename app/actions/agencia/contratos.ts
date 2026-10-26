"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao, type ContextoDaAgencia } from "@/lib/agencia/acesso";
import { enviarArquivoPequeno, estadoDoDrive } from "@/lib/agencia/acervo/drive";
import { garantirPastasDoCliente } from "@/lib/agencia/acervo/pastas";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { instanteDoDia } from "@/lib/agencia/calendario/regras";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { concluirSeAssinadoEPago, type EfeitosDaConclusao } from "@/lib/agencia/contratos/conclusao";
import {
  configDosContratos,
  criarLinkDePagamento,
  enviarParaZapsign,
  garantirSegredo,
  registrarWebhookNaZapsign,
  salvarInfinitepay,
  salvarZapsign,
  urlsDosWebhooks,
} from "@/lib/agencia/contratos/integracoes";
import { renderContratoPdf } from "@/lib/agencia/contratos/pdf";
import { preencherModelo, validadeDaProposta } from "@/lib/agencia/contratos/regras";
import { valoresDoContrato } from "@/lib/agencia/contratos/valores";
import { normalizarWhatsapp } from "@/lib/agencia/convite";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { diaLocal } from "@/lib/agencia/tarefas/regras";
import { marcaDaSaida } from "@/lib/branding/saida";
import { env } from "@/lib/env";
import { parseReaisToCents } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Contratos da agência (docs/agencia/SPEC-contratos.md). Tudo exige
 * `contratos.gerenciar` e que a pessoa alcance o cliente; as integrações,
 * `configuracoes.gerenciar`.
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

function revalidar(clienteId: string) {
  revalidatePath(`/agencia/clientes/${clienteId}`);
  revalidatePath("/agencia/contratos");
}

async function alcanca(ctx: ContextoDaAgencia, clienteId: string): Promise<boolean> {
  return podeVerCliente(await carregarAlcance(ctx), clienteId);
}

const dadosSchema = z.object({
  clienteId: z.string().uuid(),
  modeloId: z.string().uuid(),
  contratacaoId: z.string().uuid().nullable(),
  valorMensal: z.string().trim().max(30),
  formaPagamento: z.string().trim().max(200),
  diaVencimento: z.number().int().min(1).max(31).nullable(),
  prazoMeses: z.number().int().min(1).max(120),
  fechamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data do fechamento inválida."),
  validadeDias: z.number().int().min(1).max(60),
});
export type DadosDoContrato = z.input<typeof dadosSchema>;

async function montar(ctx: ContextoDaAgencia, entrada: DadosDoContrato) {
  const p = dadosSchema.safeParse(entrada);
  if (!p.success) return { erro: primeiroErro(p.error) } as const;
  const d = p.data;
  if (!(await alcanca(ctx, d.clienteId))) return { erro: "Cliente não encontrado." } as const;
  const valorCents = d.valorMensal ? parseReaisToCents(d.valorMensal) : 0;
  if (valorCents === null) return { erro: "Valor mensal inválido. Use, por exemplo, 2.500,00." } as const;
  const { data: modelo } = await createAdminClient().from("agencia_contrato_modelos").select("id, nome, corpo").eq("id", d.modeloId).maybeSingle();
  const m = modelo as { id: string; nome: string; corpo: string } | null;
  if (!m) return { erro: "Modelo não encontrado." } as const;
  const validoAte = validadeDaProposta(d.fechamento, d.validadeDias);
  const valores = await valoresDoContrato({
    clienteId: d.clienteId,
    contratacaoId: d.contratacaoId,
    valorMensalCents: valorCents,
    formaPagamento: d.formaPagamento || null,
    diaVencimento: d.diaVencimento,
    prazoMeses: d.prazoMeses,
    fechamento: d.fechamento,
    validoAte,
  });
  return { d, m, valorCents, validoAte, ...preencherModelo(m.corpo, valores) } as const;
}

/** A prévia do texto, com o que falta preencher (K1). Não grava nada. */
export async function previaDoContrato(entrada: DadosDoContrato): Promise<ResultadoDaAcao<{ texto: string; faltando: string[]; desconhecidos: string[] }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const r = await montar(ctx, entrada);
    if ("erro" in r) return { ok: false as const, erro: r.erro! };
    return { ok: true as const, dados: { texto: r.texto, faltando: r.faltando, desconhecidos: r.desconhecidos } };
  });
}

export async function gerarContrato(entrada: DadosDoContrato): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const r = await montar(ctx, entrada);
    if ("erro" in r) return { ok: false as const, erro: r.erro! };
    if (r.desconhecidos.length) return { ok: false as const, erro: `O modelo usa campos que não existem: ${r.desconhecidos.join(", ")}.` };
    const db = createAdminClient();
    const { data: cliente } = await db.from("agencia_clientes").select("nome").eq("id", r.d.clienteId).maybeSingle();
    const nome = (cliente as { nome?: string } | null)?.nome ?? "Cliente";
    const { data, error } = await db
      .from("agencia_contratos")
      .insert({
        cliente_id: r.d.clienteId,
        contratacao_id: r.d.contratacaoId,
        modelo_id: r.m.id,
        modelo_nome: r.m.nome,
        titulo: `Contrato — ${nome}`,
        texto: r.texto,
        valor_mensal_cents: r.valorCents,
        forma_pagamento: r.d.formaPagamento || null,
        dia_vencimento: r.d.diaVencimento,
        prazo_meses: r.d.prazoMeses,
        fechamento_em: r.d.fechamento,
        valido_ate: r.validoAte,
        criado_por: ctx.user.id,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false as const, erro: "Não deu para gerar o contrato." };
    const id = (data as { id: string }).id;
    await auditarAgencia("agencia.contrato_gerado", ctx.user.id, { tipo: "agencia_contrato", id }, { faltando: r.faltando.length });
    await copiarNoDrive(id).catch(() => undefined);
    revalidar(r.d.clienteId);
    return { ok: true as const, dados: { id } };
  });
}

interface LinhaDoContrato {
  id: string;
  cliente_id: string;
  titulo: string;
  texto: string;
  situacao: string;
  valor_mensal_cents: number;
  zapsign_doc_token: string | null;
  pagamento_order_nsu: string | null;
  agencia_clientes: { nome: string; razao_social: string | null; responsavel_nome: string | null; email: string | null; whatsapp: string | null } | null;
}

async function lerContrato(ctx: ContextoDaAgencia, id: string): Promise<LinhaDoContrato | null> {
  if (!idSchema.safeParse(id).success) return null;
  const { data } = await createAdminClient()
    .from("agencia_contratos")
    .select("id, cliente_id, titulo, texto, situacao, valor_mensal_cents, zapsign_doc_token, pagamento_order_nsu, agencia_clientes(nome, razao_social, responsavel_nome, email, whatsapp)")
    .eq("id", id)
    .maybeSingle();
  const c = data as unknown as LinhaDoContrato | null;
  return c && (await alcanca(ctx, c.cliente_id)) ? c : null;
}

async function pdfDe(c: Pick<LinhaDoContrato, "texto" | "titulo" | "agencia_clientes">): Promise<Buffer> {
  const marca = await marcaDaSaida(null);
  return renderContratoPdf({
    texto: c.texto,
    titulo: c.titulo,
    contratante: c.agencia_clientes?.razao_social || c.agencia_clientes?.nome || "Contratante",
    contratada: marca.nome,
  });
}

/** O PDF vai para a subpasta "02 Contrato e proposta" quando o Drive está conectado (K7). */
async function copiarNoDrive(contratoId: string): Promise<void> {
  if (!(await estadoDoDrive()).conectado) return;
  const db = createAdminClient();
  const { data } = await db
    .from("agencia_contratos")
    .select("cliente_id, titulo, texto, agencia_clientes(nome, razao_social, responsavel_nome, email, whatsapp)")
    .eq("id", contratoId)
    .maybeSingle();
  const c = data as unknown as Pick<LinhaDoContrato, "cliente_id" | "titulo" | "texto" | "agencia_clientes"> | null;
  if (!c) return;
  await garantirPastasDoCliente(c.cliente_id, { renomear: false });
  const { data: cli } = await db.from("agencia_clientes").select("drive_subpastas").eq("id", c.cliente_id).maybeSingle();
  const pasta = (cli as { drive_subpastas?: Record<string, string> } | null)?.drive_subpastas?.["02 Contrato e proposta"];
  if (!pasta) return;
  const r = await enviarArquivoPequeno({ nome: `${c.titulo} ${diaLocal(new Date())}.pdf`, mime: "application/pdf", conteudo: await pdfDe(c), pastaId: pasta });
  if (r.ok) await db.from("agencia_contratos").update({ drive_file_id: r.valor.id }).eq("id", contratoId);
}

/** Ajuste do texto antes de enviar (só em rascunho). */
export async function salvarTextoDoContrato(id: string, texto: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const t = z.string().trim().min(20, "O texto ficou curto demais.").max(100_000).safeParse(texto);
    if (!t.success) return { ok: false as const, erro: primeiroErro(t.error) };
    const c = await lerContrato(ctx, id);
    if (!c) return { ok: false as const, erro: "Contrato não encontrado." };
    if (c.situacao !== "rascunho") return { ok: false as const, erro: "Só dá para mudar o texto antes de enviar." };
    await createAdminClient().from("agencia_contratos").update({ texto: t.data, atualizado_em: new Date().toISOString() }).eq("id", id);
    await auditarAgencia("agencia.contrato_alterado", ctx.user.id, { tipo: "agencia_contrato", id });
    revalidar(c.cliente_id);
    return { ok: true as const };
  });
}

export async function enviarParaAssinatura(id: string): Promise<ResultadoDaAcao<{ link: string | null }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const c = await lerContrato(ctx, id);
    if (!c) return { ok: false as const, erro: "Contrato não encontrado." };
    if (c.zapsign_doc_token) return { ok: false as const, erro: "Este contrato já foi para a ZapSign." };
    if (["concluido", "recusado", "cancelado"].includes(c.situacao)) return { ok: false as const, erro: "Este contrato não está mais aberto." };
    if (c.texto.includes("[FALTA:")) return { ok: false as const, erro: "O texto ainda tem campos em falta. Complete o cadastro ou ajuste o texto." };
    const cli = c.agencia_clientes;
    const r = await enviarParaZapsign({
      contratoId: id,
      titulo: c.titulo,
      pdf: await pdfDe(c),
      signatario: {
        nome: cli?.responsavel_nome || cli?.nome || "Contratante",
        email: cli?.email ?? null,
        telefone: cli?.whatsapp ? normalizarWhatsapp(cli.whatsapp) : null,
      },
    });
    if (!r.ok) return r;
    await createAdminClient()
      .from("agencia_contratos")
      .update({ zapsign_doc_token: r.valor.token, zapsign_link: r.valor.link, zapsign_situacao: "pending", situacao: "enviado", atualizado_em: new Date().toISOString() })
      .eq("id", id);
    await auditarAgencia("agencia.contrato_enviado_zapsign", ctx.user.id, { tipo: "agencia_contrato", id });
    revalidar(c.cliente_id);
    return { ok: true as const, dados: { link: r.valor.link } };
  });
}

export async function gerarLinkDePagamento(id: string): Promise<ResultadoDaAcao<{ link: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const c = await lerContrato(ctx, id);
    if (!c) return { ok: false as const, erro: "Contrato não encontrado." };
    if (["concluido", "recusado", "cancelado"].includes(c.situacao)) return { ok: false as const, erro: "Este contrato não está mais aberto." };
    const segredo = await garantirSegredo();
    const orderNsu = c.pagamento_order_nsu ?? `ag-${id}`;
    const cli = c.agencia_clientes;
    const r = await criarLinkDePagamento({
      orderNsu,
      descricao: `${c.titulo} — primeira mensalidade`,
      valorCents: c.valor_mensal_cents,
      webhookUrl: urlsDosWebhooks(env.NEXT_PUBLIC_APP_URL, segredo).infinitepay,
      redirectUrl: env.NEXT_PUBLIC_APP_URL,
      cliente: { nome: cli?.responsavel_nome || cli?.nome || "Cliente", email: cli?.email ?? null, telefone: cli?.whatsapp ? normalizarWhatsapp(cli.whatsapp) : null },
    });
    if (!r.ok) return r;
    await createAdminClient()
      .from("agencia_contratos")
      .update({ pagamento_link: r.valor.link, pagamento_order_nsu: orderNsu, situacao: c.situacao === "rascunho" ? "enviado" : c.situacao, atualizado_em: new Date().toISOString() })
      .eq("id", id);
    await auditarAgencia("agencia.contrato_link_de_pagamento", ctx.user.id, { tipo: "agencia_contrato", id });
    revalidar(c.cliente_id);
    return { ok: true as const, dados: { link: r.valor.link } };
  });
}

/** Marca assinado ou pago à mão (K3), com o dia; os dois juntos disparam a conclusão (K5). */
export async function marcarNoContrato(id: string, oQue: "assinado" | "pago", dia: string): Promise<ResultadoDaAcao<{ efeitos: EfeitosDaConclusao }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia > diaLocal(new Date())) return { ok: false as const, erro: "Escolha um dia até hoje." };
    const c = await lerContrato(ctx, id);
    if (!c) return { ok: false as const, erro: "Contrato não encontrado." };
    if (["concluido", "recusado", "cancelado"].includes(c.situacao)) return { ok: false as const, erro: "Este contrato não está mais aberto." };
    const quando = instanteDoDia(dia, "12:00").toISOString();
    await createAdminClient()
      .from("agencia_contratos")
      .update({
        ...(oQue === "assinado" ? { assinado_em: quando } : { pago_em: quando }),
        situacao: c.situacao === "rascunho" ? "enviado" : c.situacao,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", id);
    await auditarAgencia(oQue === "assinado" ? "agencia.contrato_assinado" : "agencia.contrato_pago", ctx.user.id, { tipo: "agencia_contrato", id }, { dia, manual: true });
    const efeitos = await concluirSeAssinadoEPago(id, ctx.user.id);
    revalidar(c.cliente_id);
    revalidatePath("/agencia/trilhas");
    return { ok: true as const, dados: { efeitos } };
  });
}

/**
 * Recusou (K6): o contrato fecha e, se o cliente não tem nenhum contrato assinado
 * e pago, ele vai para a lista de remarketing. Cliente ativo que recusa uma
 * proposta a mais continua ativo (achado da prova da Fase 6).
 */
export async function recusarContrato(id: string): Promise<ResultadoDaAcao<{ remarketing: boolean }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const c = await lerContrato(ctx, id);
    if (!c) return { ok: false as const, erro: "Contrato não encontrado." };
    if (c.situacao === "concluido") return { ok: false as const, erro: "Contrato já assinado e pago." };
    const db = createAdminClient();
    await db.from("agencia_contratos").update({ situacao: "recusado", atualizado_em: new Date().toISOString() }).eq("id", id);
    const { count } = await db
      .from("agencia_contratos")
      .select("id", { count: "exact", head: true })
      .eq("cliente_id", c.cliente_id)
      .eq("situacao", "concluido");
    const remarketing = !count;
    if (remarketing) {
      await db.from("agencia_clientes").update({ situacao: "remarketing", atualizado_em: new Date().toISOString() }).eq("id", c.cliente_id);
    }
    await auditarAgencia("agencia.contrato_recusado", ctx.user.id, { tipo: "agencia_contrato", id }, { remarketing });
    revalidar(c.cliente_id);
    return { ok: true as const, dados: { remarketing } };
  });
}

export async function cancelarContrato(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const c = await lerContrato(ctx, id);
    if (!c) return { ok: false as const, erro: "Contrato não encontrado." };
    if (c.situacao === "concluido") return { ok: false as const, erro: "Contrato já assinado e pago." };
    await createAdminClient().from("agencia_contratos").update({ situacao: "cancelado", atualizado_em: new Date().toISOString() }).eq("id", id);
    await auditarAgencia("agencia.contrato_cancelado", ctx.user.id, { tipo: "agencia_contrato", id });
    revalidar(c.cliente_id);
    return { ok: true as const };
  });
}

// ── Modelos ────────────────────────────────────────────────────────────────

const modeloSchema = z.object({
  id: z.string().uuid().optional(),
  nome: z.string().trim().min(2, "Dê um nome ao modelo.").max(120),
  corpo: z.string().trim().min(20, "O texto do modelo ficou curto demais.").max(100_000),
  ativo: z.boolean(),
});

export async function salvarModeloDeContrato(entrada: z.input<typeof modeloSchema>): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("contratos.gerenciar");
    const p = modeloSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const { desconhecidos } = preencherModelo(p.data.corpo, {});
    if (desconhecidos.length) return { ok: false as const, erro: `Campos que não existem: ${desconhecidos.join(", ")}.` };
    const db = createAdminClient();
    const linha = { nome: p.data.nome, corpo: p.data.corpo, ativo: p.data.ativo, atualizado_em: new Date().toISOString() };
    const r = p.data.id
      ? await db.from("agencia_contrato_modelos").update(linha).eq("id", p.data.id).select("id").single()
      : await db.from("agencia_contrato_modelos").insert(linha).select("id").single();
    if (r.error?.code === "23505") return { ok: false as const, erro: "Já existe um modelo com esse nome." };
    if (r.error || !r.data) return { ok: false as const, erro: "Não deu para salvar o modelo." };
    const id = (r.data as { id: string }).id;
    await auditarAgencia("agencia.contrato_modelo_salvo", ctx.user.id, { tipo: "agencia_contrato_modelo", id });
    revalidatePath("/agencia/contratos/modelos");
    return { ok: true as const, dados: { id } };
  });
}

// ── Integrações ────────────────────────────────────────────────────────────

const integracoesSchema = z.object({
  /** null = manter o token guardado; "" = tirar. */
  zapsignToken: z.string().trim().max(200).nullable(),
  zapsignSandbox: z.boolean(),
  infinitepayHandle: z
    .string()
    .trim()
    .max(60)
    .transform((v) => v.replace(/^\$/, ""))
    .refine((v) => !v || /^[a-z0-9_.-]{2,60}$/i.test(v), "InfiniteTag inválida (sem o $)."),
});

export async function salvarIntegracoesDosContratos(entrada: z.input<typeof integracoesSchema>): Promise<ResultadoDaAcao<{ webhookZapsign: string | null }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    const p = integracoesSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const atual = await configDosContratos();
    if (p.data.zapsignToken !== null || p.data.zapsignSandbox !== atual.zapsignSandbox) {
      await salvarZapsign(p.data.zapsignToken === null ? atual.zapsignToken : p.data.zapsignToken || null, p.data.zapsignSandbox);
    }
    await salvarInfinitepay(p.data.infinitepayHandle || null);
    const segredo = await garantirSegredo();
    let webhookZapsign: string | null = null;
    if (p.data.zapsignToken) {
      // Cadastra o webhook da conta na ZapSign; se falhar, a tela mostra o endereço para cadastrar à mão.
      const url = urlsDosWebhooks(env.NEXT_PUBLIC_APP_URL, segredo).zapsign;
      const r = await registrarWebhookNaZapsign(url);
      if (!r.ok) webhookZapsign = url;
    }
    await auditarAgencia("agencia.contratos_integracoes_configuradas", ctx.user.id, null, {
      zapsign: p.data.zapsignToken === null ? "mantido" : p.data.zapsignToken ? "trocado" : "removido",
      infinitepay: !!p.data.infinitepayHandle,
    });
    revalidatePath("/agencia/configuracoes");
    return { ok: true as const, dados: { webhookZapsign } };
  });
}
