/**
 * A CONVERSA VIRA LEAD — o elo que faltava (spec 17 §3).
 *
 * ═══ O PROBLEMA, MEDIDO ═══
 *
 * Na produção deste projeto, em 2026-08-06: **32 conversas para 15 leads**, e
 * **13 dos 15 leads sem contato vinculado**. Varredura no repo: nenhum código
 * inseria em `crm_leads` a partir de conversa. Quem escrevia no WhatsApp virava
 * contato e parava ali.
 *
 * O `crm_leads.contact_id` sempre existiu, e a UI já o usa (`LeadDossier` abre a
 * timeline por contato). O vínculo não estava quebrado — estava **vazio**.
 *
 * ═══ POR QUE ISTO É O ANTI-MORTE, E NÃO CONVENIÊNCIA ═══
 *
 * O invariante 4 do sistema vivo diz que nenhuma demanda fica sem próximo passo.
 * Hoje **conversa fora do funil não é cobrada por ninguém**: nem pelo Radar de
 * Risco, nem pelo motor de follow-up — os dois trabalham sobre `crm_leads`.
 *
 * Alguém que escreveu, não foi respondido e não estava no funil desaparecia sem
 * deixar rastro em lugar nenhum que alguém olhe. O lead nascendo é o que coloca
 * essa pessoa no radar.
 *
 * ═══ O SISTEMA CRIA, NÃO O MODELO ═══
 *
 * Determinístico, no ingest. É a mesma razão da spec 16 impor o checkpoint em
 * vez de confiar numa tool: entrada de funil que depende de o modelo lembrar é
 * entrada que falha justamente no turno atípico.
 *
 * ═══ NADA É FIXO ═══
 *
 * O funil de entrada é `crm_pipelines.is_default` — que já existe, já tem tela e
 * já tem regra de exclusividade (`lib/pipelines/pipeline-editing.ts`). A etapa é
 * a de menor `position` entre as não-arquivadas. **Nenhum campo novo**: criar
 * `is_entry_pipeline` ou uma flag de primeira etapa seria um segundo lugar para
 * uma verdade que já existe, e é daí que a divergência nasce.
 *
 * Isto vale para o produto inteiro, não para uma organização: uma clínica, uma
 * imobiliária e um infoprodutor montam funis diferentes, e nenhum nome de funil
 * aparece neste arquivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import { ehIdentificadorTecnico, rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";

import { emitLeadActivity } from "./activity-emitter";

/**
 * O rótulo que aparece no card do funil quando o lead nasceu de um clique em
 * anúncio — pedido explícito do produto: "Meta_ads"/"Google_ads" visível,
 * não escondido atrás de hover. `crm_leads.tags` já é o mecanismo que o
 * Kanban usa para isso (`canonicalTag` em `lib/kanban/card-state.ts`, ponto
 * ao lado do título quando a tag está em `crm_pipelines.settings.canonical_tags`) —
 * reaproveitado aqui, não reinventado.
 */
const ROTULO_DE_ANUNCIO: Record<string, string> = {
  meta_ads: "Meta_ads",
  google_ads: "Google_ads",
};

/**
 * De onde a conversa veio, para os dois pontos que precisam de um rotulo
 * legivel: o titulo de fallback do card (quando nao ha nome cadastrado) e o
 * `source` gravado em `crm_leads` (quando nao ha atribuicao de anuncio).
 *
 * Default preserva o comportamento de sempre (WhatsApp, unico canal ate a
 * chamada de voz existir) -- os chamadores atuais nao precisam informar isto.
 */
export interface OrigemDoNascimento {
  /** Nome do canal para o fallback do titulo ("Novo contato pelo X"). */
  rotulo: string;
  /** Valor de `crm_leads.source` quando nao ha atribuicao de anuncio. */
  source: string;
  /** Texto curto do "porque" na atividade da timeline. */
  motivo: string;
}

const ORIGEM_PADRAO: OrigemDoNascimento = {
  rotulo: "WhatsApp",
  source: "whatsapp",
  motivo: "primeira mensagem recebida no WhatsApp",
};

/**
 * Por que um lead NÃO nasceu. Cada motivo é registrado — silêncio não distingue
 * "não devia nascer" de "falhou ao nascer", e a segunda é a que custa caro.
 */
export type MotivoSemLead =
  | "ja_existe" // o contato já tem lead aberto: um por demanda, não um por mensagem
  | "contato_bloqueado" // pediu para sair; criar oportunidade seria desrespeito registrado
  | "sem_funil_de_entrada" // a organização não tem funil padrão — falha de configuração, visível
  | "sem_etapa" // o funil existe e não tem etapa utilizável
  | "erro"; // qualquer falha de escrita

export type NascimentoDoLead =
  | { criado: true; leadId: string; pipelineId: string; stageId: string }
  | { criado: false; motivo: MotivoSemLead; detalhe?: string };

export interface DadosDoNascimento {
  organizationId: string;
  contactId: string;
  /** conversa que originou — vai ao vínculo e ao registro. */
  conversationId: string;
  /** nome do contato, para o título do card. */
  nomeDoContato: string | null;
  /** Rotulo/source/motivo do canal de origem -- default preserva o WhatsApp. */
  origem?: OrigemDoNascimento;
}

/**
 * O funil de entrada da organização e a etapa onde o lead nasce.
 *
 * Exportada porque a decisão "onde entra" precisa ser inspecionável por quem
 * configura (spec 17 §7, invariante 6): uma tela que queira dizer "novos
 * contatos entram em X, etapa Y" pergunta aqui, em vez de reimplementar a regra
 * e divergir dela.
 */
export async function funilDeEntrada(
  db: SupabaseClient,
  organizationId: string,
): Promise<{ pipelineId: string; stageId: string } | { erro: MotivoSemLead }> {
  const { data: funil } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();

  if (!funil) return { erro: "sem_funil_de_entrada" };

  // A PRIMEIRA etapa é a de menor `position` — a ordem do funil já diz qual é.
  // Etapas de ganho/perda ficam de fora: um lead não nasce fechado, e um funil
  // mal ordenado não pode fazer alguém entrar como "Perdido".
  const { data: etapa } = await db
    .from("crm_stages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("pipeline_id", funil.id)
    .eq("is_archived", false)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!etapa) return { erro: "sem_etapa" };
  return { pipelineId: funil.id as string, stageId: etapa.id as string };
}

/**
 * Garante que a conversa tenha um lead. Idempotente por contato: chamar de novo
 * não cria um segundo card.
 *
 * **Um lead por DEMANDA, não por mensagem.** Enquanto houver lead aberto para o
 * contato, novas mensagens alimentam o que já existe. Quando ele fecha (ganho ou
 * perdido) e a pessoa volta a escrever, nasce outro — que é o comportamento
 * certo: é uma demanda nova.
 */
export async function garantirLeadDaConversa(
  db: SupabaseClient,
  dados: DadosDoNascimento,
): Promise<NascimentoDoLead> {
  const { organizationId, contactId, conversationId } = dados;
  const origem = dados.origem ?? ORIGEM_PADRAO;

  // 1 · quem pediu para sair não vira oportunidade. O gate de envio já respeita
  // o opt-out; abrir um card para essa pessoa seria a mesma desatenção num
  // lugar onde ninguém olharia.
  const { data: contato } = await db
    .from("contacts")
    .select("is_blocked,display_name,name,phone_number,source,source_metadata")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (contato?.is_blocked === true) return { criado: false, motivo: "contato_bloqueado" };

  // 2 · já existe demanda aberta?
  const { data: existente } = await db
    .from("crm_leads")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();

  if (existente) return { criado: false, motivo: "ja_existe" };

  // 3 · onde entra
  const destino = await funilDeEntrada(db, organizationId);
  if ("erro" in destino) return { criado: false, motivo: destino.erro };

  // 4 · o card.
  //
  // O nome vem do CADASTRO, não do payload — e a correção é do próprio passo 1.
  // A versão anterior usava `notifyNameOf(p)` cru, então um contato conhecido
  // que mandasse uma mensagem sem nome no pacote (acontece em 2 de cada
  // 271 inbounds, e em TODO ack) abria um card chamado "Novo contato pelo
  // WhatsApp" — para alguém que o CRM conhece pelo nome.
  //
  // ⚠️ E o comentário que estava aqui MENTIA: dizia que "o chamador garante" que
  // o nome não é identificador técnico. O chamador (a ingestão do canal) passava
  // o payload cru, sem guarda nenhuma. Typecheck e testes passavam com a
  // afirmação falsa gravada no código. Quem garante agora é `rotuloDoContato` —
  // a MESMA função que as telas usam, para que o título do card e o nome no
  // inbox não possam divergir.
  //
  // O payload entra só como reforço: o upsert do contato roda ANTES deste ponto,
  // então o cadastro já incorporou o `pushName` desta mensagem.
  const doCadastro = rotuloDoContato(contato);
  const doPayload = (dados.nomeDoContato ?? "").trim();
  const titulo =
    doCadastro !== SEM_NOME
      ? doCadastro
      : doPayload !== "" && !ehIdentificadorTecnico(doPayload)
        ? doPayload
        : // "Sem nome" serve para uma linha de lista; um card de kanban precisa
          // dizer de onde veio, senão o quadro vira uma coluna de anônimos iguais.
          `Novo contato pelo ${origem.rotulo}`;

  // De onde veio: o contato já carrega a atribuição de anúncio (gravada no
  // primeiro toque, por `fn_estampar_atribuicao_de_anuncio` — ver
  // `lib/leads/atribuicao-de-anuncio.ts`). O lead COPIA em vez de referenciar
  // (DIRC-D): a origem que importa é a de QUANDO O NEGÓCIO NASCEU, e o
  // contato pode ganhar conversas/leads futuros por outros canais sem que
  // isso reescreva a origem deste.
  const rotuloDeAnuncio = contato?.source ? ROTULO_DE_ANUNCIO[contato.source] : undefined;

  const { data: lead, error } = await db
    .from("crm_leads")
    .insert({
      organization_id: organizationId,
      pipeline_id: destino.pipelineId,
      stage_id: destino.stageId,
      contact_id: contactId,
      title: titulo,
      source: rotuloDeAnuncio ? contato!.source : origem.source,
      source_metadata: rotuloDeAnuncio ? (contato!.source_metadata ?? {}) : {},
      // O ponto ao lado do título só acende se a organização cadastrar este
      // rótulo em `crm_pipelines.settings.canonical_tags` (Configurações do
      // funil) — a tag sempre entra; o destaque visual é opt-in do operador.
      tags: rotuloDeAnuncio ? [rotuloDeAnuncio] : [],
    })
    .select("id")
    .single();

  if (error || !lead) {
    return { criado: false, motivo: "erro", detalhe: error?.message.slice(0, 120) };
  }

  // 5 · o registro, pelo EMISSOR CANÔNICO — não por insert cru.
  //
  // `emitLeadActivity` existe porque há vários escritores da timeline e o tipo
  // solto foi como a tela e o banco divergiram antes. Ele também é
  // fire-and-forget por desenho: a timeline não derruba a operação que descreve.
  //
  // Sem esta linha o card aparece no kanban sem que ninguém saiba de onde veio —
  // e "apareceu sozinho" é como se perde a confiança num automatismo
  // (invariante 3 do sistema vivo).
  const registro = await emitLeadActivity(db, {
    organizationId,
    leadId: lead.id as string,
    contactId,
    type: "lead_created",
    // `canal.ingest`, e não o nome da tecnologia: a doutrina de restrição de
    // canal (invariante 1) proíbe feature nomear provider — quem sabe qual é o
    // provider é `lib/channels/`. Aqui o que importa é o QUE originou (a
    // ingestão de uma mensagem de canal), não POR ONDE ela entrou.
    sourceModule: "canal.ingest",
    sourceId: conversationId,
    // `webhook_source` e não um "system" inventado: `actorParaAtividade` já
    // traduz esta variante para `kind: "system"` na timeline, e ela descreve o
    // que de fato aconteceu — a mensagem chegou por webhook, o produto agiu.
    actor: { type: "webhook_source", id: "canal-inbound" },
    reason: origem.motivo,
    payload: { conversation_id: conversationId },
  });
  if (!registro.ok) {
    // O lead existe e é o que importa; a linha da timeline falhou. Devolver erro
    // aqui faria o chamador achar que o card não nasceu — e ele nasceu.
    logger.warn("nascimento-do-lead: atividade não registrada", {
      organization_id: organizationId,
      lead_id: lead.id as string,
      error: registro.error?.slice(0, 120),
    });
  }

  return {
    criado: true,
    leadId: lead.id as string,
    pipelineId: destino.pipelineId,
    stageId: destino.stageId,
  };
}
