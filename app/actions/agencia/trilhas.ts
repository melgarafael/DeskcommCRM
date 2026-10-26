"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao, type ContextoDaAgencia } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { concluirPasso, iniciarTrilha, lerPasso, pularPasso, recriarTarefa } from "@/lib/agencia/trilhas/motor";
import { problemaNoModelo } from "@/lib/agencia/trilhas/regras";
import { REGRAS_DE_PRAZO, TIPOS_DE_PASSO } from "@/lib/agencia/trilhas/vocabulario";
import { TIPOS_DE_REUNIAO } from "@/lib/agencia/calendario/vocabulario";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A trilha do cliente (docs/agencia/SPEC-trilhas.md, R11): iniciar, concluir o
 * marco, pular e cancelar exigem `clientes.gerenciar` e alcançar o cliente;
 * editar modelos exige `trilhas.gerenciar`.
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
  revalidatePath("/agencia/trilhas");
  revalidatePath("/agencia/tarefas");
  revalidatePath("/agencia");
}

async function alcancaCliente(ctx: ContextoDaAgencia, clienteId: string): Promise<boolean> {
  return podeVerCliente(await carregarAlcance(ctx), clienteId);
}

const inicioSchema = z.object({
  clienteId: z.string().uuid(),
  modeloId: z.string().uuid(),
  contratacaoId: z.string().uuid().nullable(),
  aPartirDe: z.string().regex(/^[a-z0-9_]{2,40}$/).nullable(),
});

export async function iniciarTrilhaDoCliente(entrada: z.input<typeof inicioSchema>): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = inicioSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: "Escolha o modelo da trilha." };
    if (!(await alcancaCliente(ctx, p.data.clienteId))) return { ok: false as const, erro: "Você não atende esse cliente." };
    if (p.data.contratacaoId) {
      const { data } = await createAdminClient()
        .from("agencia_contratacoes")
        .select("cliente_id")
        .eq("id", p.data.contratacaoId)
        .maybeSingle();
      if ((data as { cliente_id?: string } | null)?.cliente_id !== p.data.clienteId) {
        return { ok: false as const, erro: "Essa contratação não é deste cliente." };
      }
    }
    const r = await iniciarTrilha({ ...p.data, userId: ctx.user.id });
    if (!r.ok) return r;
    await auditarAgencia("agencia.trilha_iniciada", ctx.user.id, { tipo: "agencia_trilha", id: r.trilhaId }, {
      cliente_id: p.data.clienteId,
      a_partir_de: p.data.aPartirDe,
    });
    revalidar(p.data.clienteId);
    return { ok: true as const, dados: { id: r.trilhaId } };
  });
}

/** Passo da trilha que a pessoa pode mexer: existe e é de um cliente que ela alcança. */
async function passoPermitido(ctx: ContextoDaAgencia, passoId: string) {
  if (!idSchema.safeParse(passoId).success) return null;
  const p = await lerPasso(passoId);
  if (!p || !(await alcancaCliente(ctx, p.cliente_id))) return null;
  return p;
}

export async function concluirPassoDaTrilha(passoId: string, dia: string | null): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    if (dia !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dia)) return { ok: false as const, erro: "Data inválida." };
    const p = await passoPermitido(ctx, passoId);
    if (!p) return { ok: false as const, erro: "Passo não encontrado." };
    const r = await concluirPasso(passoId, dia, ctx.user.id);
    if (!r.ok) return r;
    await auditarAgencia("agencia.trilha_passo_concluido", ctx.user.id, { tipo: "agencia_trilha_passo", id: passoId }, { chave: p.chave, dia });
    revalidar(p.cliente_id);
    return { ok: true as const };
  });
}

export async function pularPassoDaTrilha(passoId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = await passoPermitido(ctx, passoId);
    if (!p) return { ok: false as const, erro: "Passo não encontrado." };
    const r = await pularPasso(passoId, ctx.user.id);
    if (!r.ok) return r;
    await auditarAgencia("agencia.trilha_passo_pulado", ctx.user.id, { tipo: "agencia_trilha_passo", id: passoId }, { chave: p.chave });
    revalidar(p.cliente_id);
    return { ok: true as const };
  });
}

export async function recriarTarefaDoPasso(passoId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    const p = await passoPermitido(ctx, passoId);
    if (!p) return { ok: false as const, erro: "Passo não encontrado." };
    const r = await recriarTarefa(passoId);
    if (!r.ok) return r;
    revalidar(p.cliente_id);
    return { ok: true as const };
  });
}

export async function cancelarTrilha(trilhaId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("clientes.gerenciar");
    if (!idSchema.safeParse(trilhaId).success) return { ok: false as const, erro: "Trilha inválida." };
    const db = createAdminClient();
    const { data } = await db.from("agencia_trilhas").select("cliente_id").eq("id", trilhaId).eq("situacao", "ativa").maybeSingle();
    const clienteId = (data as { cliente_id?: string } | null)?.cliente_id;
    if (!clienteId || !(await alcancaCliente(ctx, clienteId))) return { ok: false as const, erro: "Trilha não encontrada." };
    // As tarefas já criadas ficam no quadro: cancelar a trilha não apaga trabalho.
    await db.from("agencia_trilhas").update({ situacao: "cancelada" }).eq("id", trilhaId);
    await auditarAgencia("agencia.trilha_cancelada", ctx.user.id, { tipo: "agencia_trilha", id: trilhaId });
    revalidar(clienteId);
    return { ok: true as const };
  });
}

// ── Modelos ────────────────────────────────────────────────────────────────

const passoDoModeloSchema = z.object({
  chave: z.string().trim().regex(/^[a-z0-9_]{2,40}$/, "Chave: letras minúsculas, números e _ (2 a 40)."),
  etapa: z.number().int().min(1).max(9),
  ordem: z.number().int().min(0).max(999),
  titulo: z.string().trim().min(2, "Dê um título a cada passo.").max(200),
  descricao: z.string().trim().max(2000).nullable(),
  tipo: z.enum(TIPOS_DE_PASSO),
  reuniaoTipo: z.enum(TIPOS_DE_REUNIAO).nullable(),
  funcaoId: z.string().uuid().nullable(),
  dependeDe: z.array(z.string()).max(30),
  regra: z.enum(REGRAS_DE_PRAZO),
  dias: z.number().int().min(0).max(365).nullable(),
  ancora: z.string().nullable(),
  checklist: z.array(z.string().trim().min(1).max(300)).max(50),
  executor: z.enum(["humano", "ia"]),
});

const modeloSchema = z.object({
  id: z.string().uuid().optional(),
  nome: z.string().trim().min(2, "Dê um nome ao modelo.").max(80),
  tipo: z.enum(["recorrente", "avulsa"]),
  ativo: z.boolean(),
  passos: z.array(passoDoModeloSchema).min(1, "O modelo precisa de pelo menos um passo.").max(100),
});
export type EntradaDoModelo = z.input<typeof modeloSchema>;

/**
 * Salva o modelo inteiro. As trilhas que já começaram não mudam (R1): elas
 * guardam a própria cópia dos passos.
 */
export async function salvarModeloDeTrilha(entrada: EntradaDoModelo): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("trilhas.gerenciar");
    const p = modeloSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    const problema = problemaNoModelo(
      d.passos.map((x) => ({
        chave: x.chave,
        titulo: x.titulo,
        tipo: x.tipo,
        reuniaoTipo: x.reuniaoTipo,
        dependeDe: x.dependeDe,
        regra: x.regra,
        ancora: x.ancora,
      })),
    );
    if (problema) return { ok: false as const, erro: problema };

    const db = createAdminClient();
    let id = d.id;
    if (id) {
      const { error } = await db.from("agencia_trilha_modelos").update({ nome: d.nome, tipo: d.tipo, ativo: d.ativo }).eq("id", id);
      if (error?.code === "23505") return { ok: false as const, erro: "Já existe um modelo com esse nome." };
      if (error) return { ok: false as const, erro: "Não deu para salvar o modelo." };
    } else {
      const { data, error } = await db.from("agencia_trilha_modelos").insert({ nome: d.nome, tipo: d.tipo, ativo: d.ativo }).select("id").single();
      if (error?.code === "23505") return { ok: false as const, erro: "Já existe um modelo com esse nome." };
      if (error || !data) return { ok: false as const, erro: "Não deu para criar o modelo." };
      id = (data as { id: string }).id;
    }
    await db.from("agencia_trilha_modelo_passos").delete().eq("modelo_id", id);
    const { error: erroDosPassos } = await db.from("agencia_trilha_modelo_passos").insert(
      d.passos.map((x) => ({
        modelo_id: id,
        chave: x.chave,
        etapa: x.etapa,
        ordem: x.ordem,
        titulo: x.titulo,
        descricao: x.descricao || null,
        tipo: x.tipo,
        reuniao_tipo: x.tipo === "reuniao" ? x.reuniaoTipo : null,
        funcao_id: x.tipo === "tarefa" ? x.funcaoId : null,
        depende_de: x.dependeDe,
        prazo_regra: x.regra,
        prazo_dias: x.regra === "apos_liberar" || x.regra === "apos_ancora" ? (x.dias ?? 0) : null,
        prazo_ancora: x.regra === "apos_ancora" ? x.ancora : null,
        checklist: x.tipo === "tarefa" ? x.checklist : [],
        executor: x.executor,
      })),
    );
    if (erroDosPassos) return { ok: false as const, erro: "Não deu para salvar os passos do modelo." };
    await auditarAgencia("agencia.trilha_modelo_alterado", ctx.user.id, { tipo: "agencia_trilha_modelo", id: id! }, {
      passos: d.passos.length,
      novo: !d.id,
    });
    revalidatePath("/agencia/trilhas/modelos");
    return { ok: true as const, dados: { id: id! } };
  });
}
