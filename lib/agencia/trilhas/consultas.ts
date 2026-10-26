/**
 * Leitura da trilha para as telas (SPEC-trilhas › Telas). Quem vê a trilha é
 * quem alcança o cliente (R11, C5) — o filtro é feito aqui, no servidor.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import type { AlcanceDeClientes } from "../clientes/visibilidade";
import { estaAtrasada } from "../tarefas/regras";
import type { Coluna } from "../tarefas/vocabulario";
import { etapaAtual, progresso } from "./regras";
import type { RegraDePrazo, SituacaoDaTrilha, SituacaoDoPasso, TipoDePasso } from "./vocabulario";

export interface PassoDaTela {
  id: string;
  chave: string;
  etapa: number;
  ordem: number;
  titulo: string;
  descricao: string | null;
  tipo: TipoDePasso;
  reuniaoTipo: string | null;
  funcaoNome: string | null;
  dependeDe: string[];
  situacao: SituacaoDoPasso;
  prazo: string | null;
  atrasado: boolean;
  tarefa: { id: string; coluna: Coluna; responsaveis: string[] } | null;
  reuniao: { id: string; inicio: string; situacao: string } | null;
  concluidoEm: string | null;
}

export interface TrilhaDaTela {
  id: string;
  clienteId: string;
  modeloNome: string;
  situacao: SituacaoDaTrilha;
  iniciadaEm: string;
  assinouPagouEm: string | null;
  contratoInicio: string | null;
  contratoFim: string | null;
  preparacaoFim: string | null;
  passos: PassoDaTela[];
  progresso: { feitos: number; total: number; pct: number };
  etapaAtual: number | null;
}

interface LinhaDoPasso {
  id: string;
  chave: string;
  etapa: number;
  ordem: number;
  titulo: string;
  descricao: string | null;
  tipo: TipoDePasso;
  reuniao_tipo: string | null;
  depende_de: string[];
  prazo_regra: RegraDePrazo;
  situacao: SituacaoDoPasso;
  prazo: string | null;
  concluido_em: string | null;
  agencia_funcoes: { nome: string } | null;
  agencia_tarefas: { id: string; coluna: Coluna; agencia_tarefas_responsaveis: Array<{ agencia_membros: { nome: string } | null }> | null } | null;
  agencia_reunioes: { id: string; inicio: string; situacao: string } | null;
}

interface LinhaDaTrilha {
  id: string;
  cliente_id: string;
  modelo_nome: string;
  situacao: SituacaoDaTrilha;
  iniciada_em: string;
  assinou_pagou_em: string | null;
  contrato_inicio: string | null;
  contrato_fim: string | null;
  preparacao_fim: string | null;
  agencia_trilha_passos: LinhaDoPasso[] | null;
}

const SELECAO =
  "id, cliente_id, modelo_nome, situacao, iniciada_em, assinou_pagou_em, contrato_inicio, contrato_fim, preparacao_fim, " +
  "agencia_trilha_passos(id, chave, etapa, ordem, titulo, descricao, tipo, reuniao_tipo, depende_de, prazo_regra, situacao, prazo, concluido_em, " +
  "agencia_funcoes(nome), agencia_tarefas(id, coluna, agencia_tarefas_responsaveis(agencia_membros(nome))), agencia_reunioes(id, inicio, situacao))";

function paraTela(t: LinhaDaTrilha, agora: Date): TrilhaDaTela {
  const passos = [...(t.agencia_trilha_passos ?? [])]
    .sort((a, b) => a.etapa - b.etapa || a.ordem - b.ordem)
    .map<PassoDaTela>((p) => ({
      id: p.id,
      chave: p.chave,
      etapa: p.etapa,
      ordem: p.ordem,
      titulo: p.titulo,
      descricao: p.descricao,
      tipo: p.tipo,
      reuniaoTipo: p.reuniao_tipo,
      funcaoNome: p.agencia_funcoes?.nome ?? null,
      dependeDe: p.depende_de,
      situacao: p.situacao,
      prazo: p.prazo,
      atrasado:
        (p.situacao === "liberado" || p.situacao === "em_andamento") &&
        estaAtrasada({ prazo: p.prazo, coluna: p.agencia_tarefas?.coluna ?? "a_fazer" }, agora) &&
        // Reunião já marcada não está atrasada por causa da data sugerida.
        !(p.tipo === "reuniao" && p.agencia_reunioes),
      tarefa: p.agencia_tarefas
        ? {
            id: p.agencia_tarefas.id,
            coluna: p.agencia_tarefas.coluna,
            responsaveis: (p.agencia_tarefas.agencia_tarefas_responsaveis ?? []).flatMap((r) => (r.agencia_membros ? [r.agencia_membros.nome] : [])),
          }
        : null,
      reuniao: p.agencia_reunioes,
      concluidoEm: p.concluido_em,
    }));
  return {
    id: t.id,
    clienteId: t.cliente_id,
    modeloNome: t.modelo_nome,
    situacao: t.situacao,
    iniciadaEm: t.iniciada_em,
    assinouPagouEm: t.assinou_pagou_em,
    contratoInicio: t.contrato_inicio,
    contratoFim: t.contrato_fim,
    preparacaoFim: t.preparacao_fim,
    passos,
    progresso: progresso(passos),
    etapaAtual: etapaAtual(passos),
  };
}

/** A trilha ativa do cliente (ou a última concluída), para a aba da ficha. */
export async function trilhaDoCliente(clienteId: string): Promise<TrilhaDaTela | null> {
  const { data } = await createAdminClient()
    .from("agencia_trilhas")
    .select(SELECAO)
    .eq("cliente_id", clienteId)
    .neq("situacao", "cancelada")
    .order("iniciada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? paraTela(data as unknown as LinhaDaTrilha, new Date()) : null;
}

export interface ResumoDaTrilha {
  id: string;
  clienteId: string;
  clienteNome: string;
  modeloNome: string;
  etapaAtual: number | null;
  progresso: { feitos: number; total: number; pct: number };
  proximos: string[];
  atrasados: string[];
}

/** As trilhas ativas dos clientes que a pessoa alcança (painel `/agencia/trilhas`). */
export async function listarTrilhasAtivas(alcance: AlcanceDeClientes): Promise<ResumoDaTrilha[]> {
  const { data } = await createAdminClient()
    .from("agencia_trilhas")
    .select(`${SELECAO}, agencia_clientes(nome)`)
    .eq("situacao", "ativa")
    .order("iniciada_em", { ascending: true });
  const agora = new Date();
  return ((data ?? []) as unknown as Array<LinhaDaTrilha & { agencia_clientes: { nome: string } | null }>)
    .filter((t) => alcance.todos || alcance.ids.has(t.cliente_id))
    .map((t) => {
      const tela = paraTela(t, agora);
      const abertos = tela.passos.filter((p) => p.situacao === "liberado" || p.situacao === "em_andamento");
      return {
        id: tela.id,
        clienteId: tela.clienteId,
        clienteNome: t.agencia_clientes?.nome ?? "Cliente",
        modeloNome: tela.modeloNome,
        etapaAtual: tela.etapaAtual,
        progresso: tela.progresso,
        proximos: abertos.map((p) => p.titulo),
        atrasados: abertos.filter((p) => p.atrasado).map((p) => p.titulo),
      };
    });
}
