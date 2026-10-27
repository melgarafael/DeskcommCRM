/**
 * O motor do mapa mental (docs/agencia/SPEC-mapa-mental.md, M3–M5).
 *
 * Mesma regra de desbloqueio da trilha (`passosQueLiberam`), com o id do bloco no
 * papel da chave e as setas no papel do "depende de". `avancarMapa` é
 * idempotente: a liberação é reservada com `update … where situacao = 'bloqueado'`.
 */
import { env } from "@/lib/env";
import { midpoint } from "@/lib/kanban/fractional-indexing";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { avisarClienteDaAprovacao, ligarAprovacoesNaOrganizacao } from "../aprovacoes/servico";
import { criarAviso } from "../avisos/criar";
import { diaDe, instanteDoDia, somarDias } from "../calendario/regras";
import { contaNoCaminho, especieDe, type TipoDeBloco } from "./blocos";
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
  tipo: TipoDeBloco;
  /** A espécie da paleta (blocos.ts) — o que a pessoa escolheu. */
  especie: string;
  config: Record<string, unknown>;
  envio_id: string | null;
  publicacao_id: string | null;
  funcao_id: string | null;
  responsavel_id: string | null;
  prazo: string | null;
  checklist: string[];
  links: string[];
  executor: "humano" | "ia";
  /** A ação do catálogo que a tarefa do bloco vai executar (SPEC-ia-da-agencia, I4). */
  acao_ia: string | null;
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

/** O atalho que a tarefa do bloco leva (plano de 27/10, item 5): a tela certa, ou a pasta Captações do cliente. */
async function atalhoDoBloco(b: BlocoDoMapa, clienteId: string): Promise<{ titulo: string; url: string } | null> {
  const atalho = especieDe(b.especie).atalho;
  const app = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (atalho === "drive") {
    const { data } = await db().from("agencia_clientes").select("drive_subpastas").eq("id", clienteId).maybeSingle();
    const pasta = ((data as { drive_subpastas: Record<string, string> | null } | null)?.drive_subpastas ?? {})["05 Captações"];
    return pasta ? { titulo: "Pasta Captações do cliente (Drive)", url: `https://drive.google.com/drive/folders/${pasta}` } : null;
  }
  if (atalho === "envios") return { titulo: "Enviar para o cliente aprovar", url: `${app}/agencia/envios?novo=1&cliente=${clienteId}&titulo=${encodeURIComponent(b.titulo)}` };
  if (atalho === "calendario") return { titulo: "Calendário", url: `${app}/agencia/calendario` };
  if (atalho === "contratos") return { titulo: "Contratos do cliente", url: `${app}/agencia/clientes/${clienteId}?aba=contratos` };
  if (atalho === "publicacoes") return { titulo: "Publicações do cliente", url: `${app}/agencia/publicacoes?cliente=${clienteId}` };
  return null;
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
      acao_ia: b.executor === "ia" ? b.acao_ia : null,
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
  const atalho = await atalhoDoBloco(b, clienteId).catch(() => null);
  if (atalho) await banco.from("agencia_tarefas_links").insert({ tarefa_id: tarefaId, titulo: atalho.titulo, url: atalho.url });
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

/** Aviso ao cliente (Envios, tipo aviso): manda e espera o "Ciente". */
async function mandarAvisoDoBloco(b: BlocoDoMapa, clienteId: string): Promise<boolean> {
  const texto = String((b.config.texto as string | undefined) ?? b.descricao ?? "").trim();
  const { data: c } = await db().from("agencia_clientes").select("organization_id").eq("id", clienteId).maybeSingle();
  const organizationId = (c as { organization_id: string | null } | null)?.organization_id;
  if (!texto || !organizationId) return false;
  const { data, error } = await db()
    .from("agencia_aprovacoes")
    .insert({ organization_id: organizationId, cliente_id: clienteId, tipo: "aviso", titulo: b.titulo, texto })
    .select("id")
    .single();
  if (error || !data) return false;
  const id = (data as { id: string }).id;
  await ligarAprovacoesNaOrganizacao(organizationId);
  await avisarClienteDaAprovacao({ aprovacaoId: id, clienteId, tipo: "aviso", titulo: b.titulo, versao: 1 }).catch(() => "sem_whatsapp");
  await db().from("agencia_mapa_blocos").update({ envio_id: id, situacao: "em_andamento" }).eq("id", b.id);
  return true;
}

/** Publicação: o post nasce em rascunho no calendário, no prazo do bloco. */
async function criarPostDoBloco(b: BlocoDoMapa, clienteId: string): Promise<boolean> {
  const rede = ["instagram", "facebook", "tiktok", "youtube", "outra"].includes(String(b.config.rede)) ? String(b.config.rede) : "instagram";
  const formato = ["feed", "reels", "story", "carrossel", "video"].includes(String(b.config.formato)) ? String(b.config.formato) : "feed";
  const quando = b.prazo ?? instanteDoDia(somarDias(diaDe(new Date().toISOString()), 1), "18:00").toISOString();
  const { data, error } = await db()
    .from("agencia_publicacoes")
    .insert({ cliente_id: clienteId, titulo: b.titulo, rede, formato, quando, legenda: b.descricao, responsavel_id: b.responsavel_id })
    .select("id")
    .single();
  if (error || !data) return false;
  await db().from("agencia_mapa_blocos").update({ publicacao_id: (data as { id: string }).id, situacao: "em_andamento" }).eq("id", b.id);
  return true;
}

async function concluirBloco(id: string): Promise<void> {
  await db().from("agencia_mapa_blocos").update({ situacao: "concluido", concluido_em: new Date().toISOString() }).eq("id", id).neq("situacao", "concluido");
}

/** Libera o que pode e cria as tarefas (M4). Idempotente. */
export async function avancarMapa(mapaId: string): Promise<number> {
  let liberados = 0;
  for (let volta = 0; volta < 50; volta++) {
    let concluidosNaVolta = 0;
    const lido = await lerMapa(mapaId);
    if (!lido || lido.mapa.situacao !== "publicado") return liberados;
    // A nota não entra no caminho (blocos.ts › contaNoCaminho).
    const notas = new Set(lido.blocos.filter((b) => !contaNoCaminho(b.tipo)).map((b) => b.id));
    const ids = passosQueLiberam(
      lido.blocos.filter((b) => !notas.has(b.id)).map((b) => ({
        chave: b.id,
        situacao: b.situacao === "concluido" ? "concluido" : b.situacao === "bloqueado" ? "bloqueado" : "liberado",
        dependeDe: lido.ligacoes.filter((l) => l.para_id === b.id && !notas.has(l.de_id)).map((l) => l.de_id),
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
      } else if (b.tipo === "espera") {
        // Sem prazo, ou prazo já passado: segue na hora. Com prazo, o relógio da agência conclui.
        if (!b.prazo || new Date(b.prazo).getTime() <= Date.now()) {
          await concluirBloco(b.id);
          concluidosNaVolta++;
        }
      } else if (b.tipo === "aviso" || b.tipo === "publicacao") {
        const feito = b.tipo === "aviso" ? await mandarAvisoDoBloco(b, lido.mapa.cliente_id) : await criarPostDoBloco(b, lido.mapa.cliente_id);
        if (!feito) {
          await criarAviso({
            alvo: b.responsavel_id ? { tipo: "membros", ids: [b.responsavel_id] } : { tipo: "gerais" },
            tipo: "etapa_liberada",
            titulo: `${b.tipo === "aviso" ? "Aviso não saiu" : "Post não foi criado"}: ${b.titulo}${lido.mapa.agencia_clientes?.nome ? ` — ${lido.mapa.agencia_clientes.nome}` : ""}`,
            corpo: b.tipo === "aviso" ? "O cliente precisa estar ligado a uma organização do CRM e o bloco precisa do texto. Faça à mão e conclua o bloco no mapa." : "Crie o post à mão e conclua o bloco no mapa.",
            link: `/agencia/mapas/${mapaId}`,
            referenciaId: b.id,
          }).catch(() => 0);
        }
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
    // Esperas sem prazo seguem na hora: libera a próxima leva; o resto espera tarefa, cliente, post ou data.
    if (concluidosNaVolta === 0) return liberados;
  }
  return liberados;
}

export async function publicarMapa(mapaId: string): Promise<{ ok: true; liberados: number } | { ok: false; erro: string }> {
  const lido = await lerMapa(mapaId);
  if (!lido) return { ok: false, erro: "Mapa não encontrado." };
  if (lido.mapa.situacao !== "rascunho") return { ok: false, erro: "Este mapa já foi publicado." };
  const noCaminho = lido.blocos.filter((b) => contaNoCaminho(b.tipo));
  const ids = new Set(noCaminho.map((b) => b.id));
  const problema = problemaNoMapa(noCaminho, lido.ligacoes.filter((l) => ids.has(l.de_id) && ids.has(l.para_id)));
  if (problema) return { ok: false, erro: problema };
  await db().from("agencia_mapa_blocos").update({ situacao: "bloqueado", tarefa_id: null, liberado_em: null, concluido_em: null }).eq("mapa_id", mapaId);
  await db().from("agencia_mapas").update({ situacao: "publicado", publicado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }).eq("id", mapaId).eq("situacao", "rascunho");
  return { ok: true, liberados: await avancarMapa(mapaId) };
}

/** Marco concluído à mão (M4). */
export async function concluirMarcoDoMapa(blocoId: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const { data } = await db().from("agencia_mapa_blocos").select("mapa_id, tipo, situacao, envio_id, publicacao_id").eq("id", blocoId).maybeSingle();
  const b = data as { mapa_id: string; tipo: string; situacao: string; envio_id: string | null; publicacao_id: string | null } | null;
  if (!b) return { ok: false, erro: "Bloco não encontrado." };
  const manualSemEfeito = (b.tipo === "aviso" && !b.envio_id) || (b.tipo === "publicacao" && !b.publicacao_id);
  if (b.tipo !== "marco" && !manualSemEfeito) return { ok: false, erro: "Este bloco acompanha a tarefa, o cliente ou o post: conclua por lá." };
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

/** O cliente marcou "Ciente" no aviso que o bloco mandou: o bloco conclui. Nunca lança. */
export async function aoResponderEnvioDoMapa(aprovacaoId: string): Promise<void> {
  try {
    const { data } = await db().from("agencia_mapa_blocos").select("id, mapa_id").eq("envio_id", aprovacaoId).neq("situacao", "concluido");
    for (const b of (data ?? []) as Array<{ id: string; mapa_id: string }>) {
      await concluirBloco(b.id);
      await avancarMapa(b.mapa_id);
    }
  } catch (e) {
    logger.warn("agência: mapa não acompanhou o envio", { aprovacaoId, detalhe: e instanceof Error ? e.message : String(e) });
  }
}

/** O post do bloco foi ao ar: o bloco conclui. Nunca lança. */
export async function aoPublicarPostDoMapa(publicacaoId: string): Promise<void> {
  try {
    const { data } = await db().from("agencia_mapa_blocos").select("id, mapa_id").eq("publicacao_id", publicacaoId).neq("situacao", "concluido");
    for (const b of (data ?? []) as Array<{ id: string; mapa_id: string }>) {
      await concluirBloco(b.id);
      await avancarMapa(b.mapa_id);
    }
  } catch (e) {
    logger.warn("agência: mapa não acompanhou o post", { publicacaoId, detalhe: e instanceof Error ? e.message : String(e) });
  }
}

/** O relógio da agência: "Esperar data" que venceu segue o caminho. Devolve quantos seguiram. */
export async function avancarEsperasDosMapas(agora = new Date()): Promise<number> {
  const { data } = await db()
    .from("agencia_mapa_blocos")
    .select("id, mapa_id")
    .eq("tipo", "espera")
    .eq("situacao", "liberado")
    .lte("prazo", agora.toISOString())
    .limit(200);
  const blocos = (data ?? []) as Array<{ id: string; mapa_id: string }>;
  for (const b of blocos) await concluirBloco(b.id);
  for (const mapaId of new Set(blocos.map((b) => b.mapa_id))) await avancarMapa(mapaId);
  return blocos.length;
}
