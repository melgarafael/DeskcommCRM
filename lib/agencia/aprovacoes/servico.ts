/**
 * Aprovações do cliente (docs/agencia/SPEC-aprovacoes.md). Servidor só: quem
 * chama já conferiu a permissão (agência) ou a organização ativa e o papel
 * (cliente). Toda leitura e escrita filtra `organization_id` À MÃO — o client é
 * o de serviço, que ignora a RLS.
 */
import { marcaDaSaida } from "@/lib/branding/saida";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import { normalizarWhatsapp } from "../convite";
import { aoResponderAprovacaoDaPublicacao } from "../publicacoes/motor";
import { aoMudarTarefa } from "../trilhas/motor";
import { enfileirarWhatsappDaAgencia } from "../whatsapp/enfileirar";
import { textoDoPedidoDeAprovacao, type TipoDeAprovacao } from "./vocabulario";

/** Liga a capacidade `aprovacoes_da_agencia` na organização do cliente (P2), preservando o resto de `settings`. */
export async function ligarAprovacoesNaOrganizacao(organizationId: string): Promise<void> {
  const db = createAdminClient();
  const { data } = await db.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const agencia = (settings.agencia && typeof settings.agencia === "object" ? settings.agencia : {}) as Record<string, unknown>;
  if (agencia.aprovacoes === true) return;
  await db.from("organizations").update({ settings: { ...settings, agencia: { ...agencia, aprovacoes: true } } }).eq("id", organizationId);
}

/** Avisa o cliente (P7): no grupo do contrato, se houver; senão no WhatsApp do responsável. */
export async function avisarClienteDaAprovacao(p: {
  aprovacaoId: string;
  clienteId: string;
  tipo: TipoDeAprovacao;
  titulo: string;
  versao: number;
}): Promise<"grupo" | "responsavel" | "sem_destino" | "sem_whatsapp"> {
  const db = createAdminClient();
  const [{ data: contrato }, { data: cliente }, marca] = await Promise.all([
    db
      .from("agencia_contratos")
      .select("grupo_chat_id")
      .eq("cliente_id", p.clienteId)
      .not("grupo_chat_id", "is", null)
      .order("concluido_em", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("agencia_clientes").select("whatsapp").eq("id", p.clienteId).maybeSingle(),
    marcaDaSaida(null),
  ]);
  const grupo = (contrato as { grupo_chat_id?: string | null } | null)?.grupo_chat_id ?? null;
  const responsavel = (cliente as { whatsapp?: string | null } | null)?.whatsapp;
  const destino = grupo ?? (responsavel ? normalizarWhatsapp(responsavel) : null);
  if (!destino) return "sem_destino";
  const fila = await enfileirarWhatsappDaAgencia({
    motivo: "aprovacao",
    referenciaId: p.aprovacaoId,
    telefone: destino,
    corpo: textoDoPedidoDeAprovacao({
      tipo: p.tipo,
      titulo: p.titulo,
      versao: p.versao,
      agencia: marca.nome,
      url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/app/aprovacoes`,
    }),
  });
  if (!fila.enfileirado) return "sem_whatsapp";
  return grupo ? "grupo" : "responsavel";
}

export interface RespostaDoCliente {
  aprovacaoId: string;
  organizationId: string;
  userId: string;
  decisao: "aprovado" | "ajustes";
  comentario: string | null;
}

/**
 * Grava a resposta do cliente — só se a aprovação é DA organização ativa e ainda
 * está pendente — e faz os efeitos (P6, P8). Devolve false quando não havia o
 * que responder (outra organização, já respondida, cancelada).
 */
export async function registrarResposta(r: RespostaDoCliente): Promise<boolean> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("agencia_aprovacoes")
    .update({ situacao: r.decisao, comentario: r.comentario, respondido_por: r.userId, respondido_em: new Date().toISOString() })
    .eq("id", r.aprovacaoId)
    .eq("organization_id", r.organizationId)
    .eq("situacao", "pendente")
    .select("id, titulo, tarefa_id, publicacao_id, pedido_por, agencia_clientes(nome)");
  if (error || !data?.length) return false;
  const a = data[0] as unknown as {
    id: string;
    titulo: string;
    tarefa_id: string | null;
    publicacao_id: string | null;
    pedido_por: string | null;
    agencia_clientes: { nome: string } | null;
  };

  // A publicação ligada acompanha (SPEC-publicacoes, P3).
  if (a.publicacao_id) await aoResponderAprovacaoDaPublicacao(a.publicacao_id, r.decisao, r.comentario);

  // A tarefa ligada acompanha (P6): aprovado conclui, ajustes devolve com o comentário.
  let alvos: string[] = [];
  if (a.tarefa_id) {
    const agora = new Date().toISOString();
    await db
      .from("agencia_tarefas")
      .update(
        r.decisao === "aprovado"
          ? { coluna: "concluido", concluida_em: agora, atualizada_em: agora }
          : { coluna: "em_andamento", concluida_em: null, atualizada_em: agora },
      )
      .eq("id", a.tarefa_id);
    if (r.decisao === "ajustes" && r.comentario) {
      const { count } = await db.from("agencia_tarefas_checklist").select("id", { count: "exact", head: true }).eq("tarefa_id", a.tarefa_id);
      await db.from("agencia_tarefas_checklist").insert({ tarefa_id: a.tarefa_id, texto: `Ajuste pedido pelo cliente: ${r.comentario}`.slice(0, 300), ordem: count ?? 0 });
    }
    await aoMudarTarefa(a.tarefa_id);
    const { data: resp } = await db.from("agencia_tarefas_responsaveis").select("membro_id").eq("tarefa_id", a.tarefa_id);
    alvos = ((resp ?? []) as Array<{ membro_id: string }>).map((x) => x.membro_id);
  }
  if (alvos.length === 0 && a.pedido_por) {
    const { data: m } = await db.from("agencia_membros").select("id").eq("user_id", a.pedido_por).eq("situacao", "ativo").maybeSingle();
    if (m) alvos = [(m as { id: string }).id];
  }

  // P8: quem estava esperando fica sabendo.
  try {
    const cliente = a.agencia_clientes?.nome ?? "Cliente";
    await criarAviso({
      alvo: alvos.length ? { tipo: "membros", ids: alvos } : { tipo: "gerais" },
      tipo: "aprovacao_respondida",
      titulo: `${r.decisao === "aprovado" ? "Aprovado" : "Pediu ajustes"}: ${a.titulo} — ${cliente}`,
      corpo: r.comentario,
      link: a.tarefa_id ? `/agencia/tarefas?abrir=${a.tarefa_id}` : null,
      referenciaId: a.id,
    });
  } catch (e) {
    logger.warn("agência: resposta gravada, aviso falhou", { detalhe: e instanceof Error ? e.message : String(e) });
  }
  return true;
}
