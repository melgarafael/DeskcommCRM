/**
 * OS EFEITOS QUE TRANSFORMAM UMA MENSAGEM EM TRABALHO.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * Gravar a mensagem é só metade da ingestão. A outra metade é o que o CRM FAZ
 * com ela: respeitar quem pediu para sair, abrir a demanda no funil e acordar o
 * agente. Esses três efeitos moravam dentro de `lib/waha/ingest.ts`, e por isso
 * só aconteciam no canal por QR — medido em produção:
 *
 *   ai_agent.dispatch_requested   QR 806   oficial 0
 *   leads a partir da conversa    QR  19   oficial 1  (em 28 conversas)
 *   contatos bloqueados por STOP           0 em 101
 *
 * A pessoa que escrevia para o número oficial entrava no CRM e parava ali. Sem
 * erro, sem log, sem aviso — que é o pior modo de falhar, porque ninguém
 * procura o que não reclama.
 *
 * ─── A ORDEM é a regra, não um detalhe de implementação ─────────────────────
 *
 * Os três rodam em sequência e a sequência carrega significado:
 *
 *   1. opt-out  — grava `is_blocked` ANTES do lead;
 *   2. lead     — `garantirLeadDaConversa` RELÊ o contato e recusa criar card
 *                 para bloqueado. Inverter 1 e 2 faz quem acabou de pedir para
 *                 sair virar oportunidade nova no funil;
 *   3. despacho — o turno do agente resolve o lead ativo do contato. Emitir
 *                 antes do passo 2 faria o primeiro turno rodar sem lead.
 *
 * Trocar a ordem não quebra teste de tipo nem derruba nada em runtime: quebra
 * em silêncio, semanas depois, num card que não devia existir. Por isso está
 * escrito aqui e vigiado por `tests/unit/pos-entrada-*.test.ts`.
 *
 * ─── Nada aqui pode derrubar a ingestão ─────────────────────────────────────
 *
 * A mensagem do cliente JÁ está gravada quando esta função roda. Uma exceção
 * que suba daqui viraria 500 para o provider, e ele reenviaria tudo — trocaria
 * um efeito faltando por uma tempestade de reentregas. Cada passo falha para
 * dentro, com log, e o seguinte roda mesmo assim.
 */
import { audit } from "@/lib/audit";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { acelerarPipelineDeEventos } from "@/lib/dev/kick-local-pipeline";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { casarCampanha, lerCampanhas } from "@/lib/ai/elegibilidade/campanha";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Quem pediu para sair, sai — mas quem só usou a palavra, não.
 *
 * A regra mora em `lib/opt-out/deteccao.ts`, e não aqui, porque o vocabulário do
 * opt-out é regra de negócio (e de LGPD) do produto inteiro — não característica
 * de um transporte. Uma cópia por canal diverge na primeira vez que alguém
 * acrescentar um termo, e foi exatamente o que aconteceu: o runtime tinha um
 * detector calibrado enquanto ESTE caminho, o que grava o bloqueio, usava uma
 * regex de palavra solta.
 *
 * ─── A história deste ponto, em duas correções ──────────────────────────────
 *
 * A primeira versão usava `\b`, que em JavaScript é ASCII: "amanhã ele sairá" e
 * "pararão as obras" bloqueavam o contato, porque a letra acentuada vira
 * fronteira. Trocou-se por lookarounds Unicode e a colagem parou de casar.
 *
 * Mas o falso positivo continuou, porque o alvo estava errado: a regex caçava a
 * PALAVRA em qualquer posição da frase. Medido numa clínica em produção,
 * "tem como parar a dor?" e "posso sair antes das 15h?" bloqueavam o paciente na
 * ingestão — e todo envio seguinte voltava `contato_bloqueado`. Ele sumia sem
 * ninguém saber. O mesmo erro escondia o outro lado: "não quero mais receber",
 * que é opt-out inequívoco, passava batido.
 *
 * O que vale agora é a INTENÇÃO — verbo de cessação com objeto de comunicação,
 * ou a palavra sozinha. O falso positivo continua sendo o pior dos dois erros
 * possíveis aqui: quem pede para sair e não é atendido reclama de novo; quem é
 * bloqueado sem pedir simplesmente some.
 */

export interface EntradaDeMensagem {
  organizationId: string;
  contactId: string;
  conversationId: string;
  /**
   * `null` quando a linha não nasceu agora (reentrega).
   *
   * Sem id não há o que despachar: o agente precisa da mensagem que disparou o
   * turno, e inventar um id faria o worker buscar uma linha inexistente.
   */
  messageId: string | null;
  channelSessionId: string;
  /** O texto que o cliente escreveu — é onde se procura o pedido de saída. */
  texto: string | null;
  /** Nome exibido pelo canal, quando houver. Serve para batizar o card novo. */
  nomeDoContato: string | null;
  /** Correlaciona a linha de auditoria com a request que a originou. */
  requestId?: string;
  /**
   * Rótulo da origem, só para `metadata` e log.
   *
   * Não é decisão: nenhum passo abaixo ramifica por este valor. Serve para que,
   * lendo o `event_log` meses depois, se saiba por onde a mensagem entrou.
   */
  origem: string;
}

/**
 * Roda os três efeitos, em ordem, para uma mensagem de ENTRADA recém-gravada.
 *
 * Só para `inbound`: um envio nosso (ou feito do celular do operador) não pede
 * para sair, não abre demanda e não acorda o agente.
 */
export async function aplicarEfeitosPosEntrada(
  admin: Admin,
  entrada: EntradaDeMensagem,
): Promise<void> {
  await aplicarOptOut(admin, entrada);
  await abrirDemanda(admin, entrada);
  await avaliarCampanha(admin, entrada);
  // A resposta do lead avança o follow-up AQUI. O despacho do agente (LLM)
  // vem depois: no Hobby ele estoura o tempo da request e o próximo texto
  // do fluxo ficava esperando o relógio.
  await acelerarPipelineDeEventos(admin, {
    organizationId: entrada.organizationId,
    contactId: entrada.contactId,
    messageId: entrada.messageId,
    texto: entrada.texto,
  });
  await pedirDespachoDoAgente(admin, entrada);
}

/**
 * 2b · A mensagem casa uma campanha registrada? (caso 2 da elegibilidade)
 *
 * Campanhas de Meta/Google que levam direto para o WhatsApp: o lead chega com
 * uma mensagem identificadora ("Quero saber mais sobre X"). Se ela casar uma
 * campanha em `organizations.settings.campanhas_whatsapp`, o contato fica
 * elegível para a IA. Só faz sentido consultar quando o canal tem o gate
 * `allowlist` ligado — no gate 'open' a IA já responde todo mundo. Roda ANTES do
 * despacho: o evento `ai_agent.dispatch_requested` desta mesma mensagem precisa
 * já encontrar o contato autorizado.
 *
 * Best-effort: qualquer falha aqui vira log e o despacho segue (e cai no
 * atendimento humano, o lado seguro).
 */
async function avaliarCampanha(admin: Admin, entrada: EntradaDeMensagem): Promise<void> {
  if (!entrada.texto || entrada.texto.trim() === "") return;
  try {
    const { data: sess } = await admin
      .from("channel_sessions")
      .select("metadata")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.channelSessionId)
      .maybeSingle();
    const gate = (sess?.metadata as Record<string, unknown> | null)?.ai_gate;
    if (gate !== "allowlist") return;

    const { data: contato } = await admin
      .from("contacts")
      .select("ai_authorized_at")
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId)
      .maybeSingle();
    if (contato?.ai_authorized_at != null) return; // já elegível — não reescreve a origem

    const { data: org } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    const campanhas = lerCampanhas(org?.settings ?? null);
    const casada = casarCampanha(entrada.texto, campanhas, entrada.channelSessionId);
    if (casada === null) return;

    await autorizarContatoParaIA(admin, {
      organizationId: entrada.organizationId,
      contactId: entrada.contactId,
      reason: `campanha:${casada.id}`,
      apenasSeNaoAutorizado: true,
    });
    logger.info("pos-entrada: contato autorizado para IA por campanha", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      campanha: casada.id,
    });
  } catch (err) {
    logger.warn("pos-entrada: avaliação de campanha falhou (o despacho segue)", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}

/**
 * 1 · Quem pediu para sair, sai.
 *
 * O update é incondicional (não filtra por `is_blocked` atual) de propósito:
 * regravar `true` sobre `true` é barato, e a linha de auditoria de cada pedido
 * é justamente o que prova, depois, que o pedido chegou e foi respeitado.
 */
async function aplicarOptOut(admin: Admin, entrada: EntradaDeMensagem): Promise<void> {
  if (!ehPedidoDeOptOut(entrada.texto)) return;

  try {
    const agora = new Date().toISOString();
    const { error } = await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: agora })
      .eq("organization_id", entrada.organizationId)
      .eq("id", entrada.contactId);

    if (error) {
      // Falhar em silêncio aqui é o pior desfecho possível do arquivo inteiro:
      // o cliente pediu para sair, o sistema não gravou, e a campanha segue
      // escrevendo. Por isso é `error` e não `warn`.
      logger.error("pos-entrada: opt-out NAO gravado — o contato segue recebendo", {
        organization_id: entrada.organizationId,
        contact_id: entrada.contactId,
        origem: entrada.origem,
        detail: error.message.slice(0, 160),
      });
      return;
    }

    await audit({
      action: "contact.blocked",
      organizationId: entrada.organizationId,
      resourceType: "contact",
      requestId: entrada.requestId,
      metadata: { reason: "stop_keyword", contact_id: entrada.contactId, origem: entrada.origem },
    });
  } catch (err) {
    logger.error("pos-entrada: opt-out NAO gravado — o contato segue recebendo", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      origem: entrada.origem,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}

/**
 * 2 · A conversa vira demanda no funil.
 *
 * `garantirLeadDaConversa` é idempotente por contato e já recusa contato
 * bloqueado — por isso o passo 1 vem antes.
 */
async function abrirDemanda(admin: Admin, entrada: EntradaDeMensagem): Promise<void> {
  try {
    const nascimento = await garantirLeadDaConversa(admin, {
      organizationId: entrada.organizationId,
      contactId: entrada.contactId,
      conversationId: entrada.conversationId,
      nomeDoContato: entrada.nomeDoContato,
    });

    // Os DOIS desfechos viram log. Sem a linha do "não criou", o silêncio de
    // "já existia" e o de "a organização não tem funil configurado" têm a mesma
    // cara — e o segundo é falha de configuração que alguém precisa ver.
    logger.info(nascimento.criado ? "pos-entrada: lead criado" : "pos-entrada: lead nao criado", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      origem: entrada.origem,
      ...(nascimento.criado ? { lead_id: nascimento.leadId } : { motivo: nascimento.motivo }),
    });
  } catch (err) {
    logger.error("pos-entrada: nascimento do lead falhou (a mensagem entra assim mesmo)", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      origem: entrada.origem,
      error: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }
}

/**
 * 3 · Acorda o agente.
 *
 * Emitir o evento NÃO faz o assistente responder: o consumidor só abre turno se
 * a organização tiver versão publicada apontando para esta sessão. Sem versão
 * publicada, o evento é gravado e nada acontece — que é o estado de quem atende
 * à mão. O que este passo conserta é a cañería, não a decisão de ligar o robô.
 *
 * O payload é o MESMO dos dois canais, campo a campo. Um payload por canal
 * faria o consumidor adivinhar de quem veio — e o consumidor é um só
 * (`lib/agent-engine/edge/crm/drain.ts`).
 */
async function pedirDespachoDoAgente(admin: Admin, entrada: EntradaDeMensagem): Promise<void> {
  if (!entrada.messageId) return;

  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "ai_agent.dispatch_requested",
    p_entity_kind: "message",
    p_entity_id: entrada.messageId,
    p_payload: {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      contact_id: entrada.contactId,
      channel_session_id: entrada.channelSessionId,
      inbound_message_id: entrada.messageId,
    },
    p_metadata: { source: entrada.origem, request_id: entrada.requestId },
    p_organization_id: entrada.organizationId,
  } as never);

  if (error) {
    logger.warn("pos-entrada: emit ai_agent.dispatch_requested falhou", {
      organization_id: entrada.organizationId,
      message_id: entrada.messageId,
      origem: entrada.origem,
      detail: error.message.slice(0, 160),
    });
  }
}
