"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { ACOES_DA_IA } from "@/lib/agencia/ia/catalogo";
import { aplicarProposta, executarTarefa, proporParaMapa } from "@/lib/agencia/ia/executor";
import { propostaSchema, type Proposta } from "@/lib/agencia/ia/proposta";
import { idSchema } from "@/lib/agencia/schemas";
import { carregarQuemOlha, carregarTarefa } from "@/lib/agencia/tarefas/consultas";
import { createAdminClient } from "@/lib/supabase/admin";

/** A IA da agência (docs/agencia/SPEC-ia-da-agencia.md). Propor e aplicar no mapa pedem `mapa.editar`; executar tarefa, `tarefas.criar` e enxergar a tarefa. */

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

async function mapaDaPessoa(mapaId: string) {
  const ctx = await exigirPermissao("mapa.editar");
  if (!idSchema.safeParse(mapaId).success) return { ctx, ok: false as const };
  const { data } = await createAdminClient().from("agencia_mapas").select("cliente_id").eq("id", mapaId).maybeSingle();
  const clienteId = (data as { cliente_id?: string } | null)?.cliente_id;
  return { ctx, ok: !!clienteId && podeVerCliente(await carregarAlcance(ctx), clienteId) };
}

export async function proporBlocosComIa(mapaId: string, pedido: string): Promise<ResultadoDaAcao<{ proposta: Proposta }>> {
  return seguro(async () => {
    const m = await mapaDaPessoa(mapaId);
    if (!m.ok) return { ok: false as const, erro: "Mapa não encontrado." };
    const texto = pedido.trim();
    if (texto.length < 10) return { ok: false as const, erro: "Escreva o que você quer no mapa (pelo menos uma frase)." };
    if (texto.length > 2000) return { ok: false as const, erro: "O pedido passou de 2.000 caracteres." };
    const r = await proporParaMapa(mapaId, texto, m.ctx.user.id);
    if (!r.ok) return r;
    await auditarAgencia("agencia.ia_executada", m.ctx.user.id, { tipo: "agencia_mapa", id: mapaId }, { acao: "propor_mapa", blocos: r.proposta.blocos.length });
    return { ok: true as const, dados: { proposta: r.proposta } };
  });
}

export async function aplicarPropostaDaIa(mapaId: string, proposta: unknown): Promise<ResultadoDaAcao<{ criados: number }>> {
  return seguro(async () => {
    const m = await mapaDaPessoa(mapaId);
    if (!m.ok) return { ok: false as const, erro: "Mapa não encontrado." };
    // A proposta volta do navegador: confere o formato de novo, nunca confia.
    const p = propostaSchema.safeParse(proposta);
    if (!p.success) return { ok: false as const, erro: "A proposta veio em formato inválido. Peça de novo." };
    const r = await aplicarProposta(mapaId, p.data);
    if (!r.ok) return r;
    await auditarAgencia("agencia.ia_proposta_aplicada", m.ctx.user.id, { tipo: "agencia_mapa", id: mapaId }, { blocos: r.criados });
    revalidatePath(`/agencia/mapas/${mapaId}`);
    return { ok: true as const, dados: { criados: r.criados } };
  });
}

const acaoSchema = z.enum(ACOES_DA_IA).nullable();

/** Escolhe o que a IA faz numa tarefa (ou tira, com null). */
export async function definirAcaoDaIa(tarefaId: string, acao: string | null): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    const a = acaoSchema.safeParse(acao);
    if (!idSchema.safeParse(tarefaId).success || !a.success) return { ok: false as const, erro: "Pedido inválido." };
    if (!(await carregarTarefa(tarefaId, await carregarQuemOlha(ctx)))) return { ok: false as const, erro: "Tarefa não encontrada." };
    await createAdminClient()
      .from("agencia_tarefas")
      .update({ acao_ia: a.data, executor: a.data ? "ia" : "humano", atualizada_em: new Date().toISOString() })
      .eq("id", tarefaId);
    revalidatePath("/agencia/tarefas");
    return { ok: true as const };
  });
}

export async function executarTarefaComIa(tarefaId: string): Promise<ResultadoDaAcao<{ resultado: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    if (!idSchema.safeParse(tarefaId).success) return { ok: false as const, erro: "Tarefa inválida." };
    if (!(await carregarTarefa(tarefaId, await carregarQuemOlha(ctx)))) return { ok: false as const, erro: "Tarefa não encontrada." };
    const r = await executarTarefa(tarefaId, ctx.user.id);
    if (!r.ok) return r;
    await auditarAgencia("agencia.ia_executada", ctx.user.id, { tipo: "agencia_tarefa", id: tarefaId }, {});
    revalidatePath("/agencia/tarefas");
    revalidatePath("/agencia/publicacoes");
    return { ok: true as const, dados: { resultado: r.resultado } };
  });
}
