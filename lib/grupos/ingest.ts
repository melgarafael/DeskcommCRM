/**
 * Mensagem de um grupo LIGADO entra na inbox. Grupo desligado é descartado, como sempre foi.
 *
 * O que esta entrada NÃO faz, de propósito: `aplicarEfeitosPosEntrada` (opt-out, lead,
 * atribuição), `acelerarPipelineDeEventos` e o audit `message.received`. O banco emite
 * `message.group_received` para conversa de grupo (migration 0482), e nenhum
 * consumidor de `message.received` — IA, follow-up, campanhas, automações — a vê.
 *
 * #2729 abriu UMA exceção, e ela é estreita de propósito: quando o operador
 * liga a chave por grupo "Permitir que a IA responda neste grupo"
 * (`channel_session_groups.ia_responde`), esta entrada pede o turno do agente
 * para aquela mensagem — o mesmo evento `ai_agent.dispatch_requested` da
 * conversa individual. A porta continua fechada para todo o resto: sem a chave
 * (o default de todo mundo) nada muda, e `message.group_received` continua
 * sendo o evento que os outros consumidores veem.
 *
 * Quem chama é a entrada do canal (o ingest do transporte, em `lib/`): ela lê o payload do
 * provedor, monta a `EntradaDeGrupo` e não sabe mais nada de grupo daqui para baixo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcarConversaComMensagem } from "@/lib/channels/marcar-conversa";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { grupoLiberaIa } from "@/lib/grupos/ia-no-grupo";
import { logger } from "@/lib/logger";
import { CHAVE_DAS_MENCOES } from "@/lib/messaging/mencoes-de-grupo";
import { remetenteDeGrupoSchema, type RemetenteDeGrupo } from "@/lib/messaging/remetente-de-grupo";
import { previaDaMensagem } from "@/lib/messaging/previa-da-mensagem";

export interface EntradaDeGrupo {
  organizationId: string;
  channelSessionId: string;
  groupChatId: string;
  direction: "inbound" | "outbound";
  externalId: string;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  sentAt: string;
  remetente: RemetenteDeGrupo | null;
  /**
   * #3566 — quem foi MENCIONADO, lido do payload pelo MESMO leitor de JID do
   * remetente. Chega com `name: null` (o payload não traz nome por menção) e o
   * rótulo é preenchido aqui, pelo contato do CRM. Lista vazia/ausente é
   * mensagem sem menção — e aí `metadata` sai exatamente como saía antes.
   */
  mencoes?: RemetenteDeGrupo[];
  rawType: string | null;
  /**
   * O provedor anunciou mídia mas não mandou a URL. A conversa individual grava
   * essa mensagem mesmo assim (`!texto && !mediaUrl && !hasMedia` é o descarte
   * dela); o grupo segue a mesma régua para não perder a foto que chegou sem link.
   */
  temMidia?: boolean;
}

export interface IngestDeGrupoDb {
  grupoLigado(
    org: string,
    session: string,
    chatId: string,
  ): Promise<
    {
      id: string;
      subject: string | null;
      contactId: string | null;
      conversationId: string | null;
      /**
       * #2729 — a chave POR GRUPO "Permitir que a IA responda neste grupo".
       * `false` (o default da coluna) mantém a IA calada no grupo, como sempre.
       */
      iaResponde: boolean;
    } | null
  >;
  criarContatoDoGrupo(org: string, chatId: string, subject: string | null): Promise<string>;
  /**
   * `service_started_at` vai junto (#2729): a conversa de grupo nasce ABERTA e,
   * sem ele, `getLeadContext` descarta toda mensagem enviada — a régua do
   * histórico é `messages.sent_at >= c.service_started_at`. O instante é o da
   * mensagem que criou a conversa, não o `now()` do ingest: um webhook atrasado
   * não pode fazer o histórico começar depois da mensagem que o gerou.
   */
  criarConversaDoGrupo(
    org: string,
    session: string,
    contactId: string,
    chatId: string,
    iniciadoEm: string,
  ): Promise<string>;
  vincular(org: string, grupoId: string, contactId: string, conversationId: string): Promise<void>;
  /**
   * O id volta porque é ele que o pedido de turno do agente aponta
   * (`entity_id` do evento). `duplicada` vem sem id: não há mensagem nova,
   * logo não há turno a pedir.
   */
  inserirMensagem(row: Record<string, unknown>): Promise<{ status: "ok" | "duplicada"; messageId: string | null }>;
  /**
   * #3566 — o RÓTULO de cada menção, pelo contato do CRM.
   *
   * Uma leitura por mensagem com menção, e nenhuma quando não há. A correlação é
   * a MESMA que o `group_sender` documenta em `lib/messaging/remetente-de-grupo.ts`:
   * `contacts.wa_lid` (o identificador opaco) ou `contacts.phone_number` nas duas
   * grafias do nono dígito — a régua do `uniq_contacts_org_wa_lid` e do
   * `CONTATO_DO_PEER` (`lib/wacalls/events-bridge.ts`).
   *
   * Não acha: devolve a menção como veio (sem nome), e a tela mostra o número —
   * o comportamento de hoje, que é melhor do que inventar um nome.
   */
  rotulosDasMencoes(org: string, mencoes: RemetenteDeGrupo[]): Promise<RemetenteDeGrupo[]>;
  /**
   * Conversa de grupo FECHADA (closed/resolved/archived) volta a `open` quando chega
   * mensagem nova — o que a conversa individual faz em `fn_service_inbound`, que pula grupos.
   * Sem isto, um "resolver" num grupo esconde para sempre as mensagens seguintes em
   * "Fechadas". Não aciona roteamento: `fn_request_channel_routing` pula `is_group`.
   *
   * #2729 — `messageId`/`quando`: a reabertura começa um episódio NOVO, e a
   * mensagem que a causou foi inserida ANTES dela (o insert é o que dispara o
   * ingest). `fn_service_inbound` não carimba recebida de grupo em conversa
   * encerrada — carimbaria no episódio velho —, então o carimbo com a revisão
   * nova é feito aqui, junto com `service_started_at` no instante da mensagem
   * (a 1:1 faz as duas coisas dentro da própria função, sob o mesmo lock).
   * Sem isto, o primeiro turno depois de reabrir um grupo veria só a mensagem
   * atual, e não o que veio antes no episódio novo.
   */
  reabrirSeFechada(org: string, conversationId: string, messageId?: string, quando?: string): Promise<void>;
  /**
   * `direction` vai no fim porque o carimbo compartilhado
   * (`fn_mark_conversation_message`) move `last_inbound_at` OU `last_outbound_at`
   * e o contador de não lidas conforme o sentido — sem ele, o carimbo erraria.
   */
  marcarConversa(
    org: string,
    conversationId: string,
    preview: string,
    quando: string,
    direction: "inbound" | "outbound",
  ): Promise<void>;
  /**
   * #2729 — o turno do agente para o grupo que liberou a IA. É o MESMO evento
   * (`ai_agent.dispatch_requested`) e o MESMO payload da conversa individual,
   * para o MESMO consumidor (`lib/agent-engine/edge/crm/drain.ts`): o grupo
   * entra na fila comum pelo caminho que a conversa individual entra, sem
   * segunda esteira. Só que aqui ele nasce de uma mensagem de grupo — é o
   * ingest que decide, pela chave por grupo, e mais ninguém.
   */
  pedirDespachoDeIa(e: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelSessionId: string;
    messageId: string;
  }): Promise<void>;
}

export async function gravarMensagemDeGrupo(
  db: IngestDeGrupoDb,
  e: EntradaDeGrupo,
): Promise<"gravada" | "grupo_desligado" | "duplicada" | "vazia"> {
  if (!e.body && !e.mediaUrl && !e.temMidia) return "vazia";
  const grupo = await db.grupoLigado(e.organizationId, e.channelSessionId, e.groupChatId);
  if (!grupo) return "grupo_desligado";

  let contactId = grupo.contactId;
  let conversationId = grupo.conversationId;
  if (!contactId || !conversationId) {
    contactId ??= await db.criarContatoDoGrupo(e.organizationId, e.groupChatId, grupo.subject);
    conversationId ??= await db.criarConversaDoGrupo(
      e.organizationId,
      e.channelSessionId,
      contactId,
      e.groupChatId,
      e.sentAt,
    );
    await db.vincular(e.organizationId, grupo.id, contactId, conversationId);
  }

  // Remetente fora do formato NÃO derruba a mensagem: ela entra sem `group_sender`
  // e a tela mostra "Participante". Perder a mensagem por causa do rótulo seria pior.
  const remetente = e.direction === "inbound" && e.remetente ? remetenteDeGrupoSchema.safeParse(e.remetente) : null;
  // #3566 — o rótulo das menções, pelo contato do CRM. Consulta só quando a
  // mensagem menciona alguém: mensagem sem menção não paga leitura nenhuma e
  // grava `metadata` sem a chave, byte a byte como antes.
  const mencoes = e.mencoes?.length ? await db.rotulosDasMencoes(e.organizationId, e.mencoes) : [];
  const agora = new Date().toISOString();
  const resultado = await db.inserirMensagem({
    organization_id: e.organizationId,
    conversation_id: conversationId,
    channel_session_id: e.channelSessionId,
    contact_id: contactId,
    external_id: e.externalId,
    type: e.type,
    direction: e.direction,
    status: e.direction === "inbound" ? "delivered" : "sent",
    body: e.body,
    media_url: e.mediaUrl,
    media_mime: e.mediaMime,
    sent_via: "external_device",
    sent_at: e.sentAt,
    delivered_at: e.direction === "inbound" ? agora : null,
    metadata: {
      // `body` NÃO é reescrito (#3566): o texto cru do provedor fica com o
      // `@<lid>` e quem resolve é a exibição (`textoComMencoesResolvidas`). O
      // metadata só acrescenta a lista que faltava.
      raw_type: e.rawType,
      ...(remetente?.success ? { group_sender: remetente.data } : {}),
      ...(mencoes.length > 0 ? { [CHAVE_DAS_MENCOES]: mencoes } : {}),
    },
  });
  if (resultado.status === "duplicada") return "duplicada";
  if (e.direction === "inbound")
    await db.reabrirSeFechada(e.organizationId, conversationId, resultado.messageId ?? undefined, e.sentAt);

  // Mesma prévia da conversa individual (`previewFromMessage`): a RÉGUA mora em
  // `lib/messaging/previa-da-mensagem.ts` — texto até 280, `[tipo]` sem texto, e
  // o vCard vira `Contato: <nome>` em vez do literal ou do cartão cru (#2742).
  const preview = previaDaMensagem(e.body, e.type);
  await db.marcarConversa(e.organizationId, conversationId, preview, e.sentAt, e.direction);
  // ── #2729 — a chave POR GRUPO, por último ────────────────────────────────
  //
  // Só para mensagem RECEBIDA (eco do celular é a própria operação humana) e
  // SÓ quando o operador ligou a chave naquele grupo. Depois do carimbo, de
  // propósito: o turno lê a conversa já com `last_inbound_at` novo, e uma
  // corrida de dois eventos do mesmo grupo (o provedor manda `message` e
  // `message.any`) não muda o resultado — os dois pedidos apontam para a mesma
  // mensagem e a fila deduplica pelo event_log.
  //
  // Daqui para baixo nada mais acontece: este pedido é o ÚNICO efeito novo do
  // grupo liberado, e ele não substitui o `message.group_received` — nenhum
  // outro consumidor passa a enxergar mensagem de grupo.
  if (e.direction === "inbound" && grupoLiberaIa(grupo.iaResponde) && resultado.messageId) {
    await db.pedirDespachoDeIa({
      organizationId: e.organizationId,
      conversationId,
      contactId,
      channelSessionId: e.channelSessionId,
      messageId: resultado.messageId,
    });
  }
  return "gravada";
}

/** Implementação real. `admin` é service role: toda consulta filtra `organization_id`. */
export function criarIngestDeGrupoDb(admin: SupabaseClient): IngestDeGrupoDb {
  return {
    async grupoLigado(org, session, chatId) {
      const { data, error } = await admin
        .from("channel_session_groups")
        .select("id, subject, contact_id, conversation_id, ia_responde")
        .eq("organization_id", org)
        .eq("channel_session_id", session)
        .eq("group_chat_id", chatId)
        .eq("enabled", true)
        .maybeSingle();
      // Leitura que falhou é "não sei se está ligado": descarta, como antes da
      // feature. Fica o rastro, para "o grupo ligado não entra" ter resposta.
      if (error) {
        logger.warn("[grupos.ingest] chave do grupo não lida; mensagem descartada", {
          organization_id: org,
          causa: error.message,
        });
        return null;
      }
      const r =
        data as
          | {
              id: string;
              subject: string | null;
              contact_id: string | null;
              conversation_id: string | null;
              ia_responde: boolean | null;
            }
          | null;
      return r
        ? {
            id: r.id,
            subject: r.subject,
            contactId: r.contact_id,
            conversationId: r.conversation_id,
            // Coluna nula (linha anterior à 0653) é a mesma coisa que
            // desligada: não sei se liberaram, e não sei não responde.
            iaResponde: r.ia_responde === true,
          }
        : null;
    },

    async criarContatoDoGrupo(org, chatId, subject) {
      const nome = subject?.trim() || "Grupo de WhatsApp";
      const { data, error } = await admin
        .from("contacts")
        .insert({
          organization_id: org,
          name: nome,
          display_name: nome,
          kind: "whatsapp_group",
          source: "whatsapp_group",
          source_metadata: { group_chat_id: chatId },
        })
        .select("id")
        .single();
      if (!error) return (data as { id: string }).id;
      if ((error as { code?: string }).code !== "23505") throw error;
      // Dois webhooks do MESMO grupo novo (o provedor manda `message` e
      // `message.any`) correram, e o outro criou primeiro: `uq_contacts_grupo`
      // recusou este. Relê o contato dele — um grupo, um contato.
      const { data: existente, error: erroLeitura } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", org)
        .eq("kind", "whatsapp_group")
        .eq("source_metadata->>group_chat_id", chatId)
        .maybeSingle();
      if (erroLeitura) throw erroLeitura;
      if (!existente) throw error;
      return (existente as { id: string }).id;
    },

    async criarConversaDoGrupo(org, session, contactId, chatId, iniciadoEm) {
      const { data, error } = await admin
        .from("conversations")
        .insert({
          organization_id: org,
          contact_id: contactId,
          channel_session_id: session,
          channel: "whatsapp",
          status: "open",
          is_group: true,
          group_chat_id: chatId,
          // #2729 — o episódio de serviço começa com a mensagem que abriu a
          // conversa. Sem isto o grupo nascia com `service_started_at` nulo e a
          // régua do histórico (`messages.sent_at >= c.service_started_at`)
          // descartava TODA mensagem enviada, porque compara com NULL.
          service_started_at: iniciadoEm,
        })
        .select("id")
        .single();
      if (!error) return (data as { id: string }).id;
      if ((error as { code?: string }).code !== "23505") throw error;
      // Mesma corrida do contato. O unique é
      // `conversations_unique_per_contact_session (organization_id, contact_id,
      // channel_session_id, group_chat_id)`: relê pelos quatro.
      const { data: existente, error: erroLeitura } = await admin
        .from("conversations")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contactId)
        .eq("channel_session_id", session)
        .eq("group_chat_id", chatId)
        .maybeSingle();
      if (erroLeitura) throw erroLeitura;
      if (!existente) throw error;
      return (existente as { id: string }).id;
    },

    async vincular(org, grupoId, contactId, conversationId) {
      const { error } = await admin
        .from("channel_session_groups")
        .update({ contact_id: contactId, conversation_id: conversationId })
        .eq("organization_id", org)
        .eq("id", grupoId);
      if (error) {
        logger.warn("[grupos.ingest] vínculo do grupo não gravado", {
          organization_id: org,
          grupo_id: grupoId,
          causa: error.message,
        });
      }
    },

    async inserirMensagem(row) {
      const { data, error } = await admin.from("messages").insert(row).select("id").maybeSingle();
      if (error) {
        // `duplicada` vem SEM id: não há mensagem nova, logo não há turno a
        // pedir (#2729) — e o pedido apontaria para uma mensagem que não é deste
        // webhook.
        if ((error as { code?: string }).code === "23505") return { status: "duplicada", messageId: null };
        throw error;
      }
      // "Mídia pelo mesmo caminho das conversas individuais" (spec): a URL do
      // provedor é temporária, e quem a copia para o Storage é o worker de
      // `media.persist_requested`. Sem isto a foto do grupo some em horas.
      const id = (data as { id: string } | null)?.id ?? null;
      if (id && row.media_url) {
        const org = row.organization_id as string;
        const { error: erroEvento } = await admin.rpc("emit_event" as never, {
          p_event_type: "media.persist_requested",
          p_entity_kind: "message",
          p_entity_id: id,
          p_payload: { message_id: id, conversation_id: row.conversation_id },
          p_metadata: { source: "grupo_ingest" },
          p_organization_id: org,
        } as never);
        if (erroEvento) {
          logger.warn("[grupos.ingest] persistência de mídia não pedida", {
            organization_id: org,
            message_id: id,
            causa: erroEvento.message,
          });
        }
      }
      return { status: "ok", messageId: id };
    },

    async rotulosDasMencoes(org, mencoes) {
      const lids = [...new Set(mencoes.map((m) => m.lid).filter((l): l is string => l !== null))];
      const telefones = [...new Set(mencoes.flatMap((m) => (m.phone ? phoneLookupVariants(m.phone) : [])))];
      if (lids.length === 0 && telefones.length === 0) return mencoes;

      const nomePorLid = new Map<string, string>();
      const nomePorTelefone = new Map<string, string>();
      const lerContatos = async (coluna: "wa_lid" | "phone_number", valores: string[]) => {
        if (valores.length === 0) return;
        const { data, error } = await admin
          .from("contacts")
          .select("name, display_name, phone_number, wa_lid")
          .eq("organization_id", org)
          .in(coluna, valores)
          // Contato fundido em outro não é a ficha que a tela mostra: o rótulo
          // tem de ser o do sobrevivente, como no `CONTATO_DO_PEER`.
          .is("is_merged_into", null)
          .limit(200);
        // Leitura que falhou NÃO derruba a mensagem: a menção entra sem rótulo
        // (a tela mostra o número, como hoje) e fica o rastro de por quê.
        if (error) {
          logger.warn("[grupos.ingest] rótulo de menção não lido", {
            organization_id: org,
            coluna,
            causa: error.message,
          });
          return;
        }
        for (const linha of (data ?? []) as Array<{
          name: string | null;
          display_name: string | null;
          phone_number: string | null;
          wa_lid: string | null;
        }>) {
          const nome = nomeDoContato(linha);
          if (!nome) continue;
          if (linha.wa_lid) nomePorLid.set(linha.wa_lid, nome);
          if (linha.phone_number) {
            for (const variante of phoneLookupVariants(linha.phone_number)) nomePorTelefone.set(variante, nome);
          }
        }
      };
      // Duas leituras, uma por chave indexada (`uniq_contacts_org_wa_lid` e o
      // índice de `phone_number`) — e não um `.or()` com valor de fora montado
      // em string, que é o tipo de SQL colado que esta base evita.
      await lerContatos("wa_lid", lids);
      await lerContatos("phone_number", telefones);

      return mencoes.map((m) => {
        const porLid = m.lid !== null ? nomePorLid.get(m.lid) : undefined;
        const porTelefone = m.phone !== null ? nomePorTelefone.get(canonicalPhoneBR(m.phone)) : undefined;
        return { ...m, name: m.name ?? porLid ?? porTelefone ?? null };
      });
    },

    async reabrirSeFechada(org, conversationId, messageId, quando) {
      // `trg_service_stamp_status` carimba a revisão de serviço e limpa o dono,
      // como na reabertura da conversa individual. O filtro `is_group` garante
      // que este caminho nunca reabre uma conversa 1:1.
      const { data, error } = await admin
        .from("conversations")
        .update({
          status: "open",
          status_changed_at: new Date().toISOString(),
          // #2729 — o episódio novo começa na mensagem que o reabriu, como na
          // 1:1 (que usa `m.sent_at`). O gatilho respeita o valor: só troca por
          // `clock_timestamp()` quando o campo não mudou.
          ...(quando !== undefined ? { service_started_at: quando } : {}),
        })
        .eq("organization_id", org)
        .eq("id", conversationId)
        .eq("is_group", true)
        .in("status", ["closed", "resolved", "archived"])
        .select("service_revision")
        .maybeSingle();
      if (error) {
        logger.warn("[grupos.ingest] conversa de grupo fechada não reaberta", {
          organization_id: org,
          conversation_id: conversationId,
          causa: error.message,
        });
        return;
      }
      // Não reabriu (a conversa já estava aberta, ou outra corrida reabriu
      // antes): não há episódio novo para carimbar.
      const revisao = (data as { service_revision: number } | null)?.service_revision;
      if (revisao === undefined || revisao === null || messageId === undefined) return;
      const { error: erroCarimbo } = await admin
        .from("messages")
        .update({ service_revision: revisao })
        .eq("organization_id", org)
        .eq("conversation_id", conversationId)
        .eq("id", messageId)
        .eq("direction", "inbound")
        .is("service_revision", null);
      if (erroCarimbo) {
        logger.warn("[grupos.ingest] recebida que reabriu o grupo ficou sem revisão", {
          organization_id: org,
          conversation_id: conversationId,
          message_id: messageId,
          causa: erroCarimbo.message,
        });
      }
    },

    async marcarConversa(org, conversationId, preview, quando, direction) {
      await marcarConversaComMensagem(admin, {
        organizationId: org,
        conversationId,
        direction,
        preview,
        at: quando,
        canal: "grupo",
      });
    },

    async pedirDespachoDeIa(e) {
      // MESMO evento, MESMO payload e MESMO consumidor do turno da conversa
      // individual (`pedirDespachoDoAgente`, em `lib/channels/pos-entrada.ts`):
      // o grupo que liberou a IA entra na fila comum do engine, sem segunda
      // esteira — o drain é quem abre (ou não) o turno, e lá a régua
      // `grupoLiberaIa` é reaplicada por conta própria (defesa em profundidade).
      //
      // Falha para dentro, como lá: a mensagem JÁ está gravada (o pedido vem
      // depois do insert, e não o contrário), e um throw aqui viraria 500 para
      // o provedor do canal, que reenviaria o webhook inteiro — mensagem
      // duplicada em troca de um turno que a fila deduplicaria de qualquer
      // forma. Log estruturado é o rastro de "o grupo liberado não virou turno".
      const { error } = await admin.rpc("emit_event" as never, {
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_kind: "message",
        p_entity_id: e.messageId,
        p_payload: {
          organization_id: e.organizationId,
          conversation_id: e.conversationId,
          contact_id: e.contactId,
          channel_session_id: e.channelSessionId,
          inbound_message_id: e.messageId,
        },
        p_metadata: { source: "grupo_ingest" },
        p_organization_id: e.organizationId,
      } as never);
      if (error) {
        logger.warn("[grupos.ingest] pedido de turno da IA não emitido", {
          organization_id: e.organizationId,
          conversation_id: e.conversationId,
          message_id: e.messageId,
          causa: error.message,
        });
      }
    },
  };
}
