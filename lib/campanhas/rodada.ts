/**
 * Uma RODADA de campanha: no máximo um envio por NÚMERO, e só se o ritmo
 * permitir.
 *
 * ═══ Por que um por número, e não um lote ═══
 *
 * O ritmo é o produto. Quem dispara 500 de uma vez queima o número, e número
 * queimado não volta em dias — volta em semanas de warm-up, com o cliente sem
 * canal. A rodada pergunta ao motor de pacing (o MESMO do agente, não um espelho)
 * se pode enviar AGORA, envia um, registra no `pacing_ledger`, e acabou. A
 * cadência real é a do cron × a do throttle, o que for mais lento.
 *
 * Um por NÚMERO e não um por instalação: duas conexões diferentes não disputam
 * ritmo entre si — o `pacing_ledger` é por `channel_session_id` —, e serializar
 * tudo faria a campanha de um cliente esperar a do outro.
 *
 * ═══ Por que o motor de pacing do AGENTE ═══
 *
 * `lib/automation/throttle.ts` espaça por um `Map` de módulo (não sobrevive a
 * restart nem a dois processos) e o cap diário dele lê `channel_session_warmup`,
 * tabela sem escritor — o ramo nunca dispara (medido; está escrito no cabeçalho
 * de lá). Campanha é exatamente o caso que estoura número: precisa do contador
 * real (`pacing_ledger`) e do mesmo lock por número que a cadeia de envio usa,
 * para campanha e agente não furarem o ritmo um do outro.
 *
 * ═══ Por que a rodada vazia não audita ═══
 *
 * Regra do `CLAUDE.md`: rodada de cron que não fez nada NÃO é mutação. Numa
 * instalação sem campanha rodando, auditar cada tique encheria o audit log — foi
 * o achado 17 do mapa de jornadas (95% do audit log de uma VPS era batida de
 * cron vazia).
 *
 * Nunca lança para o cron: uma campanha quebrada não pode derrubar a rodada.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decidePacing, dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { loadChannelKnobs, loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { logger } from "@/lib/logger";

import { motivoParaExcluir, recusouMarketing } from "./elegibilidade";
import { hashDoEndereco } from "./exclusoes";
import { renderizar } from "./renderizador";
import { escolherNumero, poolDaCampanha, type NumeroDisponivel } from "./rodizio";
import { podeMandarAgora, proximaTentativa, type RitmoDaCampanha } from "./ritmo";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { TEXTO_DA_EXCLUSAO } from "./tipos";

export interface ResultadoDaRodada {
  /** Mensagens que saíram de fato. */
  enviadas: number;
  /** Destinatários marcados como excluídos nesta rodada (veto revalidado). */
  pulados: number;
  /** Campanhas que terminaram. */
  concluidas: number;
  /** Campanhas agendadas que viraram `running` porque a hora chegou. */
  promovidas: number;
  detalhe: string;
}

const VAZIA: ResultadoDaRodada = {
  enviadas: 0,
  pulados: 0,
  concluidas: 0,
  promovidas: 0,
  detalhe: "nada_a_fazer",
};

/** Teto de números atendidos por rodada — a rodada é de um minuto, não de um dia. */
const NUMEROS_POR_RODADA = 10;

interface CampanhaRow {
  id: string;
  organization_id: string;
  /** O número PRINCIPAL. O pool efetivo inclui os vinculados (migration 0377). */
  channel_session_id: string;
  name: string;
  message_body: string | null;
  content_version: number;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
}

const COLUNAS_DA_CAMPANHA =
  "id, organization_id, channel_session_id, name, message_body, content_version, " +
  "intervalo_segundos, janela_inicio_hora, janela_fim_hora, teto_diario, teto_horario";

export async function rodarUmaRodadaDeCampanha(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<ResultadoDaRodada> {
  // Organização SUSPENSA não prospecta. A decisão é a mesma da fila do agente:
  // `= 'suspended'` e não `<> 'active'`, porque o CHECK aceita também 'redacted'
  // e 'archived', e desligá-los seria mudança que ninguém pediu.
  const { data: suspensas } = await admin.from("organizations").select("id").eq("status", "suspended");
  const idsSuspensas = (suspensas ?? []).map((o) => (o as { id: string }).id);

  const promovidas = await promoverAgendadas(admin, idsSuspensas, agora);

  let consulta = admin
    .from("campaigns")
    .select(COLUNAS_DA_CAMPANHA)
    .eq("status", "running")
    .order("started_at", { ascending: true })
    .limit(NUMEROS_POR_RODADA * 3);
  if (idsSuspensas.length > 0) {
    consulta = consulta.not("organization_id", "in", `(${idsSuspensas.join(",")})`);
  }
  const { data: campanhas } = await consulta;
  // `as unknown as`: a lista de colunas é montada por concatenação, e o tipo
  // gerado do PostgREST só sabe inferir literal — o mesmo caminho que
  // `lib/asaas/*` já usa para tabela que ainda não está em `database.types.ts`.
  const emExecucao = (campanhas ?? []) as unknown as CampanhaRow[];
  if (emExecucao.length === 0) {
    return promovidas > 0 ? { ...VAZIA, promovidas, detalhe: "promovidas" } : VAZIA;
  }

  const numerosAtendidos = new Set<string>();
  const total: ResultadoDaRodada = { ...VAZIA, promovidas, detalhe: "" };
  const detalhes: string[] = [];

  for (const campanha of emExecucao) {
    // Um número, uma mensagem por rodada. A campanha mais antiga do número ganha
    // a vez: sem isso, a última criada poderia monopolizar a fila para sempre.
    if (numerosAtendidos.has(campanha.channel_session_id)) continue;
    if (numerosAtendidos.size >= NUMEROS_POR_RODADA) break;

    try {
      const r = await rodarUmaCampanha(admin, campanha, agora);
      total.enviadas += r.enviadas;
      total.pulados += r.pulados;
      total.concluidas += r.concluidas;
      detalhes.push(`${campanha.id.slice(0, 8)}:${r.detalhe}`);
      // Só ocupa o número quem de fato enviou: campanha parada por ritmo não
      // pode impedir a campanha seguinte do mesmo número de ser avaliada... mas
      // se o veto foi do CANAL, a seguinte receberia o mesmo veto. Ocupar em
      // ambos os casos economiza a consulta; o que não pode é ocupar quando a
      // campanha só CONCLUIU (aí o número está livre de verdade).
      if (r.concluidas === 0) numerosAtendidos.add(campanha.channel_session_id);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      logger.warn("[campanha] rodada falhou", { campanha: campanha.id, motivo });
      detalhes.push(`${campanha.id.slice(0, 8)}:erro`);
      numerosAtendidos.add(campanha.channel_session_id);
    }
  }

  total.detalhe = detalhes.join(" ") || "nada_a_fazer";
  return total;
}

/** `scheduled` cuja hora chegou vira `running`. */
async function promoverAgendadas(
  admin: SupabaseClient,
  idsSuspensas: string[],
  agora: Date,
): Promise<number> {
  let consulta = admin
    .from("campaigns")
    .update({ status: "running", started_at: agora.toISOString() })
    .eq("status", "scheduled")
    .lte("scheduled_at", agora.toISOString());
  if (idsSuspensas.length > 0) {
    consulta = consulta.not("organization_id", "in", `(${idsSuspensas.join(",")})`);
  }
  const { data, error } = await consulta.select("id");
  if (error) {
    logger.warn("[campanha] promoção de agendadas falhou", { motivo: error.message });
    return 0;
  }
  return (data ?? []).length;
}

interface DestinatarioRow {
  id: string;
  contact_id: string;
  recipient_address: string | null;
  rendered_body: string | null;
  contacts: {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    is_blocked: boolean;
    is_anonymized: boolean;
    consent: unknown;
  } | null;
}

async function rodarUmaCampanha(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  agora: Date,
): Promise<{ enviadas: number; pulados: number; concluidas: number; detalhe: string }> {
  const { data: fila } = await admin
    .from("campaign_recipients")
    .select(
      "id, contact_id, recipient_address, rendered_body, " +
        "contacts(id, name, display_name, phone_number, is_blocked, is_anonymized, consent)",
    )
    .eq("campaign_id", campanha.id)
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(1);
  const alvo = (fila ?? [])[0] as DestinatarioRow | undefined;

  if (!alvo) {
    // Nada pendente AGORA não é o mesmo que nada pendente: pode haver gente
    // esperando `next_attempt_at`. Só conclui quem não tem mais nenhum em voo.
    const { count } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campanha.id)
      .in("status", ["pending", "queued", "sending"]);
    if ((count ?? 0) > 0) return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "aguardando" };

    const { data } = await admin
      .from("campaigns")
      .update({ status: "completed", completed_at: agora.toISOString() })
      .eq("id", campanha.id)
      .eq("status", "running")
      .select("id");
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: (data ?? []).length,
      detalhe: (data ?? []).length > 0 ? "concluida" : "ja_concluida",
    };
  }

  // ─── Os vetos por PESSOA, revalidados ───
  // Vêm ANTES do ritmo de propósito: pular não gasta janela de envio, e uma fila
  // cheia de bloqueados não pode consumir o teto diário do número. E são
  // revalidados porque entre a preparação e agora a pessoa pode ter pedido para
  // parar — honrar o pedido com um dia de atraso é o mesmo que não honrar.
  const contato = alvo.contacts;
  const motivo = motivoParaExcluir({
    contactId: alvo.contact_id,
    telefone: contato?.phone_number ?? alvo.recipient_address,
    bloqueado: !!contato?.is_blocked,
    anonimizado: !!contato?.is_anonymized,
    recusouMarketing: recusouMarketing(contato?.consent),
  });
  if (motivo) {
    await admin
      .from("campaign_recipients")
      .update({
        status: motivo === "opt_out" ? "opted_out" : "skipped",
        eligibility_status: "excluded",
        exclusion_reason: motivo,
        opted_out_at: motivo === "opt_out" ? agora.toISOString() : null,
      })
      .eq("id", alvo.id)
      .eq("status", "pending");
    return { enviadas: 0, pulados: 1, concluidas: 0, detalhe: `pulado:${motivo}` };
  }

  // A lista de exclusão da operação, revalidada AQUI e não só na preparação:
  // ela pode ter crescido depois do snapshot, e o ponto dela é impedir o envio.
  const enderecoAtual = (contato?.phone_number ?? alvo.recipient_address ?? "").trim();
  if (enderecoAtual !== "") {
    const { data: suprimido } = await admin
      .from("campaign_suppressions")
      .select("id")
      .eq("organization_id", campanha.organization_id)
      .eq("recipient_address_hash", hashDoEndereco(enderecoAtual))
      .maybeSingle();
    if (suprimido) {
      await admin
        .from("campaign_recipients")
        .update({
          status: "skipped",
          eligibility_status: "excluded",
          exclusion_reason: "suprimido",
        })
        .eq("id", alvo.id)
        .eq("status", "pending");
      return { enviadas: 0, pulados: 1, concluidas: 0, detalhe: "pulado:suprimido" };
    }
  }

  // ─── O ritmo da CAMPANHA, que vale para ela inteira ───
  //
  // Antes do rodízio de propósito: o intervalo e o teto da campanha somam TODOS
  // os números dela. Quem quer que o rodízio aumente o volume deixa o ritmo da
  // campanha em branco e herda o de cada número; quem põe 60s aqui manda uma a
  // cada 60s no total, com um número ou com cinco.
  const pool = getRequestPool();
  const ritmo: RitmoDaCampanha = {
    intervaloSegundos: campanha.intervalo_segundos,
    janelaInicioHora: campanha.janela_inicio_hora,
    janelaFimHora: campanha.janela_fim_hora,
    tetoDiario: campanha.teto_diario,
    tetoHorario: campanha.teto_horario,
  };
  const numeros = await numerosDaCampanha(admin, campanha);
  // O fuso da janela da campanha é o do número PRINCIPAL: ela é uma decisão da
  // campanha, e precisa de um relógio só — três números em fusos diferentes
  // fariam a mesma campanha abrir e fechar a janela três vezes.
  const knobsDoPrincipal = await loadChannelKnobs(pool, campanha.organization_id, campanha.channel_session_id);
  // ⚠️ O estado do ritmo é lido DEPOIS dos knobs porque precisa do MESMO fuso
  // que a janela usa. Com `setUTCHours`, o "dia" virava 21h no horário de
  // Brasília — DENTRO da janela de envio —, e uma campanha que já tinha batido
  // o teto diário voltava a enviar com uma hora de janela pela frente.
  const estado = await estadoDeEnvio(admin, campanha.id, agora, knobsDoPrincipal.knobs.timezone);
  const doRitmo = podeMandarAgora(ritmo, estado, agora, knobsDoPrincipal.knobs.timezone);
  if (!doRitmo.pode) {
    // Espera não é falha: grava QUANDO tentar de novo para a fila não ser varrida
    // a cada tique por uma campanha que só volta amanhã.
    const proxima = proximaTentativa(doRitmo, agora);
    if (proxima) {
      await admin
        .from("campaign_recipients")
        .update({ next_attempt_at: proxima.toISOString() })
        .eq("id", alvo.id)
        .eq("status", "pending");
    }
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `ritmo:${doRitmo.motivo}` };
  }

  // ─── O RODÍZIO: qual número fala com esta pessoa ───
  const disponiveis: NumeroDisponivel[] = [];
  const knobsPorNumero = new Map<string, Awaited<ReturnType<typeof loadChannelKnobs>>>();
  for (const sessionId of numeros) {
    const k =
      sessionId === campanha.channel_session_id
        ? knobsDoPrincipal
        : await loadChannelKnobs(pool, campanha.organization_id, sessionId);
    knobsPorNumero.set(sessionId, k);

    const { data: canal } = await admin
      .from("channel_sessions")
      .select("daily_message_limit, status")
      .eq("organization_id", campanha.organization_id)
      .eq("id", sessionId)
      .maybeSingle();
    const linha = canal as { daily_message_limit: number | null; status: string } | null;
    // Número fora do ar não entra no rodízio: mandar por ele seria fabricar uma
    // mensagem presa em `sending` que o recovery depois marca como falha.
    if (!linha || linha.status !== "WORKING") continue;

    const estadoDoNumero = await loadPacingState(pool, campanha.organization_id, sessionId, {
      now: agora,
      timezone: k.knobs.timezone,
      numberActivatedAt: k.numberActivatedAt,
    });
    const decisao = decidePacing({
      now: agora,
      knobs: k.knobs,
      state: estadoDoNumero,
      crmDailyLimit: linha.daily_message_limit ?? null,
    });
    disponiveis.push({
      sessionId,
      folgaDoDia:
        linha.daily_message_limit === null
          ? null
          : Math.max(0, linha.daily_message_limit - estadoDoNumero.sentToday),
      podeAgora: decisao.allow,
      ultimoEnvio: estadoDoNumero.lastSentAt,
    });
  }

  const escolha = escolherNumero(disponiveis, await numeroDoHistorico(admin, campanha, alvo.contact_id));
  if (!escolha) {
    // Nenhum número pode agora. Não é falha do destinatário: é o ritmo dos
    // números. Volta para a fila e tenta no próximo tique.
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "canal:sem_numero_livre" };
  }
  const sessionEscolhida = escolha.sessionId;
  const knobs = knobsPorNumero.get(sessionEscolhida)!.knobs;

  // ─── O envio ───
  // O id da mensagem nasce AQUI, e não do insert: com ele, o destinatário já
  // aponta para a mensagem antes de ela existir, e o trigger de ack sempre
  // encontra a linha. É também a chave de idempotência do `sendMessageHandler` —
  // uma repetição depois de queda relê a linha em vez de mandar de novo.
  const messageId = randomUUID();
  const reserva = await reservarDestinatario(admin, alvo.id, agora);
  if (!reserva.reservado) {
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: 0,
      detalhe: reserva.erro ? `erro_na_reserva:${reserva.erro.slice(0, 40)}` : "ja_reservado",
    };
  }

  // O corpo é montado DEPOIS do ritmo: a saudação ("bom dia" × "boa tarde") tem
  // de ser a do instante em que a mensagem SAI, no fuso do canal. Montá-la na
  // preparação produziria "bom dia" numa mensagem enviada à tarde — foi o
  // defeito do primeiro piloto.
  const congelado = alvo.rendered_body ?? campanha.message_body ?? "";
  const corpo = renderizar(
    congelado,
    { nome: nomeDoContato(contato) },
    { agora, fuso: knobs.timezone },
  ).texto;

  try {
    const boundary = await beginServiceAtOrigin(
      admin,
      campanha.organization_id,
      alvo.contact_id,
      sessionEscolhida,
    );
    await admin
      .from("campaign_recipients")
      .update({ conversation_id: boundary.conversation_id, channel_session_id: sessionEscolhida })
      .eq("id", alvo.id);

    const mensagem = await sendMessageHandler(
      admin,
      {
        organization_id: campanha.organization_id,
        serviceBoundary: boundary,
        proactiveContext: { organizationId: campanha.organization_id, contactId: alvo.contact_id },
        actor: { type: "webhook_source", id: `campaign:${campanha.id}` },
        requestId: `campaign:${campanha.id}:${alvo.id}`,
        internalMessageId: messageId,
      } as Parameters<typeof sendMessageHandler>[1],
      {
        conversation_id: boundary.conversation_id,
        type: "text",
        body: corpo,
        metadata: {
          source: "campaign",
          campaign_id: campanha.id,
          campaign_recipient_id: alvo.id,
          campaign_content_version: campanha.content_version,
          idempotency_key: `campaign:${alvo.id}`,
        },
      } as Parameters<typeof sendMessageHandler>[2],
    );
    await recordSend(pool, campanha.organization_id, sessionEscolhida, agora);

    // O desfecho vem do ESTADO da mensagem, nunca da ausência de exceção — o
    // handler marca `failed` e devolve normalmente.
    const status = (mensagem as { status?: string }).status;
    const falhou = status === "failed";
    // `.eq("status","sending")` porque o ack pode ter chegado ANTES desta linha:
    // o trigger já teria avançado o destinatário para `sent`/`delivered`, e
    // escrever por cima o rebaixaria.
    await admin
      .from("campaign_recipients")
      .update({
        status: falhou ? "failed" : "sent",
        sent_at: falhou ? null : agora.toISOString(),
        last_error_code: falhou ? "send_failed" : null,
        // O `message_id` só pode ser gravado AQUI: a coluna tem FK para
        // `messages`, e a linha da mensagem só existe depois do envio. Gravá-lo
        // antes — que era o desenho original, para o trigger de ack sempre achar
        // o destinatário — viola a FK e a reserva falha inteira.
        message_id: (mensagem as { id?: string }).id ?? messageId,
      })
      .eq("id", alvo.id)
      .eq("status", "sending");

    return {
      enviadas: falhou ? 0 : 1,
      pulados: 0,
      concluidas: 0,
      detalhe: `enviado:${status ?? "?"}:${escolha.motivo}`,
    };
  } catch (err) {
    const motivoErro = err instanceof Error ? err.message : String(err);
    logger.warn("[campanha] envio falhou", { campanha: campanha.id, destinatario: alvo.id });
    await admin
      .from("campaign_recipients")
      .update({
        status: "failed",
        last_error_code: "send_exception",
        last_error_detail: motivoErro.slice(0, 300),
      })
      .eq("id", alvo.id)
      .eq("status", "sending");
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "falhou" };
  }
}

/**
 * Reserva o destinatário para ESTA rodada: `pending` → `sending`, em
 * compare-and-set.
 *
 * ═══ Por que o erro é devolvido, e não engolido ═══
 *
 * A primeira versão lia só o `data` do update. Qualquer falha dura — e houve
 * uma, a FK de `message_id` — virava "zero linhas", que o chamador lia como
 * "outro worker ganhou a corrida". Resultado medido em produção: a campanha
 * ficava `running` para sempre, o destinatário `pending` com zero tentativas, e
 * o cron respondia `ja_reservado` a cada minuto. Um erro disfarçado de
 * concorrência é a pior espécie: ele descreve um sistema saudável.
 */
export async function reservarDestinatario(
  admin: SupabaseClient,
  destinatarioId: string,
  agora: Date,
): Promise<{ reservado: boolean; erro?: string }> {
  const { data, error } = await admin
    .from("campaign_recipients")
    .update({
      status: "sending",
      sending_at: agora.toISOString(),
      last_attempt_at: agora.toISOString(),
      attempt_count: 1,
    })
    .eq("id", destinatarioId)
    .eq("status", "pending")
    .select("id");
  if (error) {
    logger.warn("[campanha] reserva do destinatário falhou", {
      destinatario: destinatarioId,
      motivo: error.message,
    });
    return { reservado: false, erro: error.message };
  }
  return { reservado: (data ?? []).length > 0 };
}

/**
 * Os números que esta campanha pode usar: o principal mais os vinculados.
 *
 * Falha ABERTA no principal: se a consulta dos vinculados quebrar, a campanha
 * segue falando pelo número principal em vez de parar. Rodízio é otimização;
 * parar de enviar por causa dela seria o remédio pior que a doença.
 */
async function numerosDaCampanha(admin: SupabaseClient, campanha: CampanhaRow): Promise<string[]> {
  const { data, error } = await admin
    .from("campaign_channel_sessions")
    .select("channel_session_id")
    .eq("organization_id", campanha.organization_id)
    .eq("campaign_id", campanha.id);
  if (error) {
    logger.warn("[campanha] pool de números falhou; seguindo pelo principal", {
      campanha: campanha.id,
      motivo: error.message,
    });
    return [campanha.channel_session_id];
  }
  return poolDaCampanha(
    campanha.channel_session_id,
    (data ?? []).map((l) => (l as { channel_session_id: string }).channel_session_id),
  );
}

/**
 * O número em que esta pessoa JÁ conversa, se houver.
 *
 * A conversa mais recente ganha: se ela falou com dois números da empresa, o
 * último é o que ela tem na cabeça.
 */
async function numeroDoHistorico(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  contactId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("conversations")
    .select("channel_session_id, last_message_at")
    .eq("organization_id", campanha.organization_id)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  const linha = (data ?? [])[0] as { channel_session_id: string } | undefined;
  return linha?.channel_session_id ?? null;
}

/** Quantas saíram hoje e na última hora, mais o último envio — o estado do ritmo. */
export async function estadoDeEnvio(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  fuso: string,
): Promise<{ ultimoEnvio: Date | null; enviadasHoje: number; enviadasNaUltimaHora: number }> {
  // O dia do teto diário é o dia DO CLIENTE, como o resto do ritmo. Ver a nota
  // no chamador: `setUTCHours` fazia o dia virar 21h em `America/Sao_Paulo`.
  const inicioDoDia = dayStartInTz(agora, fuso);
  const { data } = await admin
    .from("campaign_recipients")
    .select("sent_at")
    .eq("campaign_id", campanhaId)
    .not("sent_at", "is", null)
    .gte("sent_at", inicioDoDia.toISOString())
    .order("sent_at", { ascending: false });

  const enviados = (data ?? []).map((r) => new Date((r as { sent_at: string }).sent_at));
  const umaHoraAtras = agora.getTime() - 3_600_000;
  return {
    ultimoEnvio: enviados[0] ?? null,
    enviadasHoje: enviados.length,
    enviadasNaUltimaHora: enviados.filter((d) => d.getTime() >= umaHoraAtras).length,
  };
}

/** Exportado só para a tela e o teste lerem a mesma frase do motivo. */
export { TEXTO_DA_EXCLUSAO };
