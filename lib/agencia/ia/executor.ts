import "server-only";

import { z } from "zod";

import { diaDe, instanteDoDia, somarDias } from "@/lib/agencia/calendario/regras";
import { lerMapa } from "@/lib/agencia/mapas/motor";
import { createAdminClient } from "@/lib/supabase/admin";

import { INSTRUCAO_DA_ACAO, ROTULO_DA_ACAO_DA_IA, ehAcaoDaIa, type AcaoDaIa } from "./catalogo";
import { contextoDoCliente, pedirAIa } from "./modelo";
import { MAX_BLOCOS_POR_PROPOSTA, normalizarProposta, problemaNaProposta, propostaSchema, type Proposta } from "./proposta";

/** O chat no mapa e o executor IA (docs/agencia/SPEC-ia-da-agencia.md). Quem chama já conferiu permissão e alcance. */

const LARGURA = 210;
const ALTURA = 64;

export async function proporParaMapa(mapaId: string, pedido: string, userId: string): Promise<{ ok: true; proposta: Proposta } | { ok: false; erro: string }> {
  const lido = await lerMapa(mapaId);
  if (!lido) return { ok: false, erro: "Mapa não encontrado." };
  if (lido.mapa.situacao !== "rascunho") return { ok: false, erro: "A IA só propõe blocos em mapa em Criação (rascunho)." };
  const existentes = lido.blocos.map((b) => ({ id: b.id, titulo: b.titulo }));
  const prompt = [
    await contextoDoCliente(lido.mapa.cliente_id),
    `Mapa: ${lido.mapa.titulo}`,
    existentes.length
      ? `Blocos que já existem (use o id para ligar a eles):\n${existentes.map((b) => `- ${b.id}: ${b.titulo}`).join("\n")}`
      : "O mapa ainda não tem blocos.",
    "",
    "Monte as etapas que faltam para o pedido abaixo. Cada etapa é um bloco; setas dizem o que precisa terminar antes. " +
      `No máximo ${MAX_BLOCOS_POR_PROPOSTA} blocos, sem setas em círculo. Etapas de escrita (roteiro, legenda, pautas, rascunho de campanha) podem ser da IA; ` +
      "gravação, edição de vídeo, reunião e aprovação do cliente são de pessoas. Aprovação do cliente é um marco.",
    "",
    `Pedido: ${pedido}`,
  ].join("\n");
  const r = await pedirAIa({ acao: "propor_mapa", userId, mapaId, schema: propostaSchema, prompt });
  if (!r.ok) return r;
  const proposta = normalizarProposta(r.objeto);
  const problema = problemaNaProposta(proposta, existentes, lido.ligacoes);
  return problema ? { ok: false, erro: problema } : { ok: true, proposta };
}

/** I3: grava a proposta conferida — blocos no primeiro lugar livre da grade, setas por chave. */
export async function aplicarProposta(mapaId: string, proposta: Proposta): Promise<{ ok: true; criados: number } | { ok: false; erro: string }> {
  const lido = await lerMapa(mapaId);
  if (!lido) return { ok: false, erro: "Mapa não encontrado." };
  if (lido.mapa.situacao !== "rascunho") return { ok: false, erro: "O mapa já foi publicado: aplique só em rascunho." };
  const existentes = lido.blocos.map((b) => ({ id: b.id, titulo: b.titulo }));
  const problema = problemaNaProposta(proposta, existentes, lido.ligacoes);
  if (problema) return { ok: false, erro: problema };

  const ocupadas = lido.blocos.map((b) => ({ x: Number(b.x), y: Number(b.y) }));
  const livre = (): { x: number; y: number } => {
    for (let i = 0; i < 400; i++) {
      const x = 40 + (i % 3) * (LARGURA + 70);
      const y = 40 + Math.floor(i / 3) * (ALTURA + 60);
      if (!ocupadas.some((q) => Math.abs(q.x - x) < LARGURA + 20 && Math.abs(q.y - y) < ALTURA + 20)) {
        ocupadas.push({ x, y });
        return { x, y };
      }
    }
    return { x: 40, y: 40 };
  };
  const hoje = diaDe(new Date().toISOString());
  const linhas = proposta.blocos.map((b) => ({
    mapa_id: mapaId,
    titulo: b.titulo,
    descricao: b.descricao,
    tipo: b.tipo,
    executor: b.executor,
    acao_ia: b.acao_ia,
    prazo: b.prazo_em_dias === null ? null : instanteDoDia(somarDias(hoje, b.prazo_em_dias), "18:00").toISOString(),
    ...livre(),
  }));
  const db = createAdminClient();
  const { data, error } = await db.from("agencia_mapa_blocos").insert(linhas).select("id");
  if (error || !data || data.length !== linhas.length) return { ok: false, erro: "Não deu para gravar os blocos." };
  const idDaChave = new Map(proposta.blocos.map((b, i) => [b.chave, (data[i] as { id: string }).id]));
  const resolver = (k: string) => idDaChave.get(k) ?? k;
  const setas = proposta.ligacoes.map((l) => ({ mapa_id: mapaId, de_id: resolver(l.de), para_id: resolver(l.para) }));
  if (setas.length) {
    const { error: e2 } = await db.from("agencia_mapa_ligacoes").upsert(setas, { onConflict: "de_id,para_id", ignoreDuplicates: true });
    if (e2) return { ok: false, erro: "Os blocos entraram, mas as setas não. Ligue à mão." };
  }
  await db.from("agencia_mapas").update({ atualizado_em: new Date().toISOString() }).eq("id", mapaId);
  return { ok: true, criados: linhas.length };
}

const textoSchema = z.object({ texto: z.string().min(10).max(8000).describe("O resultado, em texto simples com quebras de linha") });
const publicacaoSchema = z.object({
  titulo: z.string().min(2).max(120),
  legenda: z.string().min(10).max(2200),
  rede: z.enum(["instagram", "facebook", "tiktok", "youtube"]),
  formato: z.enum(["feed", "reels", "story", "carrossel", "video"]),
});

/** I4/I6: roda a ação da tarefa e devolve o resultado para conferência (tarefa → Revisão). */
export async function executarTarefa(tarefaId: string, userId: string): Promise<{ ok: true; resultado: string } | { ok: false; erro: string }> {
  const db = createAdminClient();
  const { data } = await db.from("agencia_tarefas").select("id, titulo, descricao, cliente_id, acao_ia, prazo, coluna").eq("id", tarefaId).maybeSingle();
  const t = data as { id: string; titulo: string; descricao: string | null; cliente_id: string | null; acao_ia: string | null; prazo: string | null; coluna: string } | null;
  if (!t) return { ok: false, erro: "Tarefa não encontrada." };
  if (!ehAcaoDaIa(t.acao_ia)) return { ok: false, erro: "Escolha o que a IA deve fazer nesta tarefa." };
  if (t.coluna === "concluido") return { ok: false, erro: "A tarefa já está concluída." };
  const acao: AcaoDaIa = t.acao_ia;
  if (acao === "publicacao" && !t.cliente_id) return { ok: false, erro: "Criar publicação pede uma tarefa de cliente." };

  const prompt = [await contextoDoCliente(t.cliente_id), "", INSTRUCAO_DA_ACAO[acao], "", `Tarefa: ${t.titulo}`, t.descricao ? `Detalhes: ${t.descricao.slice(0, 3000)}` : ""].join("\n");
  let resultado: string;
  if (acao === "publicacao") {
    const r = await pedirAIa({ acao, userId, tarefaId, schema: publicacaoSchema, prompt });
    if (!r.ok) return r;
    const dia = t.prazo ? diaDe(t.prazo) : somarDias(diaDe(new Date().toISOString()), 1);
    const { data: pub, error } = await db
      .from("agencia_publicacoes")
      .insert({ cliente_id: t.cliente_id, titulo: r.objeto.titulo, rede: r.objeto.rede, formato: r.objeto.formato, legenda: r.objeto.legenda, quando: instanteDoDia(dia, "18:00").toISOString(), criado_por: userId })
      .select("id")
      .single();
    if (error || !pub) return { ok: false, erro: "A IA escreveu, mas a publicação não foi criada." };
    resultado = `Publicação criada em rascunho no calendário (${dia.split("-").reverse().join("/")} 18:00): "${r.objeto.titulo}".\n` +
      `Falta: anexar a mídia, pedir a aprovação do cliente e agendar.\n\nLegenda:\n${r.objeto.legenda}\n\n/agencia/publicacoes?abrir=${(pub as { id: string }).id}`;
  } else {
    const r = await pedirAIa({ acao, userId, tarefaId, schema: textoSchema, prompt });
    if (!r.ok) return r;
    resultado = r.objeto.texto;
  }

  const agora = new Date().toISOString();
  await db.from("agencia_tarefas").update({ resultado_ia: resultado, coluna: "revisao", atualizada_em: agora }).eq("id", tarefaId);
  const { data: ja } = await db.from("agencia_tarefas_checklist").select("id").eq("tarefa_id", tarefaId).eq("texto", "Conferir o resultado da IA").maybeSingle();
  if (!ja) {
    const { count } = await db.from("agencia_tarefas_checklist").select("id", { count: "exact", head: true }).eq("tarefa_id", tarefaId);
    await db.from("agencia_tarefas_checklist").insert({ tarefa_id: tarefaId, texto: "Conferir o resultado da IA", ordem: count ?? 0 });
  }
  return { ok: true, resultado: `${ROTULO_DA_ACAO_DA_IA[acao]}: pronto para conferir.\n\n${resultado}`.slice(0, 9000) };
}
