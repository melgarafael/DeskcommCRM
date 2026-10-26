"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao, type ContextoDaAgencia } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { cifrarSenha, decifrarSenha, PLATAFORMAS_DO_COFRE, registrarVisualizacao } from "@/lib/agencia/cofre/cofre";
import { gerarFormulario, type ResultadoDoWhatsapp } from "@/lib/agencia/formulario/gerar";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O formulário de acesso e o cofre, do lado de quem está logado
 * (docs/agencia/SPEC-cofre-e-formulario.md). Gerar o link exige
 * `clientes.gerenciar`; ver e mexer em senha, `cofre.ver_senhas` (F5) — e toda
 * ação confere que a pessoa alcança o cliente.
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

async function alcanca(ctx: ContextoDaAgencia, clienteId: string): Promise<boolean> {
  return podeVerCliente(await carregarAlcance(ctx), clienteId);
}

function revalidar(clienteId: string) {
  revalidatePath(`/agencia/clientes/${clienteId}`);
}

export async function gerarLinkDoFormulario(
  clienteId: string,
  enviarNoWhatsapp: boolean,
): Promise<ResultadoDaAcao<{ link: string; whatsapp: ResultadoDoWhatsapp }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    if (!idSchema.safeParse(clienteId).success || !(await alcanca(ctx, clienteId))) return { ok: false as const, erro: "Cliente não encontrado." };
    const r = await gerarFormulario({ clienteId, userId: ctx.user.id, enviarNoWhatsapp });
    if (!r.ok) return r;
    await auditarAgencia("agencia.formulario_gerado", ctx.user.id, { tipo: "agencia_formulario", id: r.formularioId }, {
      cliente_id: clienteId,
      whatsapp: r.whatsapp,
    });
    revalidar(clienteId);
    return { ok: true as const, dados: { link: r.link, whatsapp: r.whatsapp } };
  });
}

export async function cancelarFormulario(formularioId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    if (!idSchema.safeParse(formularioId).success) return { ok: false as const, erro: "Formulário inválido." };
    const db = createAdminClient();
    const { data } = await db.from("agencia_formularios").select("cliente_id").eq("id", formularioId).maybeSingle();
    const clienteId = (data as { cliente_id?: string } | null)?.cliente_id;
    if (!clienteId || !(await alcanca(ctx, clienteId))) return { ok: false as const, erro: "Formulário não encontrado." };
    await db.from("agencia_formularios").update({ situacao: "cancelado" }).eq("id", formularioId).eq("situacao", "aberto");
    await auditarAgencia("agencia.formulario_cancelado", ctx.user.id, { tipo: "agencia_formulario", id: formularioId });
    revalidar(clienteId);
    return { ok: true as const };
  });
}

/** Mostra uma senha a quem tem `cofre.ver_senhas` — e registra que viu (F5). */
export async function verSenha(itemId: string): Promise<ResultadoDaAcao<{ senha: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("cofre.ver_senhas");
    if (!idSchema.safeParse(itemId).success) return { ok: false as const, erro: "Acesso inválido." };
    const { data } = await createAdminClient()
      .from("agencia_cofre_itens")
      .select("cliente_id, plataforma, senha_ct, senha_iv, senha_tag")
      .eq("id", itemId)
      .maybeSingle();
    const l = data as { cliente_id: string; plataforma: string; senha_ct: unknown; senha_iv: unknown; senha_tag: unknown } | null;
    if (!l || !(await alcanca(ctx, l.cliente_id))) return { ok: false as const, erro: "Acesso não encontrado." };
    const senha = decifrarSenha(l);
    if (senha === null) return { ok: false as const, erro: "Este acesso não tem senha guardada." };
    await registrarVisualizacao({ itemId, clienteId: l.cliente_id, userId: ctx.user.id, motivo: "ver" });
    await auditarAgencia("agencia.cofre_senha_vista", ctx.user.id, { tipo: "agencia_cofre_item", id: itemId }, { plataforma: l.plataforma });
    revalidar(l.cliente_id);
    return { ok: true as const, dados: { senha } };
  });
}

const itemSchema = z.object({
  id: z.string().uuid().optional(),
  clienteId: z.string().uuid(),
  plataforma: z.enum(PLATAFORMAS_DO_COFRE),
  rotulo: z.string().trim().min(2, "Dê um nome ao acesso.").max(80),
  login: z.string().trim().max(200),
  extra: z.string().trim().max(300),
  /** null = manter a senha que já está guardada. */
  senha: z.string().max(500).nullable(),
});

export async function salvarItemDoCofre(entrada: z.input<typeof itemSchema>): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("cofre.ver_senhas");
    const p = itemSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    if (!(await alcanca(ctx, d.clienteId))) return { ok: false as const, erro: "Cliente não encontrado." };
    const db = createAdminClient();
    const senha =
      d.senha === null ? {} : d.senha ? cifrarSenha(d.senha) : { senha_ct: null, senha_iv: null, senha_tag: null };
    const linha = {
      plataforma: d.plataforma,
      rotulo: d.rotulo,
      login: d.login || null,
      extra: d.extra || null,
      ...senha,
      atualizado_em: new Date().toISOString(),
      atualizado_por: ctx.user.id,
    };
    let id = d.id;
    if (id) {
      const { data, error } = await db.from("agencia_cofre_itens").update(linha).eq("id", id).eq("cliente_id", d.clienteId).select("id");
      if (error || !data?.length) return { ok: false as const, erro: "Não deu para salvar." };
    } else {
      const { data, error } = await db
        .from("agencia_cofre_itens")
        .insert({ ...linha, cliente_id: d.clienteId, origem: "manual" })
        .select("id")
        .single();
      if (error || !data) return { ok: false as const, erro: "Não deu para salvar." };
      id = (data as { id: string }).id;
    }
    await auditarAgencia("agencia.cofre_item_salvo", ctx.user.id, { tipo: "agencia_cofre_item", id: id! }, {
      plataforma: d.plataforma,
      trocou_senha: d.senha !== null,
    });
    revalidar(d.clienteId);
    return { ok: true as const };
  });
}

export async function excluirItemDoCofre(itemId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("cofre.ver_senhas");
    if (!idSchema.safeParse(itemId).success) return { ok: false as const, erro: "Acesso inválido." };
    const db = createAdminClient();
    const { data } = await db.from("agencia_cofre_itens").select("cliente_id, plataforma").eq("id", itemId).maybeSingle();
    const l = data as { cliente_id: string; plataforma: string } | null;
    if (!l || !(await alcanca(ctx, l.cliente_id))) return { ok: false as const, erro: "Acesso não encontrado." };
    await db.from("agencia_cofre_itens").delete().eq("id", itemId);
    await auditarAgencia("agencia.cofre_item_excluido", ctx.user.id, { tipo: "agencia_cofre_item", id: itemId }, { plataforma: l.plataforma });
    revalidar(l.cliente_id);
    return { ok: true as const };
  });
}
