/**
 * A CONVERSA NOVA ENTRA NO FUNIL — com o funil e a etapa que a ORGANIZAÇÃO
 * escolheu (#3603, fatia 1).
 *
 * ═══ O QUE JÁ EXISTIA, E O QUE FALTAVA ═══
 *
 * Duas metades já estavam de pé, e nenhuma delas serve sozinha:
 *
 * 1. **A captação por webhook** tem `webhook_sources.default_pipeline_id` e
 *    `default_stage_id` (FKs, migration do funil) e a rota
 *    `app/api/v1/webhooks/in/[token]/route.ts` aplica os dois: card criado no
 *    funil/etapa da fonte, vinculado ao contato. É o desenho desta fatia — a
 *    diferença é que ali a escolha é POR FONTE, porque cada landing page pode
 *    mandar para um funil diferente.
 * 2. **O nascimento a partir da conversa** (`nascimento-do-lead.ts`) já sabe
 *    escolher funil (`is_default`) e etapa (`settings.entrada_do_inbox` do
 *    FUNIL), com RPC serializada e timeline. Ele cobre o INBOUND — a mensagem
 *    que chega.
 *
 * O buraco medido pela issue é o outro lado: a conversa que nasce pelo INBOX
 * (`Iniciar conversa`, ficha do contato, lembrete de agenda/tarefa, ferramenta
 * de início de conversa do agente) não gerava negócio nenhum. O atendente
 * falava primeiro e o funil não sabia; o card só aparecia se alguém o abrisse à
 * mão. E, quando aparecia, ia para o funil PADRÃO — não havia como a organização
 * dizer "conversa nova entra AQUI".
 *
 * ═══ A RÉGUA ═══
 *
 * 1. **Sem configuração, NADA acontece** — e este é o critério mais importante
 *    da fatia. `settings.entrada_automatica_no_funil` ausente, `ativa: false`,
 *    ou `ativa: true` sem `pipeline_id` é `nao_configurado`: nenhuma escrita,
 *    nem no funil, nem na timeline, nem evento. Toda instalação que já existe
 *    está neste estado e não pode ver diferença nenhuma;
 * 2. **O funil escolhido tem de ser DESTA organização e estar aberto.** Id com
 *    forma de uuid não é funil: quem diz que ele existe, é desta organização e
 *    não está arquivado é a consulta. Funil inválido é `sem_funil` — o card NÃO
 *    cai calado no funil padrão, porque a organização DISSE onde queria e o
 *    silêncio faria os cards dela aparecerem noutro lugar (mesma régua de
 *    `destinoDaCampanha` em `nascimento-do-lead.ts`);
 * 3. **A etapa escolhida vale só se for utilizável NAQUELE funil** (aberta, não
 *    ganho, não perdido). Sem etapa escolhida — ou com uma que não vale mais —
 *    entra na PRIMEIRA etapa aberta do funil escolhido: errar a etapa é visível
 *    e corrigível, não nascer é a pessoa sumir (a doutrina de
 *    `nascimento-do-lead.ts`), e o aviso fica no log;
 * 4. **Contato bloqueado ou pessoal não vira oportunidade** (spec 21). As duas
 *    colunas vêm na MESMA leitura que já serve para o título do card, então o
 *    portão não custa consulta a mais;
 * 5. **Não duplica.** Quem serializa é `fn_nascer_lead_da_conversa` — advisory
 *    lock por (organização, contato), NULL quando já existe negócio aberto. A
 *    régua dela é UM aberto por CONTATO, e não por funil como a da captação:
 *    aqui isso é mais estrito de propósito. A captação reusa o card aberto do
 *    contato NO MESMO funil porque tem dados novos do envio para gravar nele;
 *    esta porta não tem nada a acrescentar ao card que já existe, e abrir um
 *    segundo negócio do mesmo contato em outro funil só porque a preferência da
 *    organização mudou seria trocar de quadro por conta própria — a
 *    transferência entre funis tem porta própria (`lib/leads/clonar-para-funil`),
 *    com motivo e histórico.
 *
 * ═══ O QUE ESTA FATIA NÃO FAZ ═══
 *
 * Follow-up por etapa (as mensagens automáticas por tempo sem resposta) fica
 * para a fatia seguinte. Aqui só se abre o card, no lugar certo, uma vez.
 *
 * ═══ POR QUE NUNCA DERRUBA QUEM CHAMOU ═══
 *
 * A conversa é o pedido; o card é consequência. Quem abre conversa é atendente
 * no meio do atendimento, cron de lembrete e ferramenta de agente de IA — e
 * nenhum dos três pode falhar porque uma preferência de funil está torta. Toda
 * saída é um resultado discriminado; exceção não atravessa esta fronteira.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";
import { logger } from "@/lib/logger";
import { entradaAutomaticaNoFunilDeclarada } from "@/lib/schemas/settings";

import { emitLeadActivity } from "./activity-emitter";

/**
 * `crm_leads.source` quando o card nasce DESTA porta — vocabulário aberto
 * (nenhum CHECK, por doutrina de clone), como `whatsapp_operador` e as origens
 * de campanha. Um valor próprio é o que impede o relatório por origem de
 * contar como "chegou sozinho" uma conversa que a equipe começou.
 */
export const ORIGEM_DA_ENTRADA_AUTOMATICA = {
  rotulo: "Inbox",
  source: "inbox_entrada_automatica",
  motivo: "conversa nova entrou no funil automaticamente",
} as const;

/** Por que NÃO nasceu negócio. Literal: é contrato do log e do teste. */
export type MotivoSemNegocio =
  | "nao_configurado" // a organização não ligou a entrada automática (ou ligou sem funil)
  | "sem_funil" // o funil declarado não existe nesta organização / está arquivado
  | "sem_etapa" // o funil existe e não tem etapa utilizável
  | "contato_bloqueado" // pediu para sair
  | "contato_pessoal" // marcado como pessoal (spec 21)
  | "ja_existe" // já há negócio aberto para o contato — um por demanda, não um por conversa
  | "erro"; // qualquer falha de leitura/escrita

export type EntradaNoFunil =
  | { criado: true; leadId: string; pipelineId: string; stageId: string }
  | { criado: false; motivo: MotivoSemNegocio; detalhe?: string };

export interface ConversaNova {
  organizationId: string;
  contactId: string;
  /** A conversa que originou o card — vai ao vínculo da atividade e ao payload. */
  conversationId: string;
  /**
   * O nome que veio no payload do canal, quando existe. O CADASTRO vence (é a
   * régua de `nascimento-do-lead.ts`): quem manda mensagem sem nome no pacote
   * não pode batizar de "Novo contato" alguém que o CRM conhece pelo nome.
   */
  nomeDoContato?: string | null;
}

/**
 * A PRIMEIRA etapa utilizável do funil — menor `position` entre as não
 * arquivadas, fora ganho e perda. Um card não nasce fechado, e um funil mal
 * ordenado não pode fazer alguém entrar como "Perdido".
 */
async function primeiraEtapaAberta(
  db: SupabaseClient,
  organizationId: string,
  pipelineId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * A etapa em que o card nasce: a DECLARADA, se ela ainda vale neste funil;
 * senão a primeira aberta.
 *
 * As quatro condições da declarada (organização, funil, aberta, fora
 * ganho/perda) são as MESMAS de `primeiraEtapaAberta` — e é isso que fecha a
 * distância entre "o valor que está gravado" e "o que o banco aceita". Sem elas,
 * uma configuração apontando para etapa de outro funil, arquivada ou "Perdido"
 * faria o card nascer no lugar errado.
 */
async function etapaDoCard(
  db: SupabaseClient,
  organizationId: string,
  pipelineId: string,
  stageDeclarada: string | null,
): Promise<string | null> {
  if (stageDeclarada) {
    const { data, error } = await db
      .from("crm_stages")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("pipeline_id", pipelineId)
      .eq("id", stageDeclarada)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false)
      .maybeSingle();
    if (!error && (data as { id?: string } | null)?.id) {
      return (data as { id: string }).id;
    }
    // A etapa escolhida não vale mais: arquivada, apagada, de outro funil ou
    // fechada como ganho/perdido. O card entra na primeira — a decisão é a certa,
    // mas não pode ser SILENCIOSA: é este log que explica por que os cards
    // deixaram de aparecer na coluna escolhida.
    logger.warn("[entrada-automatica] etapa escolhida não vale mais neste funil", {
      organizationId,
      pipelineId,
      stage_id_declarado: stageDeclarada,
    });
  }
  return primeiraEtapaAberta(db, organizationId, pipelineId);
}

/**
 * Abre o negócio da conversa nova, SE a organização tiver configurado a entrada
 * automática. Idempotente e nunca lança.
 */
export async function abrirNegocioDaConversaNova(
  db: SupabaseClient,
  conversa: ConversaNova,
): Promise<EntradaNoFunil> {
  const { organizationId, contactId, conversationId } = conversa;

  // ─── 1 · a preferência da organização ──────────────────────────────────────
  // Uma leitura só, e a PRIMEIRA: sem configuração não há nada a fazer, e o
  // caminho comum (toda instalação hoje) não pode pagar as consultas de baixo.
  const { data: org, error: erroDaOrg } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (erroDaOrg) {
    logger.warn("[entrada-automatica] leitura das configurações falhou", {
      organizationId,
      error: erroDaOrg.message,
    });
    return { criado: false, motivo: "erro", detalhe: erroDaOrg.message.slice(0, 120) };
  }

  const declarada = entradaAutomaticaNoFunilDeclarada(
    (org as { settings?: unknown } | null)?.settings,
  );
  // Configuração incompleta (`ativa` sem funil) é `nao_configurado`, e não
  // `sem_funil`: quem não escolheu funil não escolheu nada, e a diferença
  // importa para quem lê o log.
  if (!declarada.ativa || !declarada.pipeline_id) {
    return { criado: false, motivo: "nao_configurado" };
  }

  try {
    // ─── 2 · o funil escolhido, conferido contra o banco ─────────────────────
    const { data: funil, error: erroDoFunil } = await db
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", declarada.pipeline_id)
      .eq("is_archived", false)
      .maybeSingle();

    if (erroDoFunil) {
      logger.warn("[entrada-automatica] leitura do funil escolhido falhou", {
        organizationId,
        pipelineId: declarada.pipeline_id,
        error: erroDoFunil.message,
      });
      return { criado: false, motivo: "erro", detalhe: erroDoFunil.message.slice(0, 120) };
    }
    if (!(funil as { id?: string } | null)?.id) {
      logger.warn("[entrada-automatica] funil escolhido não existe nesta organização", {
        organizationId,
        pipelineId: declarada.pipeline_id,
      });
      return { criado: false, motivo: "sem_funil" };
    }

    // ─── 3 · a etapa ────────────────────────────────────────────────────────
    const stageId = await etapaDoCard(
      db,
      organizationId,
      declarada.pipeline_id,
      declarada.stage_id,
    );
    if (!stageId) return { criado: false, motivo: "sem_etapa" };

    // ─── 4 · o contato: portão e título na MESMA leitura ────────────────────
    const { data: contato, error: erroDoContato } = await db
      .from("contacts")
      .select("is_blocked,is_personal,display_name,name,phone_number")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();

    if (erroDoContato) {
      logger.warn("[entrada-automatica] leitura do contato falhou", {
        organizationId,
        contactId,
        error: erroDoContato.message,
      });
      return { criado: false, motivo: "erro", detalhe: erroDoContato.message.slice(0, 120) };
    }
    const linha = contato as {
      is_blocked?: boolean;
      is_personal?: boolean;
      display_name?: string | null;
      name?: string | null;
      phone_number?: string | null;
    } | null;
    if (linha?.is_blocked === true) return { criado: false, motivo: "contato_bloqueado" };
    if (linha?.is_personal === true) return { criado: false, motivo: "contato_pessoal" };

    const doCadastro = rotuloDoContato(linha);
    const doPayload = (conversa.nomeDoContato ?? "").trim();
    const titulo =
      doCadastro !== SEM_NOME
        ? doCadastro
        : doPayload !== ""
          ? doPayload
          : `Novo contato pelo ${ORIGEM_DA_ENTRADA_AUTOMATICA.rotulo}`;

    // ─── 5 · o card, pela RPC canônica ──────────────────────────────────────
    // Pela RPC e não por INSERT: entre "não existe aberto" e o INSERT há janela,
    // e duas conversas do mesmo contato abertas juntas criariam dois cards. A
    // função serializa por (organização, contato) e devolve NULL quando já há um
    // aberto — NULL é o desfecho correto da segunda, não erro.
    const { data: novoId, error } = await db.rpc("fn_nascer_lead_da_conversa", {
      p_org: organizationId,
      p_contact: contactId,
      p_pipeline: declarada.pipeline_id,
      p_stage: stageId,
      p_title: titulo,
      p_source: ORIGEM_DA_ENTRADA_AUTOMATICA.source,
      p_source_metadata: { conversation_id: conversationId, entrada: "automatica" },
      p_tags: [],
    } as never);

    if (error) {
      logger.error("[entrada-automatica] o negócio não pôde nascer", {
        organizationId,
        contactId,
        conversationId,
        error: error.message.slice(0, 120),
      });
      return { criado: false, motivo: "erro", detalhe: error.message.slice(0, 120) };
    }
    if (!novoId) return { criado: false, motivo: "ja_existe" };

    const leadId = novoId as string;

    // ─── 6 · o registro, pelo emissor canônico ──────────────────────────────
    // Sem esta linha o card aparece no quadro sem que ninguém saiba de onde veio
    // — e "apareceu sozinho" é como se perde a confiança num automatismo.
    const registro = await emitLeadActivity(db, {
      organizationId,
      leadId,
      contactId,
      type: "lead_created",
      sourceModule: "inbox.entrada_automatica",
      sourceId: conversationId,
      // `webhook_source` é a variante que `actorParaAtividade` traduz para
      // `kind: "system"` na timeline, e ela descreve o que aconteceu: o produto
      // agiu sozinho, a pedido de uma preferência da organização.
      actor: { type: "webhook_source", id: "entrada-automatica-no-funil" },
      reason: ORIGEM_DA_ENTRADA_AUTOMATICA.motivo,
      payload: { conversation_id: conversationId, pipeline_id: declarada.pipeline_id },
    });
    if (!registro.ok) {
      // O card existe e é o que importa; a timeline falhou. Devolver erro aqui
      // faria quem chama achar que o negócio não nasceu — e ele nasceu.
      logger.warn("[entrada-automatica] atividade da timeline não registrada", {
        organizationId,
        leadId,
        error: registro.error?.slice(0, 120),
      });
    }

    // O MESMO evento que o nascimento pela ingestão emite. Sem ele, o gatilho
    // "Lead criado" (automações e follow-up) não vê a conversa, e a regra só
    // existiria para formulário e webhook. Falha aqui não desfaz o card.
    const { error: erroEvento } = await db.rpc("emit_event", {
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: {
        pipeline_id: declarada.pipeline_id,
        stage_id: stageId,
        conversation_id: conversationId,
      },
      p_metadata: { source: "entrada-automatica-no-funil" },
      p_organization_id: organizationId,
    } as never);
    if (erroEvento) {
      logger.warn("[entrada-automatica] evento lead.created não emitido", {
        organizationId,
        leadId,
        error: erroEvento.message.slice(0, 120),
      });
    }

    return { criado: true, leadId, pipelineId: declarada.pipeline_id, stageId };
  } catch (erro) {
    // Rede de segurança: nem leitura estourada, nem jsonb absurdo, nem resposta
    // inesperada do banco podem derrubar a abertura de uma conversa.
    logger.error("[entrada-automatica] a entrada no funil estourou", {
      organizationId,
      contactId,
      conversationId,
      motivo: erro instanceof Error ? erro.message.slice(0, 120) : String(erro).slice(0, 120),
    });
    return { criado: false, motivo: "erro" };
  }
}
