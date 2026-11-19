/**
 * A OPERAÇÃO DO DIA — a leitura do banco.
 *
 * Uma função, `montarOperacaoDoDia`, que a tela (`/app/operacao`), a rota
 * (`GET /api/v1/operacao/dia`) e o relatório diário (`relatorio-diario.ts`)
 * chamam igual. A REGRA mora em `regras.ts`; aqui só se lê e se monta.
 *
 * ─── Quem filtra a organização ──────────────────────────────────────────────
 *
 * TODA consulta leva `organization_id = orgId` escrito, venha `db` da sessão
 * (a tela: a RLS também filtra, inclusive o escopo de visibilidade da conversa)
 * ou do service role (o cron: aí o filtro escrito é o único). `orgId` vem
 * sempre de fonte confiável — a sessão (`requireRole`) ou a varredura do cron —,
 * nunca do corpo de um pedido.
 *
 * ─── Teto em toda seção ─────────────────────────────────────────────────────
 *
 * Cada lista pede no máximo `TETO_POR_SECAO` linhas. Quando bate o teto, o nome
 * da seção vai para `truncado` e a tela diz que há mais — uma lista cortada que
 * se apresenta inteira seria a pior mentira desta tela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { STATUS_ENCERRADOS_LISTA } from "@/lib/inbox/comando-da-conversa";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { nomeDoCanal } from "@/lib/channels/estado";
import { logger } from "@/lib/logger";

import {
  clienteFalouPorUltimo,
  corteDoDia,
  type ConfiguracaoDaOperacao,
  esperaUmaPessoa,
  esperandoDesde,
  etapaEhDeProposta,
  FERRAMENTA_DE_PRODUTOS,
  juntarProdutos,
  limitesDoDia,
  linhaDeUmDiaQueAcabou,
  type ProdutosPedidos,
  produtosDasChamadas,
  secoesDaConversa,
} from "./regras";
import type {
  AvisoAberto,
  CanalForaDoAr,
  ContagemPorCanal,
  ContatoDaLinha,
  FalhaDaIa,
  FalhaDeMensagem,
  LinhaDeConversa,
  LinhaDeNegocio,
  OperacaoDoDia,
} from "./tipos";

export const TETO_POR_SECAO = 200;

/** Quantas conversas com mensagem recebida no dia a contagem lê. */
const TETO_DA_CONTAGEM = 5000;

/** `tool_calls @> isto`: a execução teve pelo menos uma chamada da busca de produtos. */
export const FILTRO_DA_BUSCA_DE_PRODUTOS = [{ tool_calls: [{ tool_name: FERRAMENTA_DE_PRODUTOS }] }];

/** Uma mensagem `sending` há mais que isto está presa (a mesma régua de `recover-stuck-messages`). */
const PRESA_APOS_MS = 5 * 60_000;

/**
 * Os avisos da Central que são FALHA DE OPERAÇÃO — algo parou de funcionar e
 * alguém precisa agir. Ficam de fora os avisos de rotina (tarefa, proposta,
 * passagem): eles já aparecem nas outras seções ou na própria Central.
 */
export const AVISOS_DE_FALHA = [
  "message_send_stuck",
  "qr_rescan",
  "channel_number_alert",
  "canal_pausado",
  "canal_mudo_sem_numero",
  "job_dead",
  "event_dead",
  "followup_dead",
  "followup_sem_agente",
  "midia_nao_lida",
  "capabilities_missing",
  "aviso_de_caso_nao_entregue",
  "budget_exceeded",
  "assinatura_desconectada",
  "cliente_sem_resposta_na_queda",
  "conhecimento_nao_indexado",
] as const;

const COLUNAS_DA_CONVERSA =
  "id, contact_id, channel, channel_session_id, status, comando_da_conversa, is_group, tags, " +
  "last_inbound_at, last_outbound_at, last_message_at, awaiting_since, bot_silenced_until, " +
  "assigned_to_user_id, assigned_to_user_name, assignee_kind, last_message_preview, created_at";

interface ConversaLida {
  id: string;
  contact_id: string;
  channel: string;
  channel_session_id: string;
  status: string;
  comando_da_conversa: string | null;
  is_group: boolean | null;
  tags: string[] | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  awaiting_since: string | null;
  bot_silenced_until: string | null;
  assigned_to_user_id: string | null;
  assigned_to_user_name: string | null;
  assignee_kind: string | null;
  last_message_preview: string | null;
  created_at: string;
}

interface ContatoLido {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  social_identity: string | null;
}

interface SessaoLida {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  provider: string;
  status: string;
  status_reason: string | null;
  last_status_change_at: string | null;
}

export type NomesDaEquipe = (ids: string[]) => Promise<Map<string, string | null>>;

export interface EntradaDaOperacao {
  db: SupabaseClient;
  orgId: string;
  dia: string;
  fuso: string;
  config: ConfiguracaoDaOperacao;
  agora?: Date;
  /** Nomes dos donos dos negócios. Sem ele, o responsável do negócio sai `null` (não registrado). */
  nomesDaEquipe?: NomesDaEquipe;
}

/** Erro de leitura: sobe, para a rota responder 500 e o cron contar a falha — nunca uma tela vazia que mente. */
export class LeituraDaOperacaoError extends Error {
  constructor(etapa: string, causa: string) {
    super(`operacao-do-dia: ${etapa}: ${causa}`);
    this.name = "LeituraDaOperacaoError";
  }
}

function exigir<T>(etapa: string, r: { data: unknown; error: { message: string } | null }): T {
  if (r.error) throw new LeituraDaOperacaoError(etapa, r.error.message);
  return (r.data ?? ([] as unknown)) as T;
}

/**
 * O literal de array do Postgres com cada etiqueta entre aspas. O supabase-js
 * junta um array por vírgula SEM aspas, e uma etiqueta configurada com espaço,
 * vírgula ou chave quebraria o filtro (ou casaria outra coisa).
 */
export function literalDeArray(valores: readonly string[]): string {
  const aspas = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `{${valores.map(aspas).join(",")}}`;
}

function pedacos<T>(lista: readonly T[], tamanho = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < lista.length; i += tamanho) out.push(lista.slice(i, i + tamanho));
  return out;
}

const vazioPorCanal = (): ContagemPorCanal => ({ whatsapp: 0, instagram: 0, outros: 0, total: 0 });

function contarCanal(c: ContagemPorCanal, canal: string): void {
  if (canal === "whatsapp") c.whatsapp += 1;
  else if (canal === "instagram") c.instagram += 1;
  else c.outros += 1;
  c.total += 1;
}

function rotuloDoNumero(s: SessaoLida | undefined): string | null {
  if (!s) return null;
  // O nome do número, nunca o identificador de transporte da sessão — a mesma
  // regra de `nomeDoCanal` (lib/channels/estado.ts), que é quem decide.
  return nomeDoCanal(s);
}

function contatoDaLinha(id: string | null, c: ContatoLido | undefined): ContatoDaLinha {
  return {
    contact_id: id,
    nome: c ? nomeDoContato(c) : null,
    telefone: c?.phone_number?.trim() || null,
    identidade: c?.social_identity?.trim() || null,
  };
}

export async function montarOperacaoDoDia(entrada: EntradaDaOperacao): Promise<OperacaoDoDia> {
  const { db, orgId, dia, fuso, config } = entrada;
  const agora = entrada.agora ?? new Date();
  const { inicio, fim } = limitesDoDia(dia, fuso);
  const ini = inicio.toISOString();
  const fimIso = fim.toISOString();
  const truncado: string[] = [];
  // O ESTADO DO MOMENTO (quem espera, o que está em proposta, mensagens presas,
  // canais fora do ar, avisos abertos) é o de AGORA, não o do dia. Só se lê numa
  // leitura feita DENTRO do dia; num dia que já acabou as seções saem vazias e a
  // tela diz por quê (`corteDoDia`, a mesma régua).
  const estadoDoMomento = corteDoDia({ inicio: ini, fim: fimIso, lido_em: agora.toISOString() }).estadoDoMomento;
  const tetado = (secao: string, n: number, teto = TETO_POR_SECAO) => {
    if (n >= teto) truncado.push(secao);
  };

  // ── 1. Contadores: quem recebeu mensagem do cliente neste dia, e quem é novo ──
  const comEntrada = exigir<
    Array<{ conversation_id: string; channel: string; primeira_entrada: string; ultima_entrada: string; nova: boolean }>
  >(
    "conversas com entrada",
    await db.rpc("fn_operacao_conversas_com_entrada", {
      p_org: orgId,
      p_inicio: ini,
      p_fim: fimIso,
      p_limite: TETO_DA_CONTAGEM,
    }),
  );
  tetado("contadores", comEntrada.length, TETO_DA_CONTAGEM);
  const novas = vazioPorCanal();
  const ativas = vazioPorCanal();
  const idsComEntrada = new Set<string>();
  const ultimaEntradaNoDia = new Map<string, string>();
  for (const l of comEntrada) {
    idsComEntrada.add(l.conversation_id);
    ultimaEntradaNoDia.set(l.conversation_id, l.ultima_entrada);
    contarCanal(ativas, l.channel);
    if (l.nova) contarCanal(novas, l.channel);
  }

  // ── 2. Quem espera uma pessoa AGORA ──
  const candidatasDeEspera: ConversaLida[] = !estadoDoMomento ? [] : exigir<ConversaLida[]>(
    "aguardando",
    await db
      .from("conversations")
      .select(COLUNAS_DA_CONVERSA)
      .eq("organization_id", orgId)
      .eq("is_group", false)
      .in("comando_da_conversa", ["aguardando", "ninguem", "humano"])
      .not("status", "in", `(${STATUS_ENCERRADOS_LISTA.join(",")})`)
      .order("awaiting_since", { ascending: true, nullsFirst: false })
      .limit(TETO_POR_SECAO),
  );
  tetado("aguardando", candidatasDeEspera.length);
  const aguardando = candidatasDeEspera.filter((c) => esperaUmaPessoa(c, agora));

  // ── 3. Conversas etiquetadas com atividade no dia ──
  const tagsDaSecao = [config.tags.projeto, config.tags.reclamacao, config.tags.urgente, config.tags.produto];
  const etiquetadasBrutas = exigir<ConversaLida[]>(
    "etiquetadas",
    await db
      .from("conversations")
      .select(COLUNAS_DA_CONVERSA)
      .eq("organization_id", orgId)
      .eq("is_group", false)
      .overlaps("tags", literalDeArray(tagsDaSecao))
      .gte("last_message_at", ini)
      .lte("created_at", fimIso)
      .order("last_message_at", { ascending: false })
      .limit(TETO_POR_SECAO * 2),
  );
  tetado("etiquetas", etiquetadasBrutas.length, TETO_POR_SECAO * 2);
  // Atividade NO dia: mensagem do cliente no dia, ou a última mensagem caiu dentro do dia.
  const etiquetadas = etiquetadasBrutas.filter(
    (c) => idsComEntrada.has(c.id) || (c.last_message_at !== null && c.last_message_at < fimIso),
  );

  // ── 4. O que a IA buscou no catálogo, por conversa ──
  const execucoesComBusca = exigir<Array<{ conversation_id: string | null; tool_calls: unknown }>>(
    "buscas de produto",
    await db
      .from("ai_agent_runs")
      .select("conversation_id, tool_calls")
      .eq("organization_id", orgId)
      .eq("is_dry_run", false)
      .not("conversation_id", "is", null)
      .gte("started_at", ini)
      .lt("started_at", fimIso)
      // JSON em TEXTO, de propósito: com um array o supabase-js monta o literal de
      // ARRAY do Postgres (`cs.{...}`), e numa coluna jsonb o filtro não casaria nada.
      .contains("tool_calls", JSON.stringify(FILTRO_DA_BUSCA_DE_PRODUTOS))
      .order("started_at", { ascending: true })
      .limit(TETO_POR_SECAO * 2),
  );
  tetado("produtos", execucoesComBusca.length, TETO_POR_SECAO * 2);
  const produtosPorConversa = new Map<string, ProdutosPedidos>();
  for (const r of execucoesComBusca) {
    if (!r.conversation_id) continue;
    const achado = produtosDasChamadas(r.tool_calls);
    if (achado.termos.length === 0 && achado.encontrados.length === 0) continue;
    const antes = produtosPorConversa.get(r.conversation_id) ?? { termos: [], encontrados: [] };
    produtosPorConversa.set(r.conversation_id, juntarProdutos(antes, achado));
  }

  // Conversas com busca de produto que não vieram pela etiqueta.
  const conhecidas = new Map<string, ConversaLida>();
  for (const c of [...candidatasDeEspera, ...etiquetadasBrutas]) conhecidas.set(c.id, c);
  const faltam = [...produtosPorConversa.keys()].filter((id) => !conhecidas.has(id));
  for (const lote of pedacos(faltam)) {
    const lidas = exigir<ConversaLida[]>(
      "conversas das buscas",
      await db.from("conversations").select(COLUNAS_DA_CONVERSA).eq("organization_id", orgId).in("id", lote),
    );
    for (const c of lidas) conhecidas.set(c.id, c);
  }

  // ── 5. Funil: ganhos, perdidos, em proposta ──
  const colunasDoNegocio =
    "id, title, contact_id, stage_id, status, value_cents, currency, lost_reason, owner_user_id, closed_at, stage_changed_at";
  type NegocioLido = {
    id: string;
    title: string;
    contact_id: string | null;
    stage_id: string;
    status: string;
    value_cents: number | null;
    currency: string | null;
    lost_reason: string | null;
    owner_user_id: string | null;
    closed_at: string | null;
    stage_changed_at: string | null;
  };
  const fechados = async (status: "won" | "lost") =>
    exigir<NegocioLido[]>(
      `negócios ${status}`,
      await db
        .from("crm_leads")
        .select(colunasDoNegocio)
        .eq("organization_id", orgId)
        .eq("status", status)
        .gte("closed_at", ini)
        .lt("closed_at", fimIso)
        .order("closed_at", { ascending: false })
        .limit(TETO_POR_SECAO),
    );
  const ganhos = await fechados("won");
  const perdidos = await fechados("lost");
  tetado("ganhos", ganhos.length);
  tetado("perdidos", perdidos.length);

  const etapas = exigir<Array<{ id: string; name: string }>>(
    "etapas",
    await db.from("crm_stages").select("id, name").eq("organization_id", orgId).eq("is_archived", false).limit(1000),
  );
  const nomeDaEtapa = new Map(etapas.map((e) => [e.id, e.name]));
  const etapasDeProposta = etapas.filter((e) => etapaEhDeProposta(e.name, config.etapas_de_proposta)).map((e) => e.id);
  let emProposta: NegocioLido[] = [];
  if (estadoDoMomento && etapasDeProposta.length > 0) {
    emProposta = exigir<NegocioLido[]>(
      "negócios em proposta",
      await db
        .from("crm_leads")
        .select(colunasDoNegocio)
        .eq("organization_id", orgId)
        .eq("status", "open")
        .in("stage_id", etapasDeProposta.slice(0, 200))
        .order("stage_changed_at", { ascending: false, nullsFirst: false })
        .limit(TETO_POR_SECAO),
    );
    tetado("em_proposta", emProposta.length);
  }
  const mudaram = await db
    .from("crm_leads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .gte("stage_changed_at", ini)
    .lt("stage_changed_at", fimIso);
  // Contagem que falhou não é "não registrado": lança, como as demais leituras.
  if (mudaram.error) throw new LeituraDaOperacaoError("mudanças de etapa", mudaram.error.message);
  const mudaramDeEtapa = mudaram.count ?? null;

  // ── 6. Falhas de operação ──
  type MensagemLida = {
    id: string;
    conversation_id: string;
    contact_id: string;
    status: "failed" | "sending";
    error_code: string | null;
    error_message: string | null;
    created_at: string;
  };
  const colunasDaMensagem = "id, conversation_id, contact_id, status, error_code, error_message, created_at";
  const falhadas = exigir<MensagemLida[]>(
    "mensagens com falha",
    await db
      .from("messages")
      .select(colunasDaMensagem)
      .eq("organization_id", orgId)
      .eq("status", "failed")
      .gte("created_at", ini)
      .lt("created_at", fimIso)
      .order("created_at", { ascending: false })
      .limit(TETO_POR_SECAO),
  );
  const presas: MensagemLida[] = !estadoDoMomento ? [] : exigir<MensagemLida[]>(
    "mensagens presas",
    await db
      .from("messages")
      .select(colunasDaMensagem)
      .eq("organization_id", orgId)
      .eq("status", "sending")
      .lt("created_at", new Date(agora.getTime() - PRESA_APOS_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(TETO_POR_SECAO),
  );
  tetado("mensagens_com_falha", falhadas.length);
  tetado("mensagens_presas", presas.length);

  const execucoesComErro = exigir<
    Array<{ id: string; conversation_id: string | null; contact_id: string | null; error_code: string | null; error_message: string | null; started_at: string }>
  >(
    "execuções da IA com erro",
    await db
      .from("ai_agent_runs")
      .select("id, conversation_id, contact_id, error_code, error_message, started_at")
      .eq("organization_id", orgId)
      .eq("is_dry_run", false)
      .eq("status", "failed")
      .gte("started_at", ini)
      .lt("started_at", fimIso)
      .order("started_at", { ascending: false })
      .limit(TETO_POR_SECAO),
  );
  tetado("execucoes_da_ia", execucoesComErro.length);

  const sessoesForaDoAr: SessaoLida[] = !estadoDoMomento ? [] : exigir<SessaoLida[]>(
    "canais fora do ar",
    await db
      .from("channel_sessions")
      .select("id, display_name, phone_number, provider, status, status_reason, last_status_change_at")
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .neq("status", "WORKING")
      .limit(TETO_POR_SECAO),
  );

  type AvisoLido = { id: string; kind: string; title: string; severity: string; created_at: string };
  const avisosLidos: AvisoLido[] = !estadoDoMomento ? [] : exigir<AvisoLido[]>(
    "avisos abertos",
    await db
      .from("agent_inbox_items")
      .select("id, kind, title, severity, created_at")
      .eq("organization_id", orgId)
      .eq("status", "open")
      .in("kind", [...AVISOS_DE_FALHA])
      .order("created_at", { ascending: false })
      .limit(TETO_POR_SECAO),
  );
  tetado("avisos", avisosLidos.length);

  // ── 7. Hidratar: contatos, números, resumos, próximas ações, conversas dos negócios ──
  const negocios = [...ganhos, ...perdidos, ...emProposta];
  const idsDeContato = new Set<string>();
  for (const c of conhecidas.values()) idsDeContato.add(c.contact_id);
  for (const n of negocios) if (n.contact_id) idsDeContato.add(n.contact_id);
  for (const m of [...falhadas, ...presas]) idsDeContato.add(m.contact_id);
  for (const r of execucoesComErro) if (r.contact_id) idsDeContato.add(r.contact_id);

  const contatos = new Map<string, ContatoLido>();
  for (const lote of pedacos([...idsDeContato])) {
    const lidos = exigir<ContatoLido[]>(
      "contatos",
      await db
        .from("contacts")
        .select("id, name, display_name, phone_number, social_identity")
        .eq("organization_id", orgId)
        .in("id", lote),
    );
    for (const c of lidos) contatos.set(c.id, c);
  }

  const idsDeSessao = new Set<string>([...conhecidas.values()].map((c) => c.channel_session_id));
  const sessoes = new Map<string, SessaoLida>(sessoesForaDoAr.map((s) => [s.id, s]));
  const sessoesQueFaltam = [...idsDeSessao].filter((id) => !sessoes.has(id));
  for (const lote of pedacos(sessoesQueFaltam)) {
    const lidas = exigir<SessaoLida[]>(
      "números",
      await db
        .from("channel_sessions")
        .select("id, display_name, phone_number, provider, status, status_reason, last_status_change_at")
        .eq("organization_id", orgId)
        .in("id", lote),
    );
    for (const s of lidas) sessoes.set(s.id, s);
  }

  // O resumo da passagem mais recente de cada conversa (a mais nova vem primeiro).
  const resumoDaPassagem = new Map<string, string>();
  const motivoDaPassagem = new Map<string, string>();
  for (const lote of pedacos([...conhecidas.keys()])) {
    const passagens = exigir<Array<{ conversation_id: string; title: string | null; body: string; motivo_codigo: string | null }>>(
      "passagens",
      await db
        .from("passagens_de_atendimento")
        .select("conversation_id, title, body, motivo_codigo")
        .eq("organization_id", orgId)
        .in("conversation_id", lote)
        .order("criado_em", { ascending: false })
        .limit(1000),
    );
    for (const p of passagens) {
      if (resumoDaPassagem.has(p.conversation_id) || motivoDaPassagem.has(p.conversation_id)) continue;
      if (p.motivo_codigo) motivoDaPassagem.set(p.conversation_id, p.motivo_codigo);
      const texto = [p.title, p.body].filter((s) => s && s.trim() !== "").join(" — ").trim();
      if (texto !== "") resumoDaPassagem.set(p.conversation_id, texto.slice(0, 400));
    }
  }

  // A próxima tarefa aberta de cada contato (a de prazo mais próximo).
  const proximaTarefa = new Map<string, { titulo: string; vence_em: string | null }>();
  const contatosDasConversas = [...new Set([...conhecidas.values()].map((c) => c.contact_id))];
  for (const lote of pedacos(contatosDasConversas)) {
    const tarefas = exigir<Array<{ contact_id: string | null; title: string; due_date: string | null }>>(
      "tarefas",
      await db
        .from("crm_tasks")
        .select("contact_id, title, due_date")
        .eq("organization_id", orgId)
        .in("contact_id", lote)
        .in("status", ["pending", "in_progress"])
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(1000),
    );
    for (const t of tarefas) {
      if (!t.contact_id || proximaTarefa.has(t.contact_id)) continue;
      proximaTarefa.set(t.contact_id, { titulo: t.title, vence_em: t.due_date });
    }
  }

  // A conversa mais recente do contato de cada negócio — o link da linha.
  const conversaDoContato = new Map<string, string>();
  const contatosDosNegocios = [...new Set(negocios.map((n) => n.contact_id).filter((x): x is string => !!x))];
  for (const lote of pedacos(contatosDosNegocios)) {
    const convs = exigir<Array<{ id: string; contact_id: string }>>(
      "conversas dos negócios",
      await db
        .from("conversations")
        .select("id, contact_id")
        .eq("organization_id", orgId)
        .in("contact_id", lote)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1000),
    );
    for (const c of convs) if (!conversaDoContato.has(c.contact_id)) conversaDoContato.set(c.contact_id, c.id);
  }

  let nomes = new Map<string, string | null>();
  const donos = [...new Set(negocios.map((n) => n.owner_user_id).filter((x): x is string => !!x))];
  if (donos.length > 0 && entrada.nomesDaEquipe) {
    try {
      nomes = await entrada.nomesDaEquipe(donos);
    } catch (err) {
      // Nome do dono é enfeite da linha: sem ele a linha diz "não registrado", e a tela abre.
      logger.warn("operacao-do-dia: nomes da equipe não lidos", {
        orgId,
        causa: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 8. Montar as linhas ──
  const linhaDaConversa = (c: ConversaLida): LinhaDeConversa => {
    const passagem = resumoDaPassagem.get(c.id) ?? null;
    const previa = c.last_message_preview?.trim() || null;
    const ia = c.assignee_kind === "ai" || c.comando_da_conversa === "automatico";
    const pessoa = c.assigned_to_user_id ? c.assigned_to_user_name?.trim() || null : null;
    const produtos = produtosPorConversa.get(c.id);
    const linha: LinhaDeConversa = {
      conversation_id: c.id,
      contato: contatoDaLinha(c.contact_id, contatos.get(c.contact_id)),
      canal: c.channel,
      numero: rotuloDoNumero(sessoes.get(c.channel_session_id)),
      resumo: passagem ?? previa,
      resumo_origem: passagem ? "passagem" : previa ? "ultima_mensagem" : null,
      status: c.status,
      comando: c.comando_da_conversa,
      motivo_codigo: motivoDaPassagem.get(c.id) ?? null,
      proxima_acao: proximaTarefa.get(c.contact_id) ?? null,
      responsavel_user_id: c.assigned_to_user_id,
      responsavel: c.assigned_to_user_id ? pessoa : null,
      responsavel_tipo: c.assigned_to_user_id ? "pessoa" : ia ? "ia" : null,
      ultima_atividade_em: c.last_message_at,
      esperando_desde: clienteFalouPorUltimo(c) || c.comando_da_conversa === "aguardando" ? esperandoDesde(c) : null,
      tags: c.tags ?? [],
      ...(produtos ? { produtos } : {}),
    };
    return estadoDoMomento ? linha : linhaDeUmDiaQueAcabou(linha, fimIso, ultimaEntradaNoDia.get(c.id) ?? null);
  };

  const projetos: LinhaDeConversa[] = [];
  const reclamacoes: LinhaDeConversa[] = [];
  const produtos: LinhaDeConversa[] = [];
  const naSecaoDeProduto = new Set<string>();
  for (const c of etiquetadas) {
    const secoes = secoesDaConversa(c.tags, config.tags);
    if (secoes.includes("projetos")) projetos.push(linhaDaConversa(c));
    if (secoes.includes("reclamacoes")) reclamacoes.push(linhaDaConversa(c));
    if (secoes.includes("produtos")) {
      produtos.push(linhaDaConversa(c));
      naSecaoDeProduto.add(c.id);
    }
  }
  for (const id of produtosPorConversa.keys()) {
    const c = conhecidas.get(id);
    if (!c || naSecaoDeProduto.has(id) || c.is_group) continue;
    produtos.push(linhaDaConversa(c));
  }

  const linhaDoNegocio = (n: NegocioLido): LinhaDeNegocio => ({
    lead_id: n.id,
    titulo: n.title,
    contato: contatoDaLinha(n.contact_id, n.contact_id ? contatos.get(n.contact_id) : undefined),
    conversation_id: n.contact_id ? (conversaDoContato.get(n.contact_id) ?? null) : null,
    etapa: nomeDaEtapa.get(n.stage_id) ?? null,
    status: n.status,
    valor_cents: typeof n.value_cents === "number" ? n.value_cents : null,
    moeda: typeof n.value_cents === "number" ? n.currency : null,
    motivo_da_perda: n.lost_reason?.trim() || null,
    responsavel_user_id: n.owner_user_id,
    responsavel: n.owner_user_id ? (nomes.get(n.owner_user_id) ?? null) : null,
    quando: n.status === "open" ? n.stage_changed_at : n.closed_at,
  });

  const falhasDeMensagem: FalhaDeMensagem[] = [...presas, ...falhadas].map((m) => ({
    message_id: m.id,
    conversation_id: m.conversation_id,
    contato: contatoDaLinha(m.contact_id, contatos.get(m.contact_id)),
    status: m.status,
    codigo: m.error_code,
    erro: m.error_message?.slice(0, 300) ?? null,
    quando: m.created_at,
  }));

  const falhasDaIa: FalhaDaIa[] = execucoesComErro.map((r) => ({
    run_id: r.id,
    conversation_id: r.conversation_id,
    contato: contatoDaLinha(r.contact_id, r.contact_id ? contatos.get(r.contact_id) : undefined),
    codigo: r.error_code,
    erro: r.error_message?.slice(0, 300) ?? null,
    quando: r.started_at,
  }));

  const canais: CanalForaDoAr[] = sessoesForaDoAr.map((s) => ({
    channel_session_id: s.id,
    numero: rotuloDoNumero(s),
    provedor: s.provider,
    status: s.status,
    motivo: s.status_reason,
    desde: s.last_status_change_at,
  }));

  const avisos: AvisoAberto[] = avisosLidos.map((a) => ({
    id: a.id,
    kind: a.kind,
    titulo: a.title,
    severidade: a.severity,
    quando: a.created_at,
  }));

  return {
    versao: 1,
    dia,
    fuso,
    inicio: ini,
    fim: fimIso,
    lido_em: agora.toISOString(),
    tags: { ...config.tags },
    contadores: { novas, com_entrada: ativas },
    aguardando: aguardando.map(linhaDaConversa),
    projetos,
    reclamacoes,
    produtos,
    funil: {
      ganhos: ganhos.map(linhaDoNegocio),
      perdidos: perdidos.map(linhaDoNegocio),
      em_proposta: emProposta.map(linhaDoNegocio),
      mudaram_de_etapa: mudaramDeEtapa,
    },
    falhas: { mensagens: falhasDeMensagem, execucoes_da_ia: falhasDaIa, canais, avisos },
    truncado,
  };
}

/**
 * O leitor de nomes da equipe pelo service role, com a organização ESCRITA.
 * `fn_nomes_dos_membros` só é executável pelo service role e devolve só quem é
 * membro da organização pedida — por isso a organização vem da sessão, nunca
 * do pedido.
 */
export function nomesPelaFuncao(admin: SupabaseClient, orgId: string): NomesDaEquipe {
  return async (ids) => {
    const { data, error } = await admin.rpc("fn_nomes_dos_membros", { p_org: orgId, p_ids: ids });
    if (error) throw new Error(error.message);
    return new Map(((data ?? []) as Array<{ user_id: string; full_name: string | null }>).map((r) => [r.user_id, r.full_name]));
  };
}
