/**
 * O motor do mapa mental (docs/agencia/SPEC-mapa-mental.md, M3–M5).
 *
 * Mesma regra de desbloqueio da trilha (`passosQueLiberam`), com o id do bloco no
 * papel da chave e as setas no papel do "depende de". `avancarMapa` é
 * idempotente: a liberação é reservada com `update … where situacao = 'bloqueado'`.
 */
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import { passosQueLiberam } from "../trilhas/regras";
import { problemaNoMapa, type LigacaoDoMapa } from "./regras";

const db = () => createAdminClient();

export interface BlocoDoMapa {
  id: string;
  mapa_id: string;
  titulo: string;
  descricao: string | null;
  cor: string;
  x: number;
  y: number;
  tipo: "tarefa" | "marco";
  funcao_id: string | null;
  responsavel_id: string | null;
  prazo: string | null;
  checklist: string[];
  links: string[];
  executor: "humano" | "ia";
  situacao: "bloqueado" | "liberado" | "em_andamento" | "concluido";
  tarefa_id: string | null;
  liberado_em: string | null;
  concluido_em: string | null;
}

export type { LigacaoDoMapa };

export async function lerMapa(mapaId: string) {
  const [{ data: mapa }, { data: blocos }, { data: ligacoes }] = await Promise.all([
    db().from("agencia_mapas").select("id, cliente_id, titulo, descricao, situacao, publicado_em, agencia_clientes(nome)").eq("id", mapaId).maybeSingle(),
    db().from("agencia_mapa_blocos").select("*").eq("mapa_id", mapaId).order("criado_em"),
    db().from("agencia_mapa_ligacoes").select("de_id, para_id").eq("mapa_id", mapaId),
  ]);
  if (!mapa) return null;
  return {
    mapa: mapa as unknown as {
      id: string;
      cliente_id: string;
      titulo: string;
      descricao: string | null;
      situacao: "rascunho" | "publicado" | "arquivado";
      publicado_em: string | null;
      agencia_clientes: { nome: string } | null;
    },
    blocos: ((blocos ?? []) as BlocoDoMapa[]).map((b) => ({ ...b, x: Number(b.x), y: Number(b.y) })),
    ligacoes: (ligacoes ?? []) as LigacaoDoMapa[],
  };
}

async function membrosDaFuncao(funcaoId: string): Promise<string[]> {
  const { data } = await db()
    .from("agencia_membros_funcoes")
    .select("membro_id, agencia_membros!inner(situacao)")
    .eq("funcao_id", funcaoId)
    .eq("agencia_membros.situacao", "ativo");
  return ((data ?? []) as Array<{ membro_id: string }>).map((r) => r.membro_id);
}

async function criarTarefaDoBloco(b: BlocoDoMapa, clienteId: string, clienteNome: string | null, mapaTitulo: string): Promise<string | null> {
  const banco = db();
  const { data: ultima } = await banco.from("agencia_tarefas").select("posicao").eq("coluna", "a_fazer").order("posicao", { ascending: false }).limit(1).maybeSingle();
  const ultimaPosicao = (ultima as { posicao?: number | string } | null)?.posicao;
  const posicao = midpoint(ultimaPosicao === undefined ? null : Number(ultimaPosicao), null);
  const { data, error } = await banco
    .from("agencia_tarefas")
    .insert({
      titulo: b.titulo,
      descricao: [b.descricao, ...b.links].filter(Boolean).join("\n") || null,
      coluna: "a_fazer",
      posicao: Number.isFinite(posicao) ? posicao : Date.now() / 1000,
      prioridade: "media",
      prazo: b.prazo,
      cliente_id: clienteId,
      funcao_id: b.responsavel_id ? null : b.funcao_id,
      executor: b.executor,
    })
    .select("id")
    .single();
  if (error || !data) {
    logger.warn("agência: tarefa do bloco do mapa não gravou", { bloco: b.id, codigo: error?.code });
    return null;
  }
  const tarefaId = (data as { id: string }).id;
  if (b.responsavel_id) await banco.from("agencia_tarefas_responsaveis").insert({ tarefa_id: tarefaId, membro_id: b.responsavel_id });
  if (b.checklist.length) await banco.from("agencia_tarefas_checklist").insert(b.checklist.map((texto, ordem) => ({ tarefa_id: tarefaId, texto, ordem })));
  for (const url of b.links.filter((l) => /^https?:\/\//i.test(l)).slice(0, 10)) {
    await banco.from("agencia_tarefas_links").insert({ tarefa_id: tarefaId, titulo: "Link do mapa", url });
  }
  const alvos = b.responsavel_id ? [b.responsavel_id] : b.funcao_id ? await membrosDaFuncao(b.funcao_id) : [];
  if (alvos.length) {
    await criarAviso({
      alvo: { tipo: "membros", ids: alvos },
      tipo: "tarefa_atribuida",
      titulo: clienteNome ? `${b.titulo} — ${clienteNome}` : b.titulo,
      corpo: `Liberada no mapa "${mapaTitulo}".`,
      link: `/agencia/tarefas?abrir=${tarefaId}`,
      referenciaId: tarefaId,
    });
  }
  return tarefaId;
}

/** Libera o que pode e cria as tarefas (M4). Idempotente. */
export async function avancarMapa(mapaId: string): Promise<number> {
  let liberados = 0;
  for (let volta = 0; volta < 50; volta++) {
    const lido = await lerMapa(mapaId);
    if (!lido || lido.mapa.situacao !== "publicado") return liberados;
    const ids = passosQueLiberam(
      lido.blocos.map((b) => ({
        chave: b.id,
        situacao: b.situacao === "concluido" ? "concluido" : b.situacao === "bloqueado" ? "bloqueado" : "liberado",
        dependeDe: lido.ligacoes.filter((l) => l.para_id === b.id).map((l) => l.de_id),
      })),
    );
    if (ids.length === 0) return liberados;
    for (const b of lido.blocos.filter((x) => ids.includes(x.id))) {
      const { data: reservado } = await db()
        .from("agencia_mapa_blocos")
        .update({ situacao: "liberado", liberado_em: new Date().toISOString() })
        .eq("id", b.id)
        .eq("situacao", "bloqueado")
        .select("id");
      if (!reservado?.length) continue;
      liberados++;
      if (b.tipo === "tarefa") {
        const tarefaId = await criarTarefaDoBloco(b, lido.mapa.cliente_id, lido.mapa.agencia_clientes?.nome ?? null, lido.mapa.titulo);
        if (tarefaId) await db().from("agencia_mapa_blocos").update({ tarefa_id: tarefaId }).eq("id", b.id);
      } else {
        await criarAviso({
          alvo: b.responsavel_id ? { tipo: "membros", ids: [b.responsavel_id] } : { tipo: "gerais" },
          tipo: "etapa_liberada",
          titulo: `Marco liberado: ${b.titulo}${lido.mapa.agencia_clientes?.nome ? ` — ${lido.mapa.agencia_clientes.nome}` : ""}`,
          link: `/agencia/mapas/${mapaId}`,
          referenciaId: b.id,
        }).catch(() => 0);
      }
    }
    // Só blocos de tarefa ou marcos liberados: nada conclui sozinho; uma volta basta.
    return liberados;
  }
  return liberados;
}

export async function publicarMapa(mapaId: string): Promise<{ ok: true; liberados: number } | { ok: false; erro: string }> {
  const lido = await lerMapa(mapaId);
  if (!lido) return { ok: false, erro: "Mapa não encontrado." };
  if (lido.mapa.situacao !== "rascunho") return { ok: false, erro: "Este mapa já foi publicado." };
  const problema = problemaNoMapa(lido.blocos, lido.ligacoes);
  if (problema) return { ok: false, erro: problema };
  await db().from("agencia_mapa_blocos").update({ situacao: "bloqueado", tarefa_id: null, liberado_em: null, concluido_em: null }).eq("mapa_id", mapaId);
  await db().from("agencia_mapas").update({ situacao: "publicado", publicado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }).eq("id", mapaId).eq("situacao", "rascunho");
  return { ok: true, liberados: await avancarMapa(mapaId) };
}

/** Marco concluído à mão (M4). */
export async function concluirMarcoDoMapa(blocoId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const { data } = await db().from("agencia_mapa_blocos").select("mapa_id, tipo, situacao").eq("id", blocoId).maybeSingle();
  const b = data as { mapa_id: string; tipo: string; situacao: string } | null;
  if (!b) return { ok: false, erro: "Bloco não encontrado." };
  if (b.tipo !== "marco") return { ok: false, erro: "Conclua a tarefa no quadro; o bloco acompanha." };
  if (b.situacao === "bloqueado") return { ok: false, erro: "Esse bloco ainda está bloqueado." };
  await db().from("agencia_mapa_blocos").update({ situacao: "concluido", concluido_em: new Date().toISOString() }).eq("id", blocoId);
  await avancarMapa(b.mapa_id);
  return { ok: true };
}

const SITUACAO_DA_COLUNA: Record<string, BlocoDoMapa["situacao"]> = {
  backlog: "liberado",
  a_fazer: "liberado",
  em_andamento: "em_andamento",
  revisao: "em_andamento",
  concluido: "concluido",
};

/** A tarefa mudou: o bloco dela acompanha (M4). Nunca lança. */
export async function aoMudarTarefaDoMapa(tarefaId: string): Promise<void> {
  try {
    const { data } = await db()
      .from("agencia_mapa_blocos")
      .select("id, mapa_id, situacao, agencia_tarefas!inner(coluna, concluida_em)")
      .eq("tarefa_id", tarefaId)
      .maybeSingle();
    const b = data as unknown as { id: string; mapa_id: string; situacao: string; agencia_tarefas: { coluna: string; concluida_em: string | null } } | null;
    if (!b) return;
    const nova = SITUACAO_DA_COLUNA[b.agencia_tarefas.coluna] ?? "liberado";
    if (nova === b.situacao) return;
    await db()
      .from("agencia_mapa_blocos")
      .update({ situacao: nova, concluido_em: nova === "concluido" ? (b.agencia_tarefas.concluida_em ?? new Date().toISOString()) : null })
      .eq("id", b.id);
    if (nova === "concluido") await avancarMapa(b.mapa_id);
  } catch (e) {
    logger.warn("agência: mapa não acompanhou a tarefa", { tarefaId, detalhe: e instanceof Error ? e.message : String(e) });
  }
}

export async function aoApagarTarefaDoMapa(tarefaId: string): Promise<void> {
  await db().from("agencia_mapa_blocos").update({ situacao: "liberado", tarefa_id: null, concluido_em: null }).eq("tarefa_id", tarefaId);
}
