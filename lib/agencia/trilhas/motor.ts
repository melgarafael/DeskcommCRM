/**
 * O motor da trilha do cliente (docs/agencia/SPEC-trilhas.md, R1–R9).
 *
 * Toda mudança de estado passa por `avancar`, que é idempotente: libera os
 * passos cujas dependências estão feitas, transforma cada passo de tarefa
 * liberado numa tarefa do quadro (uma vez — `tarefa_id`), calcula os prazos que
 * passaram a ser conhecidos e fecha a trilha quando tudo terminou. Chamar duas
 * vezes seguidas não cria nada em dobro.
 *
 * Quem chama (as ações de tarefas, reuniões e da trilha) já conferiu a
 * permissão; aqui só o servidor fala com o banco.
 */
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import { aoApagarTarefaDoMapa, aoMudarTarefaDoMapa } from "../mapas/motor";
import { diaDe, instanteDoDia } from "../calendario/regras";
import {
  antecessores,
  calendarioDoContrato,
  passosQueLiberam,
  prazoDoPasso,
  responsaveisDoPasso,
} from "./regras";
import {
  CHAVE_ASSINOU_PAGOU,
  HORA_DO_PRAZO,
  SITUACOES_FEITAS,
  type RegraDePrazo,
  type SituacaoDoPasso,
  type TipoDePasso,
} from "./vocabulario";

export interface LinhaDoPasso {
  id: string;
  trilha_id: string;
  chave: string;
  etapa: number;
  ordem: number;
  titulo: string;
  descricao: string | null;
  tipo: TipoDePasso;
  reuniao_tipo: string | null;
  funcao_id: string | null;
  depende_de: string[];
  prazo_regra: RegraDePrazo;
  prazo_dias: number | null;
  prazo_ancora: string | null;
  checklist: string[];
  executor: "humano" | "ia";
  situacao: SituacaoDoPasso;
  prazo: string | null;
  tarefa_id: string | null;
  reuniao_id: string | null;
  liberado_em: string | null;
  concluido_em: string | null;
}

interface LinhaDaTrilha {
  id: string;
  cliente_id: string;
  contratacao_id: string | null;
  situacao: string;
  assinou_pagou_em: string | null;
  preparacao_fim: string | null;
}

const db = () => createAdminClient();

async function lerTrilha(trilhaId: string): Promise<{ trilha: LinhaDaTrilha; passos: LinhaDoPasso[] } | null> {
  const [{ data: t }, { data: p }] = await Promise.all([
    db().from("agencia_trilhas").select("id, cliente_id, contratacao_id, situacao, assinou_pagou_em, preparacao_fim").eq("id", trilhaId).maybeSingle(),
    db().from("agencia_trilha_passos").select("*").eq("trilha_id", trilhaId).order("etapa").order("ordem"),
  ]);
  if (!t) return null;
  return { trilha: t as LinhaDaTrilha, passos: (p ?? []) as LinhaDoPasso[] };
}

/** O instante que serve de âncora para o prazo de outro passo: a reunião dele, ou quando foi concluído. */
async function instantesDasAncoras(passos: readonly LinhaDoPasso[]): Promise<Map<string, Date>> {
  const reunioes = passos.filter((p) => p.reuniao_id).map((p) => p.reuniao_id!);
  const { data } = reunioes.length
    ? await db().from("agencia_reunioes").select("id, inicio, situacao").in("id", reunioes)
    : { data: [] };
  const inicioDa = new Map(((data ?? []) as Array<{ id: string; inicio: string; situacao: string }>).filter((r) => r.situacao !== "cancelada").map((r) => [r.id, r.inicio]));
  const mapa = new Map<string, Date>();
  for (const p of passos) {
    const daReuniao = p.reuniao_id ? inicioDa.get(p.reuniao_id) : undefined;
    if (daReuniao) mapa.set(p.chave, new Date(daReuniao));
    else if (p.concluido_em) mapa.set(p.chave, new Date(p.concluido_em));
  }
  return mapa;
}

async function nomeDoCliente(clienteId: string): Promise<string | null> {
  const { data } = await db().from("agencia_clientes").select("nome").eq("id", clienteId).maybeSingle();
  return (data as { nome?: string } | null)?.nome ?? null;
}

/** A equipe do cliente com as funções de cada um (R7). */
async function equipeDoCliente(clienteId: string): Promise<Array<{ membroId: string; funcoes: string[] }>> {
  const { data } = await db()
    .from("agencia_clientes_membros")
    .select("membro_id, agencia_membros!inner(situacao, agencia_membros_funcoes(funcao_id))")
    .eq("cliente_id", clienteId)
    .eq("agencia_membros.situacao", "ativo");
  return ((data ?? []) as unknown as Array<{
    membro_id: string;
    agencia_membros: { agencia_membros_funcoes: Array<{ funcao_id: string }> | null } | null;
  }>).map((r) => ({
    membroId: r.membro_id,
    funcoes: (r.agencia_membros?.agencia_membros_funcoes ?? []).map((f) => f.funcao_id),
  }));
}

async function membrosDaFuncao(funcaoId: string): Promise<string[]> {
  const { data } = await db()
    .from("agencia_membros_funcoes")
    .select("membro_id, agencia_membros!inner(situacao)")
    .eq("funcao_id", funcaoId)
    .eq("agencia_membros.situacao", "ativo");
  return ((data ?? []) as Array<{ membro_id: string }>).map((r) => r.membro_id);
}

/** Cria a tarefa do quadro para um passo de tarefa liberado. Devolve o id, ou null se falhou. */
async function criarTarefaDoPasso(p: LinhaDoPasso, clienteId: string, clienteNome: string | null, prazo: string | null): Promise<string | null> {
  const banco = db();
  const { data: ultima } = await banco
    .from("agencia_tarefas")
    .select("posicao")
    .eq("coluna", "a_fazer")
    .order("posicao", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ultimaPosicao = (ultima as { posicao?: number | string } | null)?.posicao;
  const calculada = midpoint(ultimaPosicao === undefined ? null : Number(ultimaPosicao), null);
  const { data, error } = await banco
    .from("agencia_tarefas")
    .insert({
      titulo: p.titulo,
      descricao: p.descricao,
      coluna: "a_fazer",
      posicao: Number.isFinite(calculada) ? calculada : Date.now() / 1000,
      prioridade: "media",
      prazo,
      cliente_id: clienteId,
      funcao_id: p.funcao_id,
      executor: p.executor,
    })
    .select("id")
    .single();
  if (error || !data) {
    logger.warn("agência: tarefa do passo da trilha não gravou", { passo: p.id, codigo: error?.code });
    return null;
  }
  const tarefaId = (data as { id: string }).id;
  const responsaveis = responsaveisDoPasso(p.funcao_id, await equipeDoCliente(clienteId));
  if (responsaveis.length) {
    await banco.from("agencia_tarefas_responsaveis").insert(responsaveis.map((membro_id) => ({ tarefa_id: tarefaId, membro_id })));
  }
  if (p.checklist.length) {
    await banco.from("agencia_tarefas_checklist").insert(p.checklist.map((texto, ordem) => ({ tarefa_id: tarefaId, texto, ordem })));
  }
  const alvos = responsaveis.length ? responsaveis : p.funcao_id ? await membrosDaFuncao(p.funcao_id) : [];
  if (alvos.length) {
    await criarAviso({
      alvo: { tipo: "membros", ids: alvos },
      tipo: "tarefa_atribuida",
      titulo: clienteNome ? `${p.titulo} — ${clienteNome}` : p.titulo,
      corpo: "Liberada na trilha do cliente.",
      link: `/agencia/tarefas?abrir=${tarefaId}`,
      referenciaId: tarefaId,
    });
  }
  return tarefaId;
}

/**
 * Libera o que pode ser liberado, materializa as tarefas, recalcula prazos e
 * fecha a trilha quando tudo terminou. Idempotente.
 */
export async function avancar(trilhaId: string): Promise<{ liberados: number }> {
  let liberados = 0;
  // Um passo liberado pode ser concluído na hora (nunca, hoje) — o laço tem teto por segurança.
  for (let volta = 0; volta < 50; volta++) {
    const lido = await lerTrilha(trilhaId);
    if (!lido || lido.trilha.situacao !== "ativa") return { liberados };
    const { trilha, passos } = lido;
    const ancoras = await instantesDasAncoras(passos);
    const agora = new Date();
    const clienteNome = await nomeDoCliente(trilha.cliente_id);
    const prazoDe = (p: LinhaDoPasso, liberadoEm: Date) =>
      prazoDoPasso(
        { regra: p.prazo_regra, dias: p.prazo_dias, ancora: p.prazo_ancora },
        { liberadoEm, instanteDaAncora: (c) => ancoras.get(c) ?? null, preparacaoFim: trilha.preparacao_fim },
      );

    // 1. Prazos que passaram a ser conhecidos (âncora marcada, contrato assinado) nos passos abertos.
    for (const p of passos.filter((x) => !SITUACOES_FEITAS.includes(x.situacao) && x.situacao !== "bloqueado" && !x.prazo)) {
      const prazo = prazoDe(p, p.liberado_em ? new Date(p.liberado_em) : agora);
      if (!prazo) continue;
      await db().from("agencia_trilha_passos").update({ prazo: prazo.toISOString() }).eq("id", p.id);
      if (p.tarefa_id) await db().from("agencia_tarefas").update({ prazo: prazo.toISOString() }).eq("id", p.tarefa_id).is("prazo", null);
    }

    // 2. O que libera agora.
    const chaves = passosQueLiberam(passos.map((p) => ({ chave: p.chave, situacao: p.situacao, dependeDe: p.depende_de })));
    if (chaves.length === 0) {
      const tudoFeito = passos.length > 0 && passos.every((p) => SITUACOES_FEITAS.includes(p.situacao));
      if (tudoFeito) {
        await db().from("agencia_trilhas").update({ situacao: "concluida", concluida_em: agora.toISOString() }).eq("id", trilhaId).eq("situacao", "ativa");
      }
      return { liberados };
    }

    for (const p of passos.filter((x) => chaves.includes(x.chave))) {
      const prazo = prazoDe(p, agora);
      // Reserva a liberação: só quem mudar de 'bloqueado' segue (dois avanços juntos não duplicam a tarefa).
      const { data: reservado } = await db()
        .from("agencia_trilha_passos")
        .update({
          // Reunião já ligada (o Fechamento que a Fase 3 marca junto) entra direto em andamento.
          situacao: p.reuniao_id ? "em_andamento" : "liberado",
          liberado_em: agora.toISOString(),
          prazo: prazo?.toISOString() ?? null,
        })
        .eq("id", p.id)
        .eq("situacao", "bloqueado")
        .select("id");
      if (!reservado?.length) continue;
      liberados++;
      if (p.tipo === "tarefa" && !p.tarefa_id) {
        const tarefaId = await criarTarefaDoPasso(p, trilha.cliente_id, clienteNome, prazo?.toISOString() ?? null);
        if (tarefaId) await db().from("agencia_trilha_passos").update({ tarefa_id: tarefaId }).eq("id", p.id);
      } else if (!p.reuniao_id) {
        // Reunião por marcar ou marco por confirmar: quem cuida dos avisos gerais fica sabendo.
        await criarAviso({
          alvo: { tipo: "gerais" },
          tipo: "etapa_liberada",
          titulo: `${p.tipo === "reuniao" ? "Marcar: " : "Aguardando: "}${p.titulo}${clienteNome ? ` — ${clienteNome}` : ""}`,
          link: `/agencia/clientes/${trilha.cliente_id}?aba=trilha`,
          referenciaId: p.id,
        });
      }
    }
  }
  return { liberados };
}

// ── Ações sobre a trilha ───────────────────────────────────────────────────

export async function iniciarTrilha(p: {
  clienteId: string;
  modeloId: string;
  contratacaoId: string | null;
  aPartirDe: string | null;
  userId: string;
}): Promise<{ ok: true; trilhaId: string } | { ok: false; erro: string }> {
  const banco = db();
  const [{ data: modelo }, { data: passosDoModelo }] = await Promise.all([
    banco.from("agencia_trilha_modelos").select("id, nome, ativo").eq("id", p.modeloId).maybeSingle(),
    banco.from("agencia_trilha_modelo_passos").select("*").eq("modelo_id", p.modeloId).order("etapa").order("ordem"),
  ]);
  const m = modelo as { id: string; nome: string; ativo: boolean } | null;
  if (!m || !m.ativo) return { ok: false, erro: "Modelo de trilha não encontrado." };
  const modelos = (passosDoModelo ?? []) as Array<Omit<LinhaDoPasso, "trilha_id" | "situacao" | "prazo" | "tarefa_id" | "reuniao_id" | "liberado_em" | "concluido_em"> & { modelo_id: string }>;
  if (modelos.length === 0) return { ok: false, erro: "Esse modelo não tem passos." };
  if (p.aPartirDe && !modelos.some((x) => x.chave === p.aPartirDe)) return { ok: false, erro: "Passo de partida inválido." };

  const { data: nova, error } = await banco
    .from("agencia_trilhas")
    .insert({ cliente_id: p.clienteId, contratacao_id: p.contratacaoId, modelo_id: m.id, modelo_nome: m.nome, criada_por: p.userId })
    .select("id")
    .single();
  if (error?.code === "23505") return { ok: false, erro: "Esse cliente já tem uma trilha em andamento." };
  if (error || !nova) return { ok: false, erro: "Não deu para iniciar a trilha." };
  const trilhaId = (nova as { id: string }).id;

  const pular = p.aPartirDe
    ? antecessores(modelos.map((x) => ({ chave: x.chave, situacao: "bloqueado" as const, dependeDe: x.depende_de })), p.aPartirDe)
    : new Set<string>();
  const agora = new Date().toISOString();
  const { error: erroDosPassos } = await banco.from("agencia_trilha_passos").insert(
    modelos.map((x) => ({
      trilha_id: trilhaId,
      chave: x.chave,
      etapa: x.etapa,
      ordem: x.ordem,
      titulo: x.titulo,
      descricao: x.descricao,
      tipo: x.tipo,
      reuniao_tipo: x.reuniao_tipo,
      funcao_id: x.funcao_id,
      depende_de: x.depende_de,
      prazo_regra: x.prazo_regra,
      prazo_dias: x.prazo_dias,
      prazo_ancora: x.prazo_ancora,
      checklist: x.checklist,
      executor: x.executor,
      situacao: pular.has(x.chave) ? "pulado" : "bloqueado",
      concluido_em: pular.has(x.chave) ? agora : null,
    })),
  );
  if (erroDosPassos) {
    await banco.from("agencia_trilhas").delete().eq("id", trilhaId);
    return { ok: false, erro: "Não deu para copiar os passos do modelo." };
  }
  await avancar(trilhaId);
  return { ok: true, trilhaId };
}

/** Lê um passo com a trilha dele. */
export async function lerPasso(passoId: string): Promise<(LinhaDoPasso & { cliente_id: string; trilha_situacao: string }) | null> {
  const { data } = await db().from("agencia_trilha_passos").select("*, agencia_trilhas!inner(cliente_id, situacao)").eq("id", passoId).maybeSingle();
  const l = data as (LinhaDoPasso & { agencia_trilhas: { cliente_id: string; situacao: string } }) | null;
  return l ? { ...l, cliente_id: l.agencia_trilhas.cliente_id, trilha_situacao: l.agencia_trilhas.situacao } : null;
}

/**
 * Conclui à mão (o marco, ou uma reunião que aconteceu fora do calendário).
 * `dia` (AAAA-MM-DD) é quando aconteceu; o "assinado e pago" liga a regra do dia 15.
 */
export async function concluirPasso(passoId: string, dia: string | null, userId: string | null): Promise<{ ok: true } | { ok: false; erro: string }> {
  const p = await lerPasso(passoId);
  if (!p || p.trilha_situacao !== "ativa") return { ok: false, erro: "Passo não encontrado." };
  if (p.situacao === "bloqueado") return { ok: false, erro: "Esse passo ainda está bloqueado." };
  if (SITUACOES_FEITAS.includes(p.situacao)) return { ok: true };
  if (p.tipo === "tarefa") return { ok: false, erro: "Conclua a tarefa no quadro; o passo acompanha." };
  const quando = dia ? instanteDoDia(dia, HORA_DO_PRAZO) : new Date();
  if (quando.getTime() > Date.now() + 86_400_000) return { ok: false, erro: "A data não pode ser no futuro." };

  const banco = db();
  await banco
    .from("agencia_trilha_passos")
    .update({ situacao: "concluido", concluido_em: quando.toISOString(), concluido_por: userId })
    .eq("id", passoId);

  if (p.chave === CHAVE_ASSINOU_PAGOU) {
    const c = calendarioDoContrato(diaDe(quando.toISOString()));
    await banco
      .from("agencia_trilhas")
      .update({
        assinou_pagou_em: diaDe(quando.toISOString()),
        contrato_inicio: c.inicio,
        contrato_fim: c.fimMinimo,
        preparacao_fim: c.preparacaoFim,
      })
      .eq("id", p.trilha_id);
    // A contratação ganha as datas quando ainda não as tem.
    const { data: t } = await banco.from("agencia_trilhas").select("contratacao_id").eq("id", p.trilha_id).maybeSingle();
    const contratacaoId = (t as { contratacao_id: string | null } | null)?.contratacao_id;
    if (contratacaoId) {
      await banco.from("agencia_contratacoes").update({ inicio: c.inicio }).eq("id", contratacaoId).is("inicio", null);
      await banco.from("agencia_contratacoes").update({ fim: c.fimMinimo }).eq("id", contratacaoId).is("fim", null);
    }
  }
  await avancar(p.trilha_id);
  return { ok: true };
}

export async function pularPasso(passoId: string, userId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const p = await lerPasso(passoId);
  if (!p || p.trilha_situacao !== "ativa") return { ok: false, erro: "Passo não encontrado." };
  if (SITUACOES_FEITAS.includes(p.situacao)) return { ok: true };
  await db()
    .from("agencia_trilha_passos")
    .update({ situacao: "pulado", concluido_em: new Date().toISOString(), concluido_por: userId })
    .eq("id", passoId);
  await avancar(p.trilha_id);
  return { ok: true };
}

// ── Ganchos: o que acontece no quadro e no calendário volta para a trilha ──

const SITUACAO_DA_COLUNA: Record<string, SituacaoDoPasso> = {
  backlog: "liberado",
  a_fazer: "liberado",
  em_andamento: "em_andamento",
  revisao: "em_andamento",
  concluido: "concluido",
};

/**
 * A tarefa mudou de coluna (ou foi salva): o passo dela acompanha (R4). Nunca lança.
 * É também o gancho do mapa mental (SPEC-mapa-mental, M4) — um ponto só, já
 * chamado por todas as ações que mexem em tarefa.
 */
export async function aoMudarTarefa(tarefaId: string): Promise<void> {
  await aoMudarTarefaDoMapa(tarefaId);
  try {
    const { data } = await db()
      .from("agencia_trilha_passos")
      .select("id, trilha_id, situacao, agencia_tarefas!inner(coluna, concluida_em)")
      .eq("tarefa_id", tarefaId)
      .maybeSingle();
    const p = data as unknown as {
      id: string;
      trilha_id: string;
      situacao: SituacaoDoPasso;
      agencia_tarefas: { coluna: string; concluida_em: string | null };
    } | null;
    if (!p || p.situacao === "pulado") return;
    const nova = SITUACAO_DA_COLUNA[p.agencia_tarefas.coluna] ?? "liberado";
    if (nova === p.situacao) return;
    await db()
      .from("agencia_trilha_passos")
      .update({ situacao: nova, concluido_em: nova === "concluido" ? (p.agencia_tarefas.concluida_em ?? new Date().toISOString()) : null })
      .eq("id", p.id);
    if (nova === "concluido") await avancar(p.trilha_id);
  } catch (e) {
    logger.warn("agência: trilha não acompanhou a tarefa", { tarefaId, detalhe: e instanceof Error ? e.message : String(e) });
  }
}

/** A tarefa vai ser apagada: o passo volta a "liberado", sem tarefa, para poder ser recriada. */
export async function aoApagarTarefa(tarefaId: string): Promise<void> {
  await aoApagarTarefaDoMapa(tarefaId);
  await db()
    .from("agencia_trilha_passos")
    .update({ situacao: "liberado", tarefa_id: null, concluido_em: null })
    .eq("tarefa_id", tarefaId)
    .neq("situacao", "pulado");
}

/** Recria a tarefa de um passo liberado que ficou sem ela. */
export async function recriarTarefa(passoId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const p = await lerPasso(passoId);
  if (!p || p.tipo !== "tarefa" || p.tarefa_id || SITUACOES_FEITAS.includes(p.situacao) || p.situacao === "bloqueado") {
    return { ok: false, erro: "Esse passo não precisa de tarefa nova." };
  }
  const tarefaId = await criarTarefaDoPasso(p, p.cliente_id, await nomeDoCliente(p.cliente_id), p.prazo);
  if (!tarefaId) return { ok: false, erro: "Não deu para criar a tarefa." };
  await db().from("agencia_trilha_passos").update({ tarefa_id: tarefaId, situacao: "liberado" }).eq("id", passoId);
  return { ok: true };
}

/** Uma reunião foi marcada para o passo (pelo botão da trilha). */
export async function ligarReuniao(passoId: string, reuniaoId: string): Promise<void> {
  await db()
    .from("agencia_trilha_passos")
    .update({ reuniao_id: reuniaoId })
    .eq("id", passoId)
    .eq("tipo", "reuniao")
    .is("reuniao_id", null);
  await db().from("agencia_trilha_passos").update({ situacao: "em_andamento" }).eq("id", passoId).eq("situacao", "liberado");
  const p = await lerPasso(passoId);
  if (p) await avancar(p.trilha_id);
}

/**
 * O Fechamento que a Fase 3 marca junto com a Apresentação (K5) vai para o passo
 * de reunião de Fechamento da mesma trilha, se ele ainda não tem reunião.
 */
export async function ligarFechamentoAutomatico(passoDaApresentacao: string, fechamentoId: string): Promise<void> {
  const p = await lerPasso(passoDaApresentacao);
  if (!p) return;
  await db()
    .from("agencia_trilha_passos")
    .update({ reuniao_id: fechamentoId })
    .eq("trilha_id", p.trilha_id)
    .eq("tipo", "reuniao")
    .eq("reuniao_tipo", "fechamento")
    .is("reuniao_id", null);
}

/** A reunião mudou (realizada, cancelada, remarcada): o passo dela acompanha. Nunca lança. */
export async function aoMudarReuniao(reuniaoId: string): Promise<void> {
  try {
    const { data } = await db()
      .from("agencia_trilha_passos")
      .select("id, trilha_id, situacao, agencia_reunioes!inner(situacao, inicio)")
      .eq("reuniao_id", reuniaoId);
    for (const p of (data ?? []) as unknown as Array<{
      id: string;
      trilha_id: string;
      situacao: SituacaoDoPasso;
      agencia_reunioes: { situacao: string; inicio: string };
    }>) {
      if (p.situacao === "pulado") continue;
      const r = p.agencia_reunioes;
      if (r.situacao === "realizada") {
        if (p.situacao !== "concluido") {
          await db().from("agencia_trilha_passos").update({ situacao: "concluido", concluido_em: r.inicio }).eq("id", p.id);
        }
      } else if (r.situacao === "cancelada") {
        // Cancelou: o passo volta a pedir uma reunião.
        await db()
          .from("agencia_trilha_passos")
          .update({ reuniao_id: null, situacao: p.situacao === "bloqueado" ? "bloqueado" : "liberado", concluido_em: null })
          .eq("id", p.id);
      } else if (p.situacao === "liberado") {
        await db().from("agencia_trilha_passos").update({ situacao: "em_andamento" }).eq("id", p.id);
      }
      // A data da reunião é âncora de outros prazos (o Fechamento conta da Apresentação): recalcula.
      await db()
        .from("agencia_trilha_passos")
        .update({ prazo: null })
        .eq("trilha_id", p.trilha_id)
        .eq("prazo_regra", "apos_ancora")
        .in("situacao", ["liberado", "em_andamento"])
        .is("tarefa_id", null);
      await avancar(p.trilha_id);
    }
  } catch (e) {
    logger.warn("agência: trilha não acompanhou a reunião", { reuniaoId, detalhe: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Reunião marcada pelo calendário (não pelo botão da trilha): se o cliente tem
 * trilha ativa com um passo de reunião desse tipo ainda sem reunião, ela é
 * ligada a ele. Devolve o passo, ou null.
 */
export async function ligarAoPassoDaTrilha(clienteId: string, reuniaoTipo: string, reuniaoId: string): Promise<string | null> {
  const { data } = await db()
    .from("agencia_trilha_passos")
    .select("id, situacao, agencia_trilhas!inner(cliente_id, situacao)")
    .eq("agencia_trilhas.cliente_id", clienteId)
    .eq("agencia_trilhas.situacao", "ativa")
    .eq("tipo", "reuniao")
    .eq("reuniao_tipo", reuniaoTipo)
    .is("reuniao_id", null)
    .not("situacao", "in", "(concluido,pulado)")
    .order("etapa")
    .order("ordem")
    .limit(1);
  const passo = ((data ?? []) as Array<{ id: string }>)[0];
  if (!passo) return null;
  await ligarReuniao(passo.id, reuniaoId);
  return passo.id;
}
