/**
 * Leitura das tarefas no servidor, já filtrada pelo que a pessoa pode ver (T11).
 * O volume de uma agência é pequeno; a regra roda em TypeScript sobre o
 * conjunto aberto + o concluído recente, sem duplicar `podeVerTarefa` em SQL.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import type { ContextoDaAgencia } from "../acesso";
import { carregarAlcance } from "../clientes/visibilidade";
import { podePegar, podeVerTarefa, tempoTotalSegundos, type QuemOlha } from "./regras";
import type { Coluna, Prioridade } from "./vocabulario";

export async function carregarQuemOlha(ctx: ContextoDaAgencia): Promise<QuemOlha> {
  const [alcance, funcoes] = await Promise.all([
    carregarAlcance(ctx),
    ctx.membro
      ? createAdminClient().from("agencia_membros_funcoes").select("funcao_id").eq("membro_id", ctx.membro.id)
      : Promise.resolve({ data: [] as Array<{ funcao_id: string }> }),
  ]);
  return {
    verTodas: ctx.permissoes.has("tarefas.ver_todas"),
    membroId: ctx.membro?.id ?? null,
    funcoesIds: ((funcoes.data ?? []) as Array<{ funcao_id: string }>).map((f) => f.funcao_id),
    alcance,
  };
}

export interface TarefaDoQuadro {
  id: string;
  titulo: string;
  coluna: Coluna;
  posicao: number;
  prioridade: Prioridade;
  prazo: string | null;
  clienteId: string | null;
  clienteNome: string | null;
  funcaoId: string | null;
  responsaveis: string[];
  etiquetas: string[];
  checklistFeitos: number;
  checklistTotal: number;
  tempoSegundos: number;
  /** Quem está com o cronômetro rodando nesta tarefa agora. */
  rodandoPor: string[];
  podePegar: boolean;
  concluidaEm: string | null;
}

interface LinhaBruta {
  id: string;
  titulo: string;
  coluna: Coluna;
  posicao: number | string;
  prioridade: Prioridade;
  prazo: string | null;
  cliente_id: string | null;
  funcao_id: string | null;
  concluida_em: string | null;
  agencia_clientes: { nome: string } | Array<{ nome: string }> | null;
  agencia_tarefas_responsaveis: Array<{ membro_id: string }> | null;
  agencia_tarefas_etiquetas: Array<{ etiqueta_id: string }> | null;
  agencia_tarefas_checklist: Array<{ feito: boolean }> | null;
  agencia_tarefas_tempo: Array<{ membro_id: string; inicio: string; fim: string | null }> | null;
}

const SELECAO =
  "id, titulo, coluna, posicao, prioridade, prazo, cliente_id, funcao_id, concluida_em, " +
  "agencia_clientes(nome), agencia_tarefas_responsaveis(membro_id), agencia_tarefas_etiquetas(etiqueta_id), " +
  "agencia_tarefas_checklist(feito), agencia_tarefas_tempo(membro_id, inicio, fim)";

function paraQuadro(l: LinhaBruta, quem: QuemOlha, agora: Date): TarefaDoQuadro {
  const cliente = Array.isArray(l.agencia_clientes) ? l.agencia_clientes[0] : l.agencia_clientes;
  const responsaveis = (l.agencia_tarefas_responsaveis ?? []).map((r) => r.membro_id);
  const checklist = l.agencia_tarefas_checklist ?? [];
  const tempo = l.agencia_tarefas_tempo ?? [];
  return {
    id: l.id,
    titulo: l.titulo,
    coluna: l.coluna,
    posicao: Number(l.posicao),
    prioridade: l.prioridade,
    prazo: l.prazo,
    clienteId: l.cliente_id,
    clienteNome: cliente?.nome ?? null,
    funcaoId: l.funcao_id,
    responsaveis,
    etiquetas: (l.agencia_tarefas_etiquetas ?? []).map((e) => e.etiqueta_id),
    checklistFeitos: checklist.filter((c) => c.feito).length,
    checklistTotal: checklist.length,
    tempoSegundos: tempoTotalSegundos(tempo, agora),
    rodandoPor: tempo.filter((t) => !t.fim).map((t) => t.membro_id),
    podePegar: podePegar(quem, { clienteId: l.cliente_id, funcaoId: l.funcao_id, responsaveis }),
    concluidaEm: l.concluida_em,
  };
}

/** As tarefas que a pessoa vê: todas as abertas + as concluídas nos últimos 30 dias. */
export async function listarTarefas(quem: QuemOlha, filtro: { clienteId?: string } = {}): Promise<TarefaDoQuadro[]> {
  const agora = new Date();
  const desde = new Date(agora.getTime() - 30 * 86_400_000).toISOString();
  let q = createAdminClient()
    .from("agencia_tarefas")
    .select(SELECAO)
    .or(`concluida_em.is.null,concluida_em.gte.${desde}`)
    .order("posicao", { ascending: true })
    .limit(2000);
  if (filtro.clienteId) q = q.eq("cliente_id", filtro.clienteId);
  const { data } = await q;
  return ((data ?? []) as unknown as LinhaBruta[])
    .filter((l) =>
      podeVerTarefa(quem, {
        clienteId: l.cliente_id,
        funcaoId: l.funcao_id,
        responsaveis: (l.agencia_tarefas_responsaveis ?? []).map((r) => r.membro_id),
      }),
    )
    .map((l) => paraQuadro(l, quem, agora));
}

export interface TarefaCompleta extends TarefaDoQuadro {
  descricao: string | null;
  executor: "humano" | "ia";
  /** A ação do catálogo da IA e o último resultado (SPEC-ia-da-agencia). */
  acaoIa: string | null;
  resultadoIa: string | null;
  checklist: Array<{ id: string; texto: string; feito: boolean }>;
  links: Array<{ id: string; titulo: string; url: string }>;
  arquivos: Array<{ id: string; nome: string; link: string; tamanho: number | null }>;
  sessoes: Array<{ membroId: string; inicio: string; fim: string | null; manual: boolean }>;
}

/** Uma tarefa com tudo, ou `null` quando não existe ou a pessoa não pode ver. */
export async function carregarTarefa(id: string, quem: QuemOlha): Promise<TarefaCompleta | null> {
  const db = createAdminClient();
  const { data } = await db.from("agencia_tarefas").select(`${SELECAO}, descricao, executor, acao_ia, resultado_ia`).eq("id", id).maybeSingle();
  const l = data as unknown as (LinhaBruta & { descricao: string | null; executor: "humano" | "ia"; acao_ia: string | null; resultado_ia: string | null }) | null;
  if (!l) return null;
  const responsaveis = (l.agencia_tarefas_responsaveis ?? []).map((r) => r.membro_id);
  if (!podeVerTarefa(quem, { clienteId: l.cliente_id, funcaoId: l.funcao_id, responsaveis })) return null;

  const [checklist, links, arquivos, sessoes] = await Promise.all([
    db.from("agencia_tarefas_checklist").select("id, texto, feito").eq("tarefa_id", id).order("ordem"),
    db.from("agencia_tarefas_links").select("id, titulo, url").eq("tarefa_id", id),
    db.from("agencia_arquivos").select("id, nome, link, tamanho_bytes").eq("tarefa_id", id).order("criado_em"),
    db.from("agencia_tarefas_tempo").select("membro_id, inicio, fim, manual").eq("tarefa_id", id).order("inicio"),
  ]);
  return {
    ...paraQuadro(l, quem, new Date()),
    descricao: l.descricao,
    executor: l.executor,
    acaoIa: l.acao_ia,
    resultadoIa: l.resultado_ia,
    checklist: (checklist.data ?? []) as TarefaCompleta["checklist"],
    links: (links.data ?? []) as TarefaCompleta["links"],
    arquivos: ((arquivos.data ?? []) as Array<{ id: string; nome: string; link: string; tamanho_bytes: number | null }>).map((a) => ({
      id: a.id,
      nome: a.nome,
      link: a.link,
      tamanho: a.tamanho_bytes,
    })),
    sessoes: ((sessoes.data ?? []) as Array<{ membro_id: string; inicio: string; fim: string | null; manual: boolean }>).map((s) => ({
      membroId: s.membro_id,
      inicio: s.inicio,
      fim: s.fim,
      manual: s.manual,
    })),
  };
}

/** Listas de apoio da tela: membros ativos, funções, etiquetas e clientes visíveis. */
export async function apoioDoQuadro(quem: QuemOlha) {
  const db = createAdminClient();
  const [membros, funcoes, etiquetas, clientes] = await Promise.all([
    db.from("agencia_membros").select("id, nome").eq("situacao", "ativo").order("nome"),
    db.from("agencia_funcoes").select("id, nome, cor").eq("ativa", true).order("ordem"),
    db.from("agencia_etiquetas").select("id, nome, cor").order("nome"),
    db.from("agencia_clientes").select("id, nome").order("nome"),
  ]);
  const todosClientes = (clientes.data ?? []) as Array<{ id: string; nome: string }>;
  const alcance = quem.alcance;
  return {
    membros: (membros.data ?? []) as Array<{ id: string; nome: string }>,
    funcoes: (funcoes.data ?? []) as Array<{ id: string; nome: string; cor: string }>,
    etiquetas: (etiquetas.data ?? []) as Array<{ id: string; nome: string; cor: string }>,
    clientes: alcance.todos ? todosClientes : todosClientes.filter((c) => alcance.ids.has(c.id)),
  };
}

/** Versão simplificada de QuemOlha só para o dashboard (não precisa de tudo). */
export async function carregarQuemOlhaTarefas(ctx: ContextoDaAgencia): Promise<QuemOlha> {
  return carregarQuemOlha(ctx);
}

/** Lista de tarefas para o dashboard (todas as que a pessoa vê, sem filtro de 30 dias). */
export async function listarTarefasParaDashboard(quem: QuemOlha): Promise<TarefaDoQuadro[]> {
  const agora = new Date();
  const q = createAdminClient().from("agencia_tarefas").select(SELECAO).order("posicao", { ascending: true }).limit(2000);
  const { data } = await q;
  return ((data ?? []) as unknown as LinhaBruta[])
    .filter((l) =>
      podeVerTarefa(quem, {
        clienteId: l.cliente_id,
        funcaoId: l.funcao_id,
        responsaveis: (l.agencia_tarefas_responsaveis ?? []).map((r) => r.membro_id),
      }),
    )
    .map((l) => paraQuadro(l, quem, agora));
}

/** Tarefas concluídas nos últimos N dias para série histórica. */
export async function listarTarefasConcluidasRecentes(quem: QuemOlha, dias: number): Promise<TarefaDoQuadro[]> {
  const agora = new Date();
  const desde = new Date(agora.getTime() - dias * 86_400_000).toISOString();
  const q = createAdminClient()
    .from("agencia_tarefas")
    .select(SELECAO)
    .eq("coluna", "concluido")
    .gte("concluida_em", desde)
    .order("posicao", { ascending: true })
    .limit(2000);
  const { data } = await q;
  return ((data ?? []) as unknown as LinhaBruta[])
    .filter((l) =>
      podeVerTarefa(quem, {
        clienteId: l.cliente_id,
        funcaoId: l.funcao_id,
        responsaveis: (l.agencia_tarefas_responsaveis ?? []).map((r) => r.membro_id),
      }),
    )
    .map((l) => paraQuadro(l, quem, agora));
}
