"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { garantirPastasDoCliente } from "@/lib/agencia/acervo/pastas";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import {
  clienteSchema,
  contratacaoSchema,
  type EntradaDaContratacao,
  type EntradaDoCliente,
} from "@/lib/agencia/clientes/schemas";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Clientes da agência (docs/agencia/SPEC-clientes.md). Toda escrita exige
 * `clientes.gerenciar`; a leitura filtrada por quem atende mora nas páginas
 * (`lib/agencia/clientes/visibilidade.ts`).
 */

function revalidar(id?: string) {
  revalidatePath("/agencia/clientes");
  if (id) revalidatePath(`/agencia/clientes/${id}`);
}

async function falharSemLancar<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

export async function salvarCliente(entrada: EntradaDoCliente): Promise<ResultadoDaAcao<{ id: string }>> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = clienteSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    const db = createAdminClient();
    const linha = {
      nome: d.nome,
      razao_social: d.razaoSocial ?? null,
      documento: d.documento ?? null,
      segmento: d.segmento ?? null,
      responsavel_nome: d.responsavelNome ?? null,
      whatsapp: d.whatsapp ?? null,
      email: d.email ?? null,
      cidade: d.cidade ?? null,
      instagram: d.instagram ?? null,
      site: d.site ?? null,
      observacoes: d.observacoes ?? null,
      situacao: d.situacao,
      atualizado_em: new Date().toISOString(),
    };

    let id = d.id;
    let renomeado = false;
    if (id) {
      const { data: antes } = await db.from("agencia_clientes").select("nome").eq("id", id).maybeSingle();
      renomeado = (antes as { nome?: string } | null)?.nome !== d.nome;
      const { error } = await db.from("agencia_clientes").update(linha).eq("id", id);
      if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
      await auditarAgencia("agencia.cliente_alterado", ctx.user.id, { tipo: "agencia_cliente", id });
    } else {
      const { data, error } = await db
        .from("agencia_clientes")
        .insert({ ...linha, criado_por: ctx.user.id })
        .select("id")
        .single();
      if (error || !data) {
        logger.error("agência: cliente não gravou", { codigo: error?.code });
        return { ok: false as const, erro: "Não deu para cadastrar. Tente de novo." };
      }
      id = (data as { id: string }).id;
      await auditarAgencia("agencia.cliente_criado", ctx.user.id, { tipo: "agencia_cliente", id });
    }

    // Empresas do grupo: troca o conjunto pelo informado.
    await db.from("agencia_clientes_empresas").delete().eq("cliente_id", id);
    if (d.empresas.length > 0) {
      await db.from("agencia_clientes_empresas").insert(
        d.empresas.map((e, i) => ({ cliente_id: id, nome: e.nome, documento: e.documento?.replace(/\D/g, "") || null, ordem: i })),
      );
    }

    // A pasta no Drive (spec acervo): nasce ou é renomeada. Sem Drive, segue.
    await garantirPastasDoCliente(id!, { renomear: renomeado });

    revalidar(id);
    return { ok: true as const, dados: { id: id! } };
  });
}

const situacaoSchema = clienteSchema.shape.situacao;

export async function mudarSituacaoDoCliente(id: string, situacao: string): Promise<ResultadoDaAcao> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const s = situacaoSchema.safeParse(situacao);
    if (!idSchema.safeParse(id).success || !s.success) return { ok: false as const, erro: "Situação inválida." };
    const { error } = await createAdminClient()
      .from("agencia_clientes")
      .update({ situacao: s.data, atualizado_em: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
    await auditarAgencia("agencia.cliente_situacao_alterada", ctx.user.id, { tipo: "agencia_cliente", id }, { situacao: s.data });
    revalidar(id);
    return { ok: true as const };
  });
}

export async function salvarEquipeDoCliente(id: string, membros: string[]): Promise<ResultadoDaAcao> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = z.array(z.string().uuid()).max(50).safeParse(membros);
    if (!idSchema.safeParse(id).success || !p.success) return { ok: false as const, erro: "Equipe inválida." };
    const db = createAdminClient();
    await db.from("agencia_clientes_membros").delete().eq("cliente_id", id);
    if (p.data.length > 0) {
      const { error } = await db
        .from("agencia_clientes_membros")
        .insert(p.data.map((membro_id) => ({ cliente_id: id, membro_id })));
      if (error) return { ok: false as const, erro: "Não deu para salvar a equipe." };
    }
    await auditarAgencia("agencia.cliente_equipe_alterada", ctx.user.id, { tipo: "agencia_cliente", id }, { membros: p.data });
    revalidar(id);
    return { ok: true as const };
  });
}

export async function salvarContratacao(entrada: EntradaDaContratacao): Promise<ResultadoDaAcao> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = contratacaoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    const linha = {
      cliente_id: d.clienteId,
      tipo: d.tipo,
      servicos: d.servicos,
      quantidades: d.quantidades,
      inicio: d.inicio ?? null,
      fim: d.fim ?? null,
      situacao: d.situacao,
      observacoes: d.observacoes ?? null,
    };
    const db = createAdminClient();
    if (d.id) {
      const { error } = await db.from("agencia_contratacoes").update(linha).eq("id", d.id).eq("cliente_id", d.clienteId);
      if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
      await auditarAgencia("agencia.contratacao_alterada", ctx.user.id, { tipo: "agencia_contratacao", id: d.id });
    } else {
      const { data, error } = await db.from("agencia_contratacoes").insert(linha).select("id").single();
      if (error || !data) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
      await auditarAgencia("agencia.contratacao_criada", ctx.user.id, { tipo: "agencia_contratacao", id: (data as { id: string }).id });
    }
    revalidar(d.clienteId);
    return { ok: true as const };
  });
}

/** Liga (ou desliga, com `null`) o cliente a uma organização da central. */
export async function ligarOrganizacao(id: string, organizationId: string | null): Promise<ResultadoDaAcao> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    if (!idSchema.safeParse(id).success || (organizationId !== null && !idSchema.safeParse(organizationId).success)) {
      return { ok: false as const, erro: "Organização inválida." };
    }
    const { error } = await createAdminClient()
      .from("agencia_clientes")
      .update({ organization_id: organizationId, atualizado_em: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      return {
        ok: false as const,
        erro: error.code === "23505" ? "Essa organização já está ligada a outro cliente." : "Não deu para ligar.",
      };
    }
    await auditarAgencia("agencia.cliente_organizacao_ligada", ctx.user.id, { tipo: "agencia_cliente", id }, {
      organization_id: organizationId,
    });
    revalidar(id);
    return { ok: true as const };
  });
}

/**
 * Exclui o cliente (exclusão física). Todas as tabelas que referenciam
 * `agencia_clientes.id` têm `on delete cascade` ou `on delete set null`
 * (migrations 9004–9011), então a exclusão não deixa lixo órfão no banco: as
 * contratações, membros, arquivos, tarefas, trilhas, cofre, formulários,
 * contratos, aprovações, mapas mentais e publicações do cliente somem com ele.
 * A pasta do cliente no Google Drive (se existir) NÃO é apagada: fica órfã lá,
 * fora do alcance deste cadastro — quem gerencia pode apagá-la manualmente.
 */
export async function excluirCliente(id: string): Promise<ResultadoDaAcao> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    if (!idSchema.safeParse(id).success) return { ok: false as const, erro: "Cliente inválido." };
    const db = createAdminClient();
    const { data } = await db.from("agencia_clientes").select("nome").eq("id", id).maybeSingle();
    const cliente = data as { nome: string } | null;
    if (!cliente) return { ok: false as const, erro: "Cliente não encontrado." };
    const { error } = await db.from("agencia_clientes").delete().eq("id", id);
    if (error) return { ok: false as const, erro: "Não deu para excluir. Tente de novo." };
    await auditarAgencia("agencia.cliente_excluido", ctx.user.id, { tipo: "agencia_cliente", id }, { nome: cliente.nome });
    revalidar();
    return { ok: true as const };
  });
}

/**
 * "Importar das organizações" (C2): um cliente por organização marcada, com o
 * nome dela e o vínculo. A que já virou cliente é ignorada, nunca duplicada.
 */
export async function importarOrganizacoes(ids: string[]): Promise<ResultadoDaAcao<{ criados: number }>> {
  return falharSemLancar(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = z.array(z.string().uuid()).min(1, "Marque pelo menos uma organização.").max(200).safeParse(ids);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const db = createAdminClient();

    const [{ data: orgs }, { data: jaClientes }] = await Promise.all([
      db.from("organizations").select("id, display_name, legal_name, cnpj").in("id", p.data),
      db.from("agencia_clientes").select("organization_id").in("organization_id", p.data),
    ]);
    const ligadas = new Set(((jaClientes ?? []) as Array<{ organization_id: string }>).map((c) => c.organization_id));
    const novas = ((orgs ?? []) as Array<{ id: string; display_name: string | null; legal_name: string | null; cnpj: string | null }>).filter(
      (o) => !ligadas.has(o.id),
    );

    let criados = 0;
    for (const o of novas) {
      const { data, error } = await db
        .from("agencia_clientes")
        .insert({
          nome: o.display_name || o.legal_name || "Cliente",
          razao_social: o.legal_name,
          documento: o.cnpj?.replace(/\D/g, "") || null,
          situacao: "ativo",
          organization_id: o.id,
          criado_por: ctx.user.id,
        })
        .select("id")
        .single();
      if (error || !data) continue; // corrida com outra importação: o unique protege
      criados++;
      const id = (data as { id: string }).id;
      await auditarAgencia("agencia.cliente_importado", ctx.user.id, { tipo: "agencia_cliente", id }, { organization_id: o.id });
      await garantirPastasDoCliente(id, { renomear: false });
    }
    revalidar();
    return { ok: true as const, dados: { criados } };
  });
}
