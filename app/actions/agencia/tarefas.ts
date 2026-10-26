"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { contextoLiberado, exigirPermissao, type ContextoDaAgencia } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { criarAviso } from "@/lib/agencia/avisos/criar";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { carregarQuemOlha, carregarTarefa } from "@/lib/agencia/tarefas/consultas";
import { podePegar } from "@/lib/agencia/tarefas/regras";
import { COLUNAS, PRIORIDADES } from "@/lib/agencia/tarefas/vocabulario";
import { aoApagarTarefa, aoMudarTarefa } from "@/lib/agencia/trilhas/motor";
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Tarefas da agência (docs/agencia/SPEC-tarefas.md). Toda ação confere, no
 * servidor, se a pessoa pode ver a tarefa (T11) antes de mexer — o botão
 * escondido na tela não é a garantia.
 */

const tarefaSchema = z.object({
  id: z.string().uuid().optional(),
  titulo: z.string().trim().min(2, "Dê um título à tarefa.").max(200),
  descricao: z.string().trim().max(8000).nullable().optional(),
  coluna: z.enum(COLUNAS),
  prioridade: z.enum(PRIORIDADES),
  prazo: z.string().datetime({ offset: true }).nullable().optional(),
  clienteId: z.string().uuid().nullable(),
  funcaoId: z.string().uuid().nullable(),
  responsaveis: z.array(z.string().uuid()).max(20),
  etiquetas: z.array(z.string().uuid()).max(20),
  checklist: z.array(z.object({ texto: z.string().trim().min(1).max(300), feito: z.boolean() })).max(100),
  links: z
    .array(
      z.object({
        titulo: z.string().trim().min(1).max(120),
        url: z.string().trim().url("Link inválido.").refine((u) => /^https?:\/\//i.test(u), "O link precisa começar com http."),
      }),
    )
    .max(30),
  executor: z.enum(["humano", "ia"]),
});
export type EntradaDaTarefa = z.input<typeof tarefaSchema>;

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

function revalidar() {
  revalidatePath("/agencia/tarefas");
  revalidatePath("/agencia/trilhas");
  revalidatePath("/agencia");
}

/** Os membros ativos de uma função — o alvo do aviso de tarefa da função (T3). */
async function membrosDaFuncao(funcaoId: string): Promise<string[]> {
  const { data } = await createAdminClient()
    .from("agencia_membros_funcoes")
    .select("membro_id, agencia_membros!inner(situacao)")
    .eq("funcao_id", funcaoId)
    .eq("agencia_membros.situacao", "ativo");
  return ((data ?? []) as Array<{ membro_id: string }>).map((r) => r.membro_id);
}

async function avisarAtribuicao(
  ctx: ContextoDaAgencia,
  tarefaId: string,
  titulo: string,
  clienteNome: string | null,
  novos: string[],
): Promise<void> {
  const alvos = novos.filter((m) => m !== ctx.membro?.id);
  if (alvos.length === 0) return;
  await criarAviso({
    alvo: { tipo: "membros", ids: alvos },
    tipo: "tarefa_atribuida",
    titulo: clienteNome ? `${titulo} — ${clienteNome}` : titulo,
    corpo: "Você recebeu esta tarefa.",
    link: `/agencia/tarefas?abrir=${tarefaId}`,
    referenciaId: tarefaId,
  });
}

export async function salvarTarefa(entrada: EntradaDaTarefa): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    const p = tarefaSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    const quem = await carregarQuemOlha(ctx);
    const db = createAdminClient();

    // Mandar para outra pessoa ou para uma função exige `tarefas.atribuir`.
    const soEuMesmo = d.responsaveis.every((r) => r === ctx.membro?.id) && !d.funcaoId;
    if (!soEuMesmo && !ctx.permissoes.has("tarefas.atribuir")) {
      return { ok: false as const, erro: "Você não tem permissão para mandar tarefa para outras pessoas." };
    }
    if (d.clienteId && !quem.alcance.todos && !quem.alcance.ids.has(d.clienteId)) {
      return { ok: false as const, erro: "Você não atende esse cliente." };
    }

    let responsaveisAntes: string[] = [];
    let funcaoAntes: string | null = null;
    if (d.id) {
      const atual = await carregarTarefa(d.id, quem);
      if (!atual) return { ok: false as const, erro: "Tarefa não encontrada." };
      responsaveisAntes = atual.responsaveis;
      funcaoAntes = atual.funcaoId;
    }

    const linha = {
      titulo: d.titulo,
      descricao: d.descricao ?? null,
      coluna: d.coluna,
      prioridade: d.prioridade,
      prazo: d.prazo ?? null,
      cliente_id: d.clienteId,
      funcao_id: d.funcaoId,
      executor: d.executor,
      concluida_em: d.coluna === "concluido" ? new Date().toISOString() : null,
      atualizada_em: new Date().toISOString(),
    };

    let id = d.id;
    if (id) {
      const { error } = await db.from("agencia_tarefas").update(linha).eq("id", id);
      if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
      await auditarAgencia("agencia.tarefa_alterada", ctx.user.id, { tipo: "agencia_tarefa", id });
    } else {
      const { data: ultima } = await db
        .from("agencia_tarefas")
        .select("posicao")
        .eq("coluna", d.coluna)
        .order("posicao", { ascending: false })
        .limit(1)
        .maybeSingle();
      const ultimaPosicao = (ultima as { posicao?: number | string } | null)?.posicao;
      const posicao = midpoint(ultimaPosicao === undefined ? null : Number(ultimaPosicao), null);
      const { data, error } = await db
        .from("agencia_tarefas")
        .insert({ ...linha, posicao, criada_por: ctx.user.id })
        .select("id")
        .single();
      if (error || !data) {
        logger.error("agência: tarefa não gravou", { codigo: error?.code });
        return { ok: false as const, erro: "Não deu para criar. Tente de novo." };
      }
      id = (data as { id: string }).id;
      await auditarAgencia("agencia.tarefa_criada", ctx.user.id, { tipo: "agencia_tarefa", id });
    }

    // Filhos: troca o conjunto pelo informado.
    await Promise.all([
      db.from("agencia_tarefas_responsaveis").delete().eq("tarefa_id", id),
      db.from("agencia_tarefas_etiquetas").delete().eq("tarefa_id", id),
      db.from("agencia_tarefas_checklist").delete().eq("tarefa_id", id),
      db.from("agencia_tarefas_links").delete().eq("tarefa_id", id),
    ]);
    await Promise.all([
      d.responsaveis.length
        ? db.from("agencia_tarefas_responsaveis").insert(d.responsaveis.map((membro_id) => ({ tarefa_id: id, membro_id })))
        : null,
      d.etiquetas.length
        ? db.from("agencia_tarefas_etiquetas").insert(d.etiquetas.map((etiqueta_id) => ({ tarefa_id: id, etiqueta_id })))
        : null,
      d.checklist.length
        ? db.from("agencia_tarefas_checklist").insert(d.checklist.map((c, ordem) => ({ tarefa_id: id, texto: c.texto, feito: c.feito, ordem })))
        : null,
      d.links.length ? db.from("agencia_tarefas_links").insert(d.links.map((l) => ({ tarefa_id: id, ...l }))) : null,
    ]);

    // Avisos (T8): quem entrou agora como responsável; ou a função inteira.
    const clienteNome = d.clienteId
      ? (((await db.from("agencia_clientes").select("nome").eq("id", d.clienteId).maybeSingle()).data as { nome?: string } | null)?.nome ??
        null)
      : null;
    const novos = d.responsaveis.filter((r) => !responsaveisAntes.includes(r));
    const funcaoNova = d.funcaoId && d.responsaveis.length === 0 && d.funcaoId !== funcaoAntes;
    const alvos = funcaoNova ? await membrosDaFuncao(d.funcaoId!) : novos;
    if (alvos.length > 0) {
      await avisarAtribuicao(ctx, id!, d.titulo, clienteNome, alvos);
      await auditarAgencia("agencia.tarefa_atribuida", ctx.user.id, { tipo: "agencia_tarefa", id: id! }, {
        responsaveis: novos,
        funcao: funcaoNova ? d.funcaoId : null,
      });
    }

    // A trilha do cliente acompanha a tarefa (SPEC-trilhas, R4).
    await aoMudarTarefa(id!);
    revalidar();
    return { ok: true as const, dados: { id: id! } };
  });
}

/** Move o cartão para `coluna`, entre os cartões `antesDe` e `depoisDe` (ids, ou null nas pontas). */
export async function moverTarefa(
  id: string,
  coluna: string,
  vizinhos: { anterior: string | null; seguinte: string | null },
): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    const c = z.enum(COLUNAS).safeParse(coluna);
    if (!idSchema.safeParse(id).success || !c.success) return { ok: false as const, erro: "Movimento inválido." };
    const quem = await carregarQuemOlha(ctx);
    const atual = await carregarTarefa(id, quem);
    if (!atual) return { ok: false as const, erro: "Tarefa não encontrada." };
    const db = createAdminClient();
    const ids = [vizinhos.anterior, vizinhos.seguinte].filter((x): x is string => !!x && idSchema.safeParse(x).success);
    const { data } = ids.length ? await db.from("agencia_tarefas").select("id, posicao").in("id", ids) : { data: [] };
    const pos = new Map(((data ?? []) as Array<{ id: string; posicao: number }>).map((r) => [r.id, Number(r.posicao)]));
    const antes = vizinhos.anterior ? (pos.get(vizinhos.anterior) ?? null) : null;
    const depois = vizinhos.seguinte ? (pos.get(vizinhos.seguinte) ?? null) : null;
    const calculada = midpoint(antes, depois);
    // Dois vizinhos com a mesma posição: o midpoint devolve NaN. Encosta depois do anterior.
    const posicao = Number.isFinite(calculada) ? calculada : (antes ?? depois ?? 0) + 0.001;
    const concluiu = c.data === "concluido" && atual.coluna !== "concluido";
    const { error } = await db
      .from("agencia_tarefas")
      .update({
        coluna: c.data,
        posicao,
        concluida_em: c.data === "concluido" ? (atual.concluidaEm ?? new Date().toISOString()) : null,
        atualizada_em: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) return { ok: false as const, erro: "Não deu para mover." };
    if (concluiu) {
      // Concluir para o cronômetro de quem estava medindo.
      await db.from("agencia_tarefas_tempo").update({ fim: new Date().toISOString() }).eq("tarefa_id", id).is("fim", null);
    }
    await auditarAgencia(concluiu ? "agencia.tarefa_concluida" : "agencia.tarefa_movida", ctx.user.id, { tipo: "agencia_tarefa", id }, {
      de: atual.coluna,
      para: c.data,
    });
    await aoMudarTarefa(id);
    revalidar();
    return { ok: true as const };
  });
}

/** "Pegar" a tarefa da função (T3): quem pega vira o responsável. */
export async function pegarTarefa(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    if (!ctx.membro) return { ok: false as const, erro: "Ative seu perfil de membro em Perfil para pegar tarefas." };
    const quem = await carregarQuemOlha(ctx);
    const atual = await carregarTarefa(id, quem);
    if (!atual || !podePegar(quem, atual)) return { ok: false as const, erro: "Essa tarefa já tem responsável." };
    const { error } = await createAdminClient()
      .from("agencia_tarefas_responsaveis")
      .insert({ tarefa_id: id, membro_id: ctx.membro.id });
    if (error) return { ok: false as const, erro: "Não deu para pegar a tarefa." };
    await auditarAgencia("agencia.tarefa_atribuida", ctx.user.id, { tipo: "agencia_tarefa", id }, { pegou: ctx.membro.id });
    revalidar();
    return { ok: true as const };
  });
}

/** "Criar tarefas em lote" (T5): cada item não feito do checklist vira uma tarefa. */
export async function criarEmLote(id: string): Promise<ResultadoDaAcao<{ criadas: number }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    const quem = await carregarQuemOlha(ctx);
    const t = await carregarTarefa(id, quem);
    if (!t) return { ok: false as const, erro: "Tarefa não encontrada." };
    const itens = t.checklist.filter((c) => !c.feito);
    if (itens.length === 0) return { ok: false as const, erro: "O checklist não tem itens em aberto." };
    let criadas = 0;
    for (const item of itens) {
      const r = await salvarTarefa({
        titulo: item.texto,
        descricao: null,
        coluna: t.coluna === "concluido" ? "a_fazer" : t.coluna,
        prioridade: t.prioridade,
        prazo: t.prazo,
        clienteId: t.clienteId,
        funcaoId: t.funcaoId,
        responsaveis: t.responsaveis,
        etiquetas: t.etiquetas,
        checklist: [],
        links: [],
        executor: t.executor,
      });
      if (r.ok) criadas++;
    }
    await auditarAgencia("agencia.tarefas_em_lote", ctx.user.id, { tipo: "agencia_tarefa", id }, { criadas });
    revalidar();
    return { ok: true as const, dados: { criadas } };
  });
}

export async function excluirTarefa(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.atribuir");
    const quem = await carregarQuemOlha(ctx);
    if (!(await carregarTarefa(id, quem))) return { ok: false as const, erro: "Tarefa não encontrada." };
    // O passo da trilha volta a pedir uma tarefa, em vez de ficar ligado a nada.
    await aoApagarTarefa(id);
    const { error } = await createAdminClient().from("agencia_tarefas").delete().eq("id", id);
    if (error) return { ok: false as const, erro: "Não deu para excluir." };
    await auditarAgencia("agencia.tarefa_alterada", ctx.user.id, { tipo: "agencia_tarefa", id }, { excluida: true });
    revalidar();
    return { ok: true as const };
  });
}

export async function criarEtiqueta(nome: string, cor: string): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    await exigirPermissao("tarefas.criar");
    const p = z
      .object({ nome: z.string().trim().min(1).max(40), cor: z.string().regex(/^#[0-9a-fA-F]{6}$/) })
      .safeParse({ nome, cor });
    if (!p.success) return { ok: false as const, erro: "Etiqueta inválida." };
    const db = createAdminClient();
    const { data, error } = await db.from("agencia_etiquetas").insert(p.data).select("id").single();
    if (error?.code === "23505") {
      const { data: existe } = await db.from("agencia_etiquetas").select("id").eq("nome", p.data.nome).maybeSingle();
      if (existe) return { ok: true as const, dados: { id: (existe as { id: string }).id } };
    }
    if (error || !data) return { ok: false as const, erro: "Não deu para criar a etiqueta." };
    return { ok: true as const, dados: { id: (data as { id: string }).id } };
  });
}

// ── Cronômetro (T4) ────────────────────────────────────────────────────────

async function membroQueMede(): Promise<{ ctx: ContextoDaAgencia; membroId: string } | { ok: false; erro: string }> {
  const ctx = await exigirPermissao("tarefas.criar");
  if (!ctx.membro) return { ok: false, erro: "Ative seu perfil de membro em Perfil para usar o cronômetro." };
  return { ctx, membroId: ctx.membro.id };
}

export async function iniciarCronometro(tarefaId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const m = await membroQueMede();
    if ("ok" in m) return m;
    const quem = await carregarQuemOlha(m.ctx);
    if (!(await carregarTarefa(tarefaId, quem))) return { ok: false as const, erro: "Tarefa não encontrada." };
    const db = createAdminClient();
    const agora = new Date().toISOString();
    // Um cronômetro por pessoa: o que estiver rodando em outra tarefa para aqui.
    await db.from("agencia_tarefas_tempo").update({ fim: agora }).eq("membro_id", m.membroId).is("fim", null);
    const { error } = await db.from("agencia_tarefas_tempo").insert({ tarefa_id: tarefaId, membro_id: m.membroId, inicio: agora });
    if (error) return { ok: false as const, erro: "Não deu para iniciar o cronômetro." };
    revalidar();
    return { ok: true as const };
  });
}

export async function pausarCronometro(): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const m = await membroQueMede();
    if ("ok" in m) return m;
    await createAdminClient()
      .from("agencia_tarefas_tempo")
      .update({ fim: new Date().toISOString() })
      .eq("membro_id", m.membroId)
      .is("fim", null);
    revalidar();
    return { ok: true as const };
  });
}

export async function lancarTempo(tarefaId: string, minutos: number): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const m = await membroQueMede();
    if ("ok" in m) return m;
    const p = z.number().int().min(1).max(24 * 60).safeParse(minutos);
    if (!p.success) return { ok: false as const, erro: "Informe entre 1 minuto e 24 horas." };
    const quem = await carregarQuemOlha(m.ctx);
    if (!(await carregarTarefa(tarefaId, quem))) return { ok: false as const, erro: "Tarefa não encontrada." };
    const fim = new Date();
    const inicio = new Date(fim.getTime() - p.data * 60_000);
    const { error } = await createAdminClient().from("agencia_tarefas_tempo").insert({
      tarefa_id: tarefaId,
      membro_id: m.membroId,
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
      manual: true,
    });
    if (error) return { ok: false as const, erro: "Não deu para lançar o tempo." };
    revalidar();
    return { ok: true as const };
  });
}

/** A tarefa completa para o modal — lida pelo servidor (cookie HttpOnly). */
export async function abrirTarefa(id: string) {
  if (!idSchema.safeParse(id).success) return null;
  const ctx = await contextoLiberado();
  if (!ctx) return null;
  return carregarTarefa(id, await carregarQuemOlha(ctx));
}
