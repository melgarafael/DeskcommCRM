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
import { idsDosCanaisDesativados } from "@/lib/channels/desativado";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";
import type { CanonicalLostReason } from "@/lib/schemas/leads";
import {
  ehAPrimeiraMensagemDoContato,
  estamparOrigemDaPagina,
  extrairOrigemDaPagina,
} from "@/lib/leads/origem-do-site";
import { logger } from "@/lib/logger";
import { PADRAO_DO_REF } from "@/lib/plataformas-de-anuncio/captura-de-clique";
import { casarClickRef } from "@/lib/plataformas-de-anuncio/meta/captura-de-clique";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { ehContatoDoNumeroInterno } from "@/lib/escalacao/numero-interno-de-aviso";
import { acelerarFollowupDoInbound, drenarEventosDoInbound } from "@/lib/dev/kick-local-pipeline";
import { origemDoNegocioPeloCanal } from "@/lib/channels/origem-do-negocio";
import { autorizarContatoParaIA } from "@/lib/ai/elegibilidade/autorizacao";
import { casarCampanha, lerCampanhas } from "@/lib/ai/elegibilidade/campanha";
import { lerPessoalDoContato } from "@/lib/contacts/contato-pessoal";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { applyReactivityEvent, createSupabaseReactivityClient } from "@/lib/followup/reactivity";
import { aplicarRespostaNaCampanha } from "@/lib/campanhas/resposta";
import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";

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
  /**
   * O valor de `conversations.channel` desta conversa (`instagram`,
   * `facebook`…). Ausente quer dizer WhatsApp.
   *
   * Este sim decide: é dele que sai a origem do negócio que nasce
   * (`origemDoNegocioPeloCanal`). Sem ele, o negócio do direct do Instagram
   * nascia com `source = 'whatsapp'`.
   */
  canal?: string;
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
  // ── CINTO DE SEGURANÇA, nunca a defesa principal ────────────────────────
  //
  // Os ingestores cortam o número interno de avisos ANTES de `upsertContact`,
  // que é o que importa (é o INSERT da conversa que dispara o rodízio). Este
  // aqui existe para o caminho que alguém venha a esquecer — um ingestor novo,
  // um provedor novo, uma reentrega por outro caminho. Chegando até aqui, o
  // contato e a conversa já nasceram; o que ainda dá para impedir é o resto:
  // opt-out, demanda, campanha, follow-up e o despacho do agente.
  //
  // Custo zero para quem nunca ligou o aviso: a leitura vem do memo de 30 s e
  // sai sem tocar o banco quando não há número interno configurado.
  if (await ehContatoDoNumeroInterno(admin, entrada.organizationId, entrada.contactId)) {
    logger.info("[pos-entrada] efeitos pulados: mensagem do número interno de avisos", {
      organizationId: entrada.organizationId,
      origem: entrada.origem,
    });
    return;
  }

  await aplicarOptOut(admin, entrada);
  // Contato pessoal (spec 21, etapa 6): a mensagem já está gravada, com o
  // carimbo de não-lida que o ingest gravou — mas NADA nasce dela: sem negócio,
  // sem campanha, sem follow-up, sem IA (fila e resposta). O STOP continua na
  // frente: `aplicarOptOut` rodou acima de propósito, então um STOP de pessoal
  // ainda bloqueia (a ordem 1-2-3 do cabeçalho não muda).
  if (await ehContatoPessoal(admin, entrada)) {
    logger.info("[pos-entrada] efeitos pulados: contato pessoal", {
      organizationId: entrada.organizationId,
      origem: entrada.origem,
    });
    return;
  }
  await guardarOrigemDaPagina(admin, entrada);
  await abrirDemanda(admin, entrada);
  await avaliarCampanha(admin, entrada);
  const sinal = {
    organizationId: entrada.organizationId,
    contactId: entrada.contactId,
    messageId: entrada.messageId,
    texto: entrada.texto,
  };
  // UMA VOZ: a resposta do cliente avança o follow-up DESTE contato antes de o
  // turno do agente ser pedido.
  await acelerarFollowupDoInbound(admin, sinal);
  await pedirDespachoDoAgente(admin, entrada);
  // O dreno do event_log vem DEPOIS do despacho: nenhum handler dele decide se
  // o agente fala (o "cliente voltou" é previsto por `deveCederTurnoAoRetorno`
  // nas duas ordens), e cada evento drenado aqui atrasava o pedido do turno.
  await drenarEventosDoInbound(admin, sinal);
}

/**
 * A mensagem recuperada de uma queda (Spec 32 §3): a entrada de `EntradaDeMensagem`
 * com o que o efeito de "o cliente respondeu" precisa de mais. A hora é a REAL da
 * mensagem, nunca `now()`: a recuperação chega dias depois, e a campanha e a reatividade
 * comparam essa hora com a janela e com o último turno do follow-up.
 */
export type EntradaDaRecuperacao = EntradaDeMensagem & {
  /** ISO da hora em que o cliente mandou a mensagem (vinda do acervo). */
  enviadaEm: string;
  /** A prévia que a conversa mostra na caixa (mesma regra do ao vivo). */
  previa: string;
};

/**
 * Só os efeitos de "o cliente respondeu" da mensagem recuperada (Spec 32 §3).
 *
 * NUNCA chama despacho do agente, demanda nova, guarda de origem de página nem
 * drenagem de eventos: a mensagem é do passado, e acordar a IA ou abrir card por
 * ela responderia a alguém que já foi atendido. Também não emite `message.received`:
 * o efeito de follow-up roda com uma linha EM MEMÓRIA, que não entra no `event_log`.
 *
 * Guardas da ingestão, na mesma ordem: número interno de avisos e canal pausado
 * não recebem nada; o pedido de PARE vale mesmo para contato pessoal (é regra de
 * LGPD, a mesma da ingestão), e o restante é que é pulado para contato pessoal.
 *
 * Cada efeito falha para dentro, com log: um que falha não impede os outros nem
 * para a rodada.
 */
export async function aplicarEfeitosDaRecuperacao(
  admin: Admin,
  entrada: EntradaDaRecuperacao,
): Promise<void> {
  try {
    if (await ehContatoDoNumeroInterno(admin as unknown as SupabaseClient, entrada.organizationId, entrada.contactId)) {
      return;
    }
    const desativados = await idsDosCanaisDesativados(admin as unknown as SupabaseClient, entrada.organizationId);
    if (desativados.includes(entrada.channelSessionId)) {
      logger.info("pos-entrada: recuperação pulada — canal desativado", {
        organization_id: entrada.organizationId,
        origem: entrada.origem,
      });
      return;
    }

    await passoDaRecuperacao("opt-out", () => aplicarOptOut(admin, entrada), entrada);
    if (await ehContatoPessoal(admin, entrada)) {
      logger.info("pos-entrada: recuperação pulada — contato pessoal", {
        organization_id: entrada.organizationId,
        origem: entrada.origem,
      });
      return;
    }
    await passoDaRecuperacao("campanha", () => avaliarCampanha(admin, entrada), entrada);

    // Só a reatividade e o texto dos follow-ups: a mesma linha que o handler do
    // event_log recebe, montada aqui e nunca gravada.
    await passoDaRecuperacao(
      "follow-up",
      async () => {
        const evento: EventRow = {
          id: entrada.requestId ?? `recuperacao:${entrada.conversationId}:${entrada.enviadaEm}`,
          organization_id: entrada.organizationId,
          event_type: "message.received",
          entity_kind: "message",
          entity_id: null,
          payload: {
            message_id: null,
            conversation_id: entrada.conversationId,
            contact_id: entrada.contactId,
            direction: "inbound",
            channel_session_id: entrada.channelSessionId,
            body_preview: entrada.texto ? entrada.texto.slice(0, 280) : null,
            sent_at: entrada.enviadaEm,
          },
          metadata: { source: entrada.origem },
          consumed_by: [],
          attempts: 0,
          created_at: entrada.enviadaEm,
        };
        // A mensagem é de antes da volta: ela pode PARAR o fluxo que pede cancelamento na resposta,
        // mas nunca acordar a espera nem aplicar o texto como resposta (isso manda o próximo passo
        // agora, a quem pode já ter sido atendido pelo celular).
        await applyReactivityEvent(
          createSupabaseReactivityClient(admin as unknown as SupabaseClient),
          () => new Date(),
          evento,
          { semAcordar: true },
        );
      },
      entrada,
    );
    await passoDaRecuperacao(
      "resposta-de-campanha",
      () =>
        aplicarRespostaNaCampanha(admin as unknown as SupabaseClient, {
          organizationId: entrada.organizationId,
          contactId: entrada.contactId,
          recebidoEm: new Date(entrada.enviadaEm),
        }),
      entrada,
    );
    await passoDaRecuperacao(
      "conversa",
      async () => {
        // O carimbo da conversa só anda para a FRENTE: o que chegou ao vivo depois da volta já
        // marcou uma hora mais nova, e a RPC grava o que recebe, sem `greatest`. Sem esta
        // leitura a conversa voltava para a hora da mensagem velha, e a prévia mostrava o texto
        // antigo no lugar do mais recente.
        const { data } = await admin
          .from("conversations")
          .select("last_message_at")
          .eq("organization_id", entrada.organizationId)
          .eq("id", entrada.conversationId)
          .maybeSingle();
        const ultima = (data as { last_message_at?: string | null } | null)?.last_message_at;
        if (ultima && Date.parse(ultima) >= Date.parse(entrada.enviadaEm)) return;
        await marcarConversaComMensagem(admin as unknown as SupabaseClient, {
          organizationId: entrada.organizationId,
          conversationId: entrada.conversationId,
          direction: "inbound",
          preview: entrada.previa,
          at: entrada.enviadaEm,
          canal: "waha",
        });
      },
      entrada,
    );
  } catch (err) {
    logger.warn("pos-entrada: efeitos da recuperação falharam (a mensagem já está gravada)", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}

/** Um efeito da recuperação: se falhar, registra e deixa os outros rodarem. */
async function passoDaRecuperacao(
  nome: string,
  efeito: () => Promise<unknown>,
  entrada: EntradaDeMensagem,
): Promise<void> {
  try {
    await efeito();
  } catch (err) {
    logger.warn(`pos-entrada: efeito da recuperação falhou (${nome}); os demais seguem`, {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
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
 * Contato marcado como pessoal (`contacts.is_personal`, spec 21).
 *
 * Fail-open de propósito, como o resto do arquivo: a mensagem JÁ está gravada;
 * se a leitura falhar, o seguinte roda mesmo assim — e a segunda defesa (a
 * recusa em `garantirLeadDaConversa`, `contato_pessoal`) continua valendo para
 * o negócio. Uma exceção aqui viraria 500 para o provider e tempestade de
 * reentregas.
 *
 * A CONSULTA não mora aqui: ela é `lib/contacts/contato-pessoal.ts`, a régua
 * única da marca. Este arquivo só decide a POLÍTICA da dúvida (seguir), porque
 * essa decisão é da entrada de mensagem — a derivação de mídia usa a mesma
 * régua e decide o contrário (#3592: sem saber de quem é o arquivo, não gasta
 * token).
 */
async function ehContatoPessoal(admin: Admin, entrada: EntradaDeMensagem): Promise<boolean> {
  try {
    const { pessoal, erro } = await lerPessoalDoContato(admin, {
      organizationId: entrada.organizationId,
      contactId: entrada.contactId,
    });
    if (erro) {
      logger.warn("pos-entrada: leitura de is_personal falhou (os efeitos seguem)", {
        organization_id: entrada.organizationId,
        contact_id: entrada.contactId,
        detail: erro,
      });
    }
    return pessoal;
  } catch (err) {
    logger.warn("pos-entrada: leitura de is_personal falhou (os efeitos seguem)", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return false;
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
    // Sem o bloqueio gravado não há o que fechar: o contato segue recebendo, e
    // fechar o negócio de quem o sistema não conseguiu proteger esconderia o
    // problema no funil em vez de deixá-lo no log.
    return;
  }

  await fecharNegociosAbertosDeQuemPediuParar(admin, entrada);
  await encerrarDemandasAbertasDeQuemPediuParar(admin, entrada);
}

/**
 * Motivo canônico de perda (`CANONICAL_LOST_REASONS`, migration 0513): "Pediu
 * para não receber mensagens". Não é `requested_by_customer` ("Cliente solicitou
 * cancelamento") — pedir silêncio não é cancelar (decisão do dono, doc 85).
 */
const MOTIVO_DA_PERDA_POR_OPT_OUT = "opted_out_of_messages" satisfies CanonicalLostReason;

/**
 * O DESFECHO do opt-out nas DEMANDAS (issue #3288): `encerrada_pelo_cliente`.
 *
 * Já é vocabulário fechado do banco (`demandas.desfecho`, migration 0222), ao
 * lado de `perdida` e `expirada_sem_resposta` — não pede schema novo. Antes
 * disto o opt-out fechava os CARDS (`opted_out_of_messages`), mas a demanda
 * aberta do contato seguia no Radar acumulando: em 21/10 a prospecção abriu 26
 * demandas num dia, as "derivada" sem card que ninguém vai tratar.
 */
const DESFECHO_DA_DEMANDA_POR_OPT_OUT = "encerrada_pelo_cliente" as const;

/**
 * O ATOR de todo o caminho de opt-out: a mensagem chegou pelo canal e o produto
 * agiu — não foi uma pessoa. Nomeado para que o fechamento do CARD e o da
 * DEMANDA usem a MESMA origem: duas cópias divergem na primeira vez que alguém
 * trocar o id de um lado só.
 */
const ATOR_DO_OPT_OUT = { type: "webhook_source", id: "canal-inbound" } as const;

/**
 * Quem pediu para parar não é mais uma oportunidade: o negócio aberto dele vira
 * "Perdido — Pediu para não receber mensagens". Inclusive pedido já pago — o
 * dono escolheu fechar TODO negócio aberto (opção B, não B').
 *
 * Medido em produção: os dois opt-outs de um dia bloquearam o contato um segundo
 * depois do "parar" (`contact.blocked`, sem usuário), mas o negócio ficou aberto
 * na etapa de origem até um operador arrastá-lo à mão minutos depois. Enquanto
 * isso o card seguia contando como demanda viva e sujando o radar de risco.
 *
 * Roda DEPOIS do bloqueio gravado e ANTES do nascimento do lead (o passo 2 já
 * recusa contato bloqueado, então não nasce card novo para quem acabou de sair).
 * Usa `encerraDemanda` — a mesma regra do botão "perdido" e da IA —, que é
 * idempotente, filtra `organization_id`, grava a timeline e a auditoria.
 *
 * NUNCA lança: a mensagem já entrou e o bloqueio já foi gravado; uma falha aqui
 * (funil sem etapa de perdido, por exemplo) fica no log e não derruba a ingestão.
 */
async function fecharNegociosAbertosDeQuemPediuParar(
  admin: Admin,
  entrada: EntradaDeMensagem,
): Promise<void> {
  try {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id")
      .eq("organization_id", entrada.organizationId)
      .eq("contact_id", entrada.contactId)
      .eq("status", "open");
    if (error) {
      logger.warn("pos-entrada: negócios do contato que pediu para parar não lidos", {
        organization_id: entrada.organizationId,
        contact_id: entrada.contactId,
        detail: error.message.slice(0, 160),
      });
      return;
    }
    for (const lead of (data ?? []) as Array<{ id: string }>) {
      try {
        await encerraDemanda(
          admin,
          {
            organization_id: entrada.organizationId,
            // `webhook_source`, como o nascimento do lead: a mensagem chegou pelo
            // canal e o produto agiu — não foi uma pessoa. A timeline traduz para
            // "sistema".
            actor: ATOR_DO_OPT_OUT,
            requestId: entrada.requestId ?? `opt-out:${entrada.conversationId}`,
          },
          {
            leadId: lead.id,
            desfecho: "lost",
            motivo: MOTIVO_DA_PERDA_POR_OPT_OUT,
            razaoNaTimeline: "O cliente pediu para não receber mais mensagens",
            payloadNaTimeline: { conversation_id: entrada.conversationId },
          },
        );
      } catch (err) {
        logger.warn("pos-entrada: negócio de quem pediu para parar não foi fechado", {
          organization_id: entrada.organizationId,
          contact_id: entrada.contactId,
          lead_id: lead.id,
          detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
        });
      }
    }
  } catch (err) {
    logger.warn("pos-entrada: fechamento dos negócios de quem pediu para parar falhou", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}

/**
 * O opt-out TAMBÉM encerra as DEMANDAS ABERTAS do contato (issue #3288).
 *
 * Fechar a conversa ou o caso só preenche o próximo passo; a demanda continuava
 * aberta. É o outro lado do mesmo buraco que o fechamento dos cards acima fecha:
 * quem pediu para parar sai do funil, mas seguia contando como demanda viva no
 * Radar e empurrando o operador a resgatar o que já acabou.
 *
 * O desfecho é `encerrada_pelo_cliente` — pedir silêncio diz que AQUELE
 * atendimento não anda mais. Passa pela MESMA porta do botão "encerrar" da tela
 * (`fn_demanda_encerrar`, `app/api/v1/demandas/[id]/route.ts:89`): o CAS de
 * revisão, a timeline e o `encerrada_por` são do banco — não se escreve
 * `fechada_em` à mão aqui, senão passa a haver duas verdades sobre o que
 * "encerrada" significa.
 *
 * Só as ABERTAS (`fechada_em is null`): demanda já encerrada não é tocada nem
 * recebe rpc — encerrar de novo pela porta dos fundos seria efeito que ninguém
 * pediu.
 *
 * `p_actor` vai `null`: a coluna referencia `auth.users` e o ator daqui é o
 * SISTEMA, não uma pessoa. A origem do encerramento fica registrada na auditoria
 * (`demanda.encerrada`, com o MESMO `ATOR_DO_OPT_OUT` do fechamento do card).
 *
 * NUNCA lança: a mensagem já entrou e o bloqueio já foi gravado; uma falha aqui
 * (demanda que mudou de revisão entre a leitura e o rpc, por exemplo) fica no
 * log e não derruba a ingestão.
 */
async function encerrarDemandasAbertasDeQuemPediuParar(
  admin: Admin,
  entrada: EntradaDeMensagem,
): Promise<void> {
  try {
    const { data, error } = await admin
      .from("demandas")
      .select("id, revision")
      .eq("organization_id", entrada.organizationId)
      .eq("contact_id", entrada.contactId)
      .is("fechada_em", null);
    if (error) {
      logger.warn("pos-entrada: demandas do contato que pediu para parar não lidas", {
        organization_id: entrada.organizationId,
        contact_id: entrada.contactId,
        detail: error.message.slice(0, 160),
      });
      return;
    }
    for (const demanda of (data ?? []) as Array<{ id: string; revision: number }>) {
      try {
        const { error: encerraErro } = await admin.rpc("fn_demanda_encerrar", {
          p_org: entrada.organizationId,
          p_demanda: demanda.id,
          p_expected: demanda.revision,
          p_desfecho: DESFECHO_DA_DEMANDA_POR_OPT_OUT,
          // `null` = não foi uma pessoa: `encerrada_por` referencia `auth.users`;
          // o ator de sistema fica no audit abaixo.
          p_actor: null as unknown as string,
        });
        if (encerraErro) {
          logger.warn("pos-entrada: demanda de quem pediu para parar não encerrada", {
            organization_id: entrada.organizationId,
            contact_id: entrada.contactId,
            demanda_id: demanda.id,
            detail: encerraErro.message.slice(0, 160),
          });
          continue;
        }
        await audit({
          action: "demanda.encerrada",
          organizationId: entrada.organizationId,
          resourceType: "demanda",
          resourceId: demanda.id,
          requestId: entrada.requestId ?? `opt-out:${entrada.conversationId}`,
          metadata: {
            desfecho: DESFECHO_DA_DEMANDA_POR_OPT_OUT,
            contact_id: entrada.contactId,
            actor_type: ATOR_DO_OPT_OUT.type,
            actor_id: ATOR_DO_OPT_OUT.id,
          },
        });
      } catch (err) {
        logger.warn("pos-entrada: demanda de quem pediu para parar não encerrada", {
          organization_id: entrada.organizationId,
          contact_id: entrada.contactId,
          demanda_id: demanda.id,
          detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
        });
      }
    }
  } catch (err) {
    logger.warn("pos-entrada: encerramento das demandas de quem pediu para parar falhou", {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
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
  // Sem ID retornado pelo INSERT, ainda tentamos abrir a demanda pelo caminho
  // legado. A prova CTWA exige um ID persistido e não nasce desta alternativa.
  try {
    const nascimento = await garantirLeadDaConversa(admin, {
      organizationId: entrada.organizationId,
      contactId: entrada.contactId,
      conversationId: entrada.conversationId,
      messageId: entrada.messageId,
      nomeDoContato: entrada.nomeDoContato,
      origem: origemDoNegocioPeloCanal(entrada.canal),
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

  // Canal desativado pelo operador nunca acorda o agente: a entrega foi gravada
  // (quarentena), mas não gera turno, fila nem gasto. Uma ida curta, antes do
  // `emit_event` — o ponto mais barato da cadeia, comum aos canais.
  // Falha para dentro de propósito: se a leitura falhar, despacha — as
  // barreiras de baixo (drain, elegibilidade, turno) também leem o flag, e a
  // ingestão nunca pode virar 500 por causa de um passo de efeito.
  try {
    const idsOff = await idsDosCanaisDesativados(admin, entrada.organizationId);
    if (idsOff.includes(entrada.channelSessionId)) {
      logger.info("pos-entrada: canal desativado — despacho pulado", {
        organization_id: entrada.organizationId,
        conversation_id: entrada.conversationId,
        origem: entrada.origem,
      });
      return;
    }
  } catch (err) {
    logger.warn("pos-entrada: leitura de canais desativados falhou — despachando", {
      organization_id: entrada.organizationId,
      detail: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

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

/**
 * 4 · A origem de site/landing page veio junto com o texto? (#924)
 *
 * Roda ANTES de `abrirDemanda`: o card COPIA a origem do contato quando nasce
 * (ver `ROTULO_DE_ANUNCIO` em `lib/leads/nascimento-do-lead.ts`). Estampar
 * depois deixaria o card com a origem de sempre e o dado só no contato — que é
 * exatamente onde ninguém olha.
 *
 * Duas condições da decisão da #924 estão aqui, e nenhuma delas é re-medida:
 * (a) a origem vale SÓ na PRIMEIRA mensagem do contato — um link encaminhado
 * adiante não vira atribuição de quem o recebeu (o filtro roda no banco, em
 * `ehAPrimeiraMensagemDoContato`); (b) o PRIMEIRO TOQUE nunca é sobrescrito, e
 * isso continua sendo da `fn_estampar_atribuicao_de_anuncio`, não deste arquivo.
 *
 * Falha aqui é LOG, nunca exceção: a mensagem do cliente JÁ está gravada, e
 * devolver erro ao provider faria ele reenviar a mensagem. Trocar um rótulo de
 * origem faltando por uma tempestade de reentregas é um péssimo negócio.
 *
 * ─── Dois transportes para a MESMA origem ──────────────────────────────────
 *
 * `[dk1:<base64url>]` carrega as UTMs dentro do próprio texto, e `[ref:XXXXXX]`
 * carrega só um ref de seis caracteres, cujas UTMs ficaram no servidor quando a
 * rota de captura recebeu o clique. O resto — primeira mensagem, primeiro
 * toque, formato do que é gravado — é idêntico nos dois, e é por isso que eles
 * compartilham este bloco em vez de ganharem um caminho cada.
 *
 * O `[dk1:]` é tentado PRIMEIRO porque é o que não custa consulta nenhuma: ele
 * se resolve no texto. O ref só vai ao banco quando o texto não trouxe UTM.
 */
async function guardarOrigemDaPagina(admin: Admin, entrada: EntradaDeMensagem): Promise<void> {
  const achada = extrairOrigemDaPagina(entrada.texto);
  // O ref não é lido no banco aqui: a leitura CONSOME o clique, e consumir um
  // clique fora da primeira mensagem o queimaria sem estampar ninguém.
  const ref = achada ? null : (PADRAO_DO_REF.exec(entrada.texto ?? "")?.[1] ?? null);
  // O caso comum: quase nenhuma mensagem traz código de página nem ref.
  if (!achada && !ref) return;

  try {
    // A consulta vem ANTES de qualquer escrita, e DENTRO do try: falha de
    // leitura não pode virar estampa. O `estampar` só roda depois de a
    // primeira mensagem estar confirmada.
    if (
      !(await ehAPrimeiraMensagemDoContato(
        admin,
        entrada.organizationId,
        entrada.contactId,
        entrada.messageId,
      ))
    ) {
      logger.info("pos-entrada: código de origem fora da primeira mensagem (ignorado)", {
        contactId: entrada.contactId,
        messageId: entrada.messageId,
      });
      return;
    }

    const utm = achada
      ? achada.utm
      : ref
        ? (await casarClickRef(admin, entrada.organizationId, ref, entrada.contactId))?.utm
        : undefined;
    if (!utm) {
      // Ref que não casa é sinal NOSSO que não fechou: já consumido, de outra
      // organização, ou de um clique que nunca foi gravado. Não é tráfego
      // orgânico, então vale um aviso — ao contrário da mensagem sem marcador
      // nenhum, que nem chega aqui.
      logger.warn("pos-entrada: ref da página não casou (a mensagem entra assim mesmo)", {
        contactId: entrada.contactId,
      });
      return;
    }

    const origem = { utm, capturadaEm: new Date().toISOString() };

    const gravou = await estamparOrigemDaPagina(admin, entrada.organizationId, entrada.contactId, origem);
    if (!gravou) {
      logger.warn("pos-entrada: origem da página NÃO gravada (a mensagem entra assim mesmo)", {
        contactId: entrada.contactId,
        utm_source: origem.utm.utm_source ?? null,
      });
      return;
    }
    logger.info("pos-entrada: origem da página gravada", {
      contactId: entrada.contactId,
      utm: Object.keys(origem.utm),
    });
  } catch (erro) {
    logger.error("pos-entrada: origem da página falhou (a mensagem entra assim mesmo)", {
      contactId: entrada.contactId,
      error: erro instanceof Error ? erro.message.slice(0, 160) : String(erro).slice(0, 160),
    });
  }
}
