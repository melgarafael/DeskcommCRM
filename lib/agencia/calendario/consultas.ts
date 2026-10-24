/**
 * Leitura das reuniões no servidor, já filtrada pelo que a pessoa pode ver (K9).
 * Mesmo desenho das tarefas: o volume de uma agência é pequeno e a regra roda em
 * TypeScript (`podeVerReuniao`), sem uma segunda cópia em SQL.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import type { ContextoDaAgencia } from "../acesso";
import { carregarAlcance } from "../clientes/visibilidade";
import { podeVerReuniao, type QuemOlhaAgenda } from "./regras";
import type { Formato, SituacaoDaReuniao, TipoDeReuniao } from "./vocabulario";

export async function carregarQuemOlhaAgenda(ctx: ContextoDaAgencia): Promise<QuemOlhaAgenda> {
  return {
    gerencia: ctx.permissoes.has("calendario.gerenciar"),
    membroId: ctx.membro?.id ?? null,
    alcance: await carregarAlcance(ctx),
  };
}

export interface ConvidadoDaReuniao {
  nome: string;
  whatsapp: string;
  email: string;
}

export interface ReuniaoDaAgenda {
  id: string;
  tipo: TipoDeReuniao;
  titulo: string;
  clienteId: string | null;
  clienteNome: string | null;
  inicio: string;
  fim: string;
  formato: Formato;
  local: string | null;
  situacao: SituacaoDaReuniao;
  pauta: string | null;
  ata: string | null;
  avisarCliente: boolean;
  meetUrl: string | null;
  googleLink: string | null;
  googleErro: string | null;
  gravacaoUrl: string | null;
  origemId: string | null;
  membros: string[];
  convidados: ConvidadoDaReuniao[];
}

interface LinhaBruta {
  id: string;
  tipo: TipoDeReuniao;
  titulo: string;
  cliente_id: string | null;
  inicio: string;
  fim: string;
  formato: Formato;
  local: string | null;
  situacao: SituacaoDaReuniao;
  pauta: string | null;
  ata: string | null;
  avisar_cliente: boolean;
  meet_url: string | null;
  google_link: string | null;
  google_erro: string | null;
  gravacao_url: string | null;
  origem_id: string | null;
  agencia_clientes: { nome: string } | Array<{ nome: string }> | null;
  agencia_reunioes_membros: Array<{ membro_id: string }> | null;
  agencia_reunioes_convidados: Array<{ nome: string; whatsapp: string | null; email: string | null; ordem: number }> | null;
}

const SELECAO =
  "id, tipo, titulo, cliente_id, inicio, fim, formato, local, situacao, pauta, ata, avisar_cliente, meet_url, " +
  "google_link, google_erro, gravacao_url, origem_id, agencia_clientes(nome), agencia_reunioes_membros(membro_id), " +
  "agencia_reunioes_convidados(nome, whatsapp, email, ordem)";

function paraAgenda(l: LinhaBruta): ReuniaoDaAgenda {
  const cliente = Array.isArray(l.agencia_clientes) ? l.agencia_clientes[0] : l.agencia_clientes;
  return {
    id: l.id,
    tipo: l.tipo,
    titulo: l.titulo,
    clienteId: l.cliente_id,
    clienteNome: cliente?.nome ?? null,
    inicio: l.inicio,
    fim: l.fim,
    formato: l.formato,
    local: l.local,
    situacao: l.situacao,
    pauta: l.pauta,
    ata: l.ata,
    avisarCliente: l.avisar_cliente,
    meetUrl: l.meet_url,
    googleLink: l.google_link,
    googleErro: l.google_erro,
    gravacaoUrl: l.gravacao_url,
    origemId: l.origem_id,
    membros: (l.agencia_reunioes_membros ?? []).map((m) => m.membro_id),
    convidados: [...(l.agencia_reunioes_convidados ?? [])]
      .sort((a, b) => a.ordem - b.ordem)
      .map((c) => ({ nome: c.nome, whatsapp: c.whatsapp ?? "", email: c.email ?? "" })),
  };
}

function visivel(quem: QuemOlhaAgenda, l: LinhaBruta): boolean {
  return podeVerReuniao(quem, { clienteId: l.cliente_id, membros: (l.agencia_reunioes_membros ?? []).map((m) => m.membro_id) });
}

/** As reuniões que começam em [de, ate), ou todas as de um cliente. */
export async function listarReunioes(
  quem: QuemOlhaAgenda,
  filtro: { de?: Date; ate?: Date; clienteId?: string },
): Promise<ReuniaoDaAgenda[]> {
  let q = createAdminClient().from("agencia_reunioes").select(SELECAO).order("inicio", { ascending: true }).limit(1000);
  if (filtro.de) q = q.gte("inicio", filtro.de.toISOString());
  if (filtro.ate) q = q.lt("inicio", filtro.ate.toISOString());
  if (filtro.clienteId) q = q.eq("cliente_id", filtro.clienteId);
  const { data } = await q;
  return ((data ?? []) as unknown as LinhaBruta[]).filter((l) => visivel(quem, l)).map(paraAgenda);
}

export async function carregarReuniao(id: string, quem: QuemOlhaAgenda): Promise<ReuniaoDaAgenda | null> {
  const { data } = await createAdminClient().from("agencia_reunioes").select(SELECAO).eq("id", id).maybeSingle();
  const l = data as unknown as LinhaBruta | null;
  return l && visivel(quem, l) ? paraAgenda(l) : null;
}
