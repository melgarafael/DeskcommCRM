import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * O ENVIO do aviso de escalação — lado do CRM (`supabase-js`).
 *
 * ## Por que existe um segundo emissor
 *
 * O repo tem DOIS motores de passagem para humano, e eles não se falam:
 *
 *   - `performHumanHandoff` (`lib/agent-engine/agent/human-handoff.ts`) roda no
 *     motor de conversa, sobre `pg.Pool`, dentro de um turno com job e canal;
 *   - `triggerHandoff` (`./orchestrator.ts`) roda no mundo do CRM, sobre
 *     `supabase-js`, disparado por evento (sentimento) ou por tool MCP — sem
 *     job, sem `pg.Pool`, às vezes dentro de uma requisição Next.
 *
 * Consertar só o primeiro conserta metade do defeito. A conversa `b934ba2d`
 * medida em produção em 2026-08-26 — a que ficou muda depois que a IA PERGUNTOU
 * o e-mail do cliente — foi silenciada por ESTE lado, com
 * `last_handoff_reason='low_sentiment'`.
 *
 * ## Por que o texto é o mesmo e o encanamento não
 *
 * O texto é `lib/escalacao/aviso-ao-lead.ts`, compartilhado — duas redações
 * envelheceriam separadas. O encanamento não pode ser: `runBeforeSend` exige
 * `pg.Pool` e um `job_id` para o ledger, e aqui não há nem um nem outro. Abrir
 * um pool dentro de uma rota Next para mandar uma frase seria pagar caro por
 * simetria de fachada.
 *
 * O que se perde sem a cadeia, dito com todas as letras: janela/throttle
 * anti-ban, spinning, disclosure e o gate de LGPD. O que NÃO se perde é o que
 * mais importa aqui — `sendMessageHandler` recusa contato `is_blocked` com 403
 * (`app/api/v1/messages/_handler.ts`), que é a trava irrevogável (regra dura
 * nº 2). E o aviso do lado do motor, esse sim, passa pela cadeia inteira.
 *
 * ## As quatro guardas, e a ordem delas
 *
 * 1. a IA precisa ter FALADO nesta conversa;
 * 2. um aviso por conversa a cada 24 h;
 * 3. o CLIENTE precisa estar esperando resposta (#4797 — a frase responde a
 *    uma mensagem dele, não a um relógio);
 * 4. fora de turno, a HORA é a da organização (#4797 — 22h soa como robô).
 *
 * As duas primeiras são de 2026-09-27; as duas últimas vêm do incidente de
 * 16/11, em que um aviso saiu três dias depois da última entrada, às 22h, com
 * nenhuma mensagem nova do cliente. O porquê de cada uma está no ponto onde
 * ela mora.
 *
 * ## Ordem
 *
 * Chamado ANTES do UPDATE que silencia. Do lado do motor a ordem é obrigatória
 * (o `force_human` que ele grava arma o `stopGate` e mata o envio seguinte);
 * deste lado ela é apenas honesta — `triggerHandoff` não grava `force_human`, e
 * o silêncio que ele grava não é lido pelo caminho de envio. Mantê-la igual nos
 * dois evita que alguém "otimize" um deles sem perceber que no outro isso apaga
 * a mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  motivoDoAviso,
  textoDoAviso,
  type MotivoDoAviso as MotivoDaFrase,
} from "@/lib/escalacao/aviso-ao-lead";
import { comecaComPalavraDeSaida } from "@/lib/opt-out/deteccao";
import { lerFraseDoAvisoConfigurada } from "@/lib/escalacao/frase-do-aviso-configurada";
import { carregarRosterDeAtendimento, podeAssumirAgora } from "@/lib/escalacao/atendentes";
// Dois `MotivoDoAviso` no repositório: o de `escalacao/aviso-ao-lead` diz QUE
// FRASE o cliente lê; este diz POR QUE ele não leu nada. O apelido impede a
// confusão numa leitura rápida.
import type {
  DesfechoDoAvisoAoCliente,
  MotivoDoAviso as MotivoDoAvisoDaPassagem,
  OrigemDaPassagem,
} from "@/lib/escalacao/passagem";
import type { QuemPodeAssumir } from "@/lib/escalacao/disponibilidade";
import { logger } from "@/lib/logger";
import { adiarAteAJanelaAbrir } from "@/lib/automation/janela-do-canal";

/** Ator do envio — é o automático falando, não uma pessoa. */
const ATOR_DO_AVISO = "handoff-orchestrator";

/** Um aviso por conversa dentro desta janela (ver as guardas em `avisarLeadDoCrm`). */
const JANELA_DO_AVISO_MS = 24 * 60 * 60 * 1000;

export interface AvisoDoCrmInput {
  serviceBoundary?: ServiceBoundary;
  organizationId: string;
  conversationId: string;
  /** `contacts.id` — semente da variante do texto (nada dele aparece na frase). */
  contactId: string;
  /** `conversations.last_handoff_reason` que está sendo gravado agora. */
  reason: string;
  /**
   * Por onde a passagem entrou. Só `mcp_externo` muda algo aqui: ver a exceção
   * da guarda 1 em `avisarLeadDoCrm`.
   */
  origem?: OrigemDaPassagem;
}

/** Status de `messages` que significam "chegou ao cliente". */
const STATUS_ENTREGUE = new Set(["sent", "delivered", "read"]);

/**
 * O desfecho do aviso. É o MESMO tipo do outro emissor, por definição — ver
 * `DesfechoDoAvisoAoCliente`: enquanto eram dois, este lado tinha um
 * `{ avisado: boolean }` solto, e foi por essa folga que "avisado: true" passou
 * sem ninguém olhar o status da mensagem.
 */
export type DesfechoDoAvisoDoCrm = DesfechoDoAvisoAoCliente;

/**
 * `messages.error_code` → o motivo fechado. Parcial de propósito: código que não
 * está aqui vira "não avisado, motivo desconhecido", que é a verdade disponível.
 */
const CODIGO_DO_ERRO: Readonly<Record<string, MotivoDoAvisoDaPassagem>> = {
  pre_go_live: "pre_go_live",
  pre_go_live_indisponivel: "pre_go_live",
  channel_archived: "canal_arquivado",
  missing_phone_number: "sem_telefone",
};

/**
 * Avisa o lead. NUNCA lança: o orquestrador inteiro é fire-and-forget por
 * contrato ("nunca propaga exceção pro caller"), e um erro aqui não pode impedir
 * a passagem que ele antecede.
 *
 * ⚠️ **O QUE MUDOU, e por que era grave.** Esta função devolvia `avisado: true`
 * sempre que `sendMessageHandler` não LANÇAVA — e ele quase nunca lança: canal
 * em modo de teste, canal arquivado, contato sem telefone e recusa do transporte
 * viram `status='failed'` DENTRO da linha da mensagem, com `error_code`, e a
 * chamada volta normal. O resultado é que a Central afirmava "O cliente JÁ FOI
 * avisado" para uma pessoa que não recebeu nada, e o atendente abria a conversa
 * respondendo a alguém que não sabia que ele vinha. Agora o desfecho é lido do
 * `status` da mensagem devolvida, que é o único lugar onde ele existe.
 */
export async function avisarLeadDoCrm(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<DesfechoDoAvisoDoCrm> {
  try {
    // ═══ DUAS GUARDAS ANTES DE QUALQUER TEXTO ═══
    //
    // 1. A IA precisa ter FALADO nesta conversa. O aviso existe para o cliente
    //    não ficar falando com o vazio quando a IA se retira — mas numa
    //    instalação sem agente publicado (ou numa conversa que sempre foi
    //    humana), não há retirada a anunciar. Medido numa instalação real: o
    //    worker de sentimento roda para TODA mensagem, com ou sem agente,
    //    disparou `low_sentiment` numa organização sem agente ativo, e dois
    //    clientes receberam "Já acionei o time" sem nunca terem falado com IA.
    //    O próprio aviso NÃO conta como fala (`aviso_de_escalacao`): sem essa
    //    distinção, o primeiro aviso indevido legitimaria o segundo.
    //
    // 2. UM aviso por conversa por janela de 24 h, contado no BANCO. No mesmo
    //    incidente um cliente recebeu o aviso QUATRO vezes em cinco minutos: o
    //    envio travou (canal fora do ar), o disparo foi refeito, e cada nova
    //    tentativa virou mensagem nova — o `requestId` não segura, porque cada
    //    disparo é uma chamada nova. A janela deixa passar o retrigger honesto
    //    (uma passagem nova amanhã avisa) e mata a repetição.
    //
    // As guardas moram deste lado (o CRM) porque é o único alcançável sem um
    // turno de agente: o aviso do motor só roda de dentro de um turno ativo, em
    // que a IA já falou por construção.
    //
    // Leitura que falha não avisa (fail-closed, como o gate de elegibilidade do
    // orquestrador): mandar a frase para quem nunca falou com IA é o defeito que
    // estas guardas existem para impedir.
    //
    // EXCEÇÃO da guarda 1 — `origem: "mcp_externo"`. Um agente externo
    // conectado por MCP com chave emitida pela tela (sem o escopo
    // `actor:ai_agent`, decisão de 19/09) tem as falas gravadas como
    // `sent_via='system'` (`origemDaMensagem` em `_handler.ts`), então a guarda
    // não as enxerga. Mas foi ele quem declarou a passagem — houve atendimento
    // automático — e o contrato de `crm_request_human_handoff` manda o agente
    // NÃO avisar, porque o aviso é deste lado. Sem a exceção, o cliente ficaria
    // sem aviso nenhum.
    const { data: falas, error: erroDasFalas } = await admin
      .from("messages")
      .select("metadata, created_at, status")
      .eq("organization_id", input.organizationId)
      .eq("conversation_id", input.conversationId)
      .eq("direction", "outbound")
      .eq("sent_via", "ai")
      .order("created_at", { ascending: false })
      .limit(20);
    if (erroDasFalas) {
      logger.warn("[handoff-orchestrator] falas da IA não lidas — aviso não enviado", {
        conversation_id: input.conversationId,
        error: erroDasFalas.message.slice(0, 200),
      });
      return { avisado: false, porque: "falas_da_ia_nao_lidas" };
    }
    const linhas = (falas ?? []) as {
      metadata: Record<string, unknown> | null;
      created_at: string;
      status: string | null;
    }[];
    const iaJaFalou = linhas.some((m) => m.metadata?.aviso_de_escalacao !== true);
    if (!iaJaFalou && input.origem !== "mcp_externo") {
      return { avisado: false, porque: "ia_nunca_falou_nesta_conversa" };
    }
    // Aviso `failed` não conta: ele nunca chegou (a linha nasce com o metadata
    // ANTES do envio e vira `failed` em pre_go_live, canal arquivado, sem
    // telefone ou recusa do transporte). Contá-lo seguraria por 24 h o aviso que
    // o cliente ainda não recebeu. `queued`/`sending` contam: o
    // `session-reconciler` reenvia o que está preso, e era isso que repetia.
    const corte = Date.now() - JANELA_DO_AVISO_MS;
    const avisosRecentes = linhas.filter(
      (m) =>
        m.metadata?.aviso_de_escalacao === true &&
        m.status !== "failed" &&
        new Date(m.created_at).getTime() > corte,
    );
    // O desfecho de quem é barrado diz a verdade sobre o aviso que JÁ existe —
    // senão a Central escreve "o cliente NÃO foi avisado (motivo desconhecido)"
    // para quem foi avisado há minutos.
    if (avisosRecentes.some((m) => STATUS_ENTREGUE.has(m.status ?? ""))) return { avisado: true };
    if (avisosRecentes.length > 0) {
      return {
        avisado: false,
        porque: "aviso_ja_enviado_na_janela",
        motivoCodigo: "na_fila_canal_fora",
      };
    }

    // ═══ GUARDA 3 — O AVISO RESPONDE A UMA MENSAGEM DO CLIENTE ═══
    //
    // A frase existe para o cliente que FALOU e ficou sem resposta não achar que
    // está falando com o vazio. Se ninguém falou — ou se a última fala dele já
    // foi respondida —, não há a quem responder: o aviso chega do nada, e "deixei
    // com uma pessoa da equipe" três dias depois, às 22h, lê-se como robô perdido.
    //
    // Medido em produção (#4797, conversa de canal de mensageria): última mensagem do
    // cliente em 13/11 15:23, resposta do agente em 15:24, mensagem MANUAL do
    // atendente em 14/11 16:42 — e em 16/11 22:19 saiu "Deixei isso com uma pessoa
    // da equipe, que continua daqui. Agora não tem ninguém livre…" com
    // `sent_via: ai`, `ai_actor_id: handoff-orchestrator`, `aviso_de_escalacao:
    // true`. As guardas 1 e 2 não tinham o que dizer sobre isso: a IA JÁ tinha
    // falado (13/11), e a passagem anterior tinha mais de 24 h. A pergunta "alguém
    // está esperando resposta?" não era feita por ninguém.
    //
    // A régua é a MESMA que o resto do repositório usa para "o cliente disse e
    // ainda não foi respondido": `last_inbound_at` mais novo que
    // `last_outbound_at` — as duas colunas são o máximo por direção, então
    // comparar máximo com máximo é exatamente "quem falou por último"
    // (`falasPendentes` em `./orchestrator.ts`, `silence-sweep`). Duas
    // expressões da mesma ideia divergem no dia em que uma delas aprende sobre
    // reação ou mensagem apagada.
    //
    // Fica deste lado (CRM) porque é aqui que o envio acontece sem turno: o
    // emissor do motor só roda de dentro de um turno, e turno, por construção,
    // nasce de uma entrada do cliente.
    //
    // DUAS EXCEÇÕES, e as duas com o horário como contrapartida (guarda 4):
    //   - `mcp_externo`: o agente externo conversou pelo canal e declarou a
    //     passagem; as falas dele não são `sent_via='ai'`, então a conversa pode
    //     parecer "respondida" para esta leitura. O contrato do
    //     `crm_request_human_handoff` manda ELE não avisar — o aviso é daqui.
    //   - passagem decidida por uma PESSOA (`origem: "caso_escalado"`, a rota da
    //     Central): quem clicou "escalar" sabe o que está fazendo. Silenciar um
    //     atendente é pior que a frase fora de hora; a hora é tratada abaixo.
    //     `origem` AUSENTE não é pessoa: cai na guarda (fail-closed para quem
    //     acrescentar um chamador novo e esquecer de dizer de onde veio).
    const decididaPorPessoa = input.origem === "caso_escalado";
    const foraDeTurno = input.origem === "mcp_externo" || decididaPorPessoa;
    // UMA leitura serve às duas guardas: a conversa sabe quem falou por último e
    // por qual canal ela sai. `lerConversa` devolve três estados porque
    // "indeterminado" não pode virar nem "esperando" nem "sem espera".
    const conversa = await lerConversa(admin, input);
    if (!foraDeTurno) {
      // Leitura que falha não avisa (fail-closed, como as guardas acima e como o
      // gate de elegibilidade): mandar a frase sem saber se alguém espera é
      // exatamente o defeito que esta guarda existe para impedir.
      if (conversa.tipo === "indeterminado") {
        return { avisado: false, porque: "espera_do_cliente_nao_lida" };
      }
      if (!conversa.esperando) {
        return { avisado: false, porque: "sem_mensagem_nova_do_cliente" };
      }
    }

    // ═══ GUARDA 4 — FORA DE TURNO, A HORA É A DA ORGANIZAÇÃO ═══
    //
    // O caminho do MOTOR já passa por `runBeforeSend`, que aplica a janela do
    // canal; este lado não passa (ver o cabeçalho: aqui não há `pg.Pool` nem
    // `job_id`). Era essa a segunda metade do defeito #4797: a frase saiu às 22h
    // porque nada, neste caminho, perguntava que horas são para quem vai receber.
    //
    // A janela é a MESMA que a automação e o follow-up já respeitam
    // (`channel_knobs`, no fuso da ORGANIZAÇÃO — ver `lib/automation/janela-do-canal.ts`),
    // não uma segunda régua. Sem linha em `channel_knobs`, valem os padrões do
    // pacing, que já seguram a madrugada.
    //
    // Só para quem está fora de turno: um cliente que acabou de escrever e não foi
    // respondido recebe o aviso a qualquer hora — deixá-lo no escuro até as 8h
    // seria trocar um incômodo por um abandono.
    if (foraDeTurno && conversa.tipo === "ok" && conversa.canal !== null) {
      const proxima = await adiarAteAJanelaAbrir(
        admin,
        input.organizationId,
        conversa.canal,
        new Date(),
      );
      if (proxima !== null) {
        logger.info("[handoff-orchestrator] aviso fora da janela de envio — não enviado", {
          conversation_id: input.conversationId,
          proxima_abertura: proxima,
        });
        return {
          avisado: false,
          porque: "fora_da_janela_de_envio",
          motivoCodigo: "fora_da_janela",
        };
      }
    }

    // O aviso sai no idioma da ORGANIZAÇÃO (ver `textoDoAviso`). A leitura que
    // falha não pode derrubar o aviso: sem idioma, sai em português, como antes.
    let idioma: string | null = null;
    try {
      const { data: org } = await admin
        .from("organizations")
        .select("locale")
        .eq("id", input.organizationId)
        .maybeSingle();
      idioma = (org as { locale?: string | null } | null)?.locale ?? null;
    } catch {
      idioma = null;
    }
    const body = textoDoAviso(
      await motivoDaFrase(admin, input),
      await quemPodeAssumir(admin, input.organizationId),
      input.contactId,
      idioma,
      // #3725 — a frase do tenant, quando ele escreveu uma. Lida aqui porque
      // este emissor não tem turno: a conversa diz qual agente está ativo, e o
      // agente diz a frase. Falha de leitura ⇒ `null` ⇒ o padrão do produto;
      // um aviso de passagem nunca deixa de sair por causa de uma preferência.
      await fraseDoAgente(admin, input),
    );
    const mensagem = await sendMessageHandler(
      admin,
      {
        organization_id: input.organizationId,
        serviceBoundary: input.serviceBoundary,
        actor: { type: "ai_agent", id: ATOR_DO_AVISO, role: "manager" },
        requestId: `handoff-aviso-${input.conversationId}`,
      },
      {
        conversation_id: input.conversationId,
        type: "text",
        body,
        // A linha se DECLARA. Sem isto, no banco e na tela, este aviso é
        // indistinguível de uma fala do agente — e ele não é: é texto de
        // sistema, escrito em código, que sai no instante em que a IA se
        // retira. Quem audita a conversa depois precisa saber a diferença, e
        // quem escreve teste sobre este caminho também.
        metadata: { aviso_de_escalacao: true, handoff_reason: input.reason },
      },
    );
    if (mensagem.status === "sent") return { avisado: true };
    if (mensagem.status === "queued") {
      // `queued` é canal fora do ar OU instalação sem transporte configurado —
      // nos dois casos o cliente não recebeu nada e pode nunca receber. Chamar
      // isso de "avisado" é a promessa que quebrava a primeira frase de quem
      // assume a conversa.
      return {
        avisado: false,
        porque: "na_fila_canal_fora",
        motivoCodigo: "na_fila_canal_fora",
      };
    }
    const codigo = CODIGO_DO_ERRO[mensagem.error_code ?? ""] ?? "falhou_no_envio";
    return { avisado: false, porque: mensagem.error_code ?? "falhou_no_envio", motivoCodigo: codigo };
  } catch (err) {
    // PII fora do log: só o motivo da falha.
    const porque = err instanceof Error ? err.name : "erro_desconhecido";
    logger.warn("[handoff-orchestrator] aviso ao lead não saiu", {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { avisado: false, porque };
  }
}


/**
 * A frase própria do tenant (#3725): conversa → agente ativo → `ai_agents.config`.
 *
 * Duas leituras, e nenhuma delas pode custar o aviso: qualquer erro, campo
 * ausente ou agente sem frase devolve `null`, e `textoDoAviso` sai com o padrão
 * do produto. É a mesma direção de falha do resto do arquivo — o cliente ser
 * avisado importa mais do que o tom do aviso.
 */
async function fraseDoAgente(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<string | null> {
  try {
    const { data: conversa } = await admin
      .from("conversations")
      .select("active_ai_agent_id")
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId)
      .maybeSingle();
    const agentId = (conversa as { active_ai_agent_id?: string | null } | null)?.active_ai_agent_id;
    if (!agentId) return null;
    const { data: agente } = await admin
      .from("ai_agents")
      .select("config")
      .eq("organization_id", input.organizationId)
      .eq("id", agentId)
      .maybeSingle();
    return lerFraseDoAvisoConfigurada((agente as { config?: unknown } | null)?.config);
  } catch {
    return null;
  }
}

/**
 * Qual frase o cliente lê. Parte do motivo gravado (`last_handoff_reason`) e só
 * o troca num caso: o motivo é o GENÉRICO ("outro" — clima ruim, baixa
 * confiança…) e a última coisa que o cliente escreveu COMEÇA com a palavra de
 * saída ("Parar não é daqui"). Aí a frase é a de suspeita de opt-out — "Entendi.
 * Vou parar de te enviar mensagens automáticas por aqui." — e não "passei seu
 * pedido para um atendente humano. Fica por aqui que já te respondem.", que
 * promete atendimento a quem acabou de dizer que não quer mais mensagens.
 *
 * Medido em produção (30/09/2026): um lead respondeu "Parar não é daqui"; o
 * detector de bloqueio não casa (exige a palavra sozinha), o sentimento
 * escalou como `low_sentiment` e a frase genérica saiu. `pediu_humano` e
 * `orcamento_de_ia` têm frase própria e não são reavaliados.
 *
 * Leitura que falha devolve o motivo gravado: errar para o lado de como era antes.
 */
async function motivoDaFrase(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<MotivoDaFrase> {
  const gravado = motivoDoAviso(input.reason);
  if (gravado !== "outro") return gravado;
  try {
    const { data } = await admin
      .from("messages")
      .select("body")
      .eq("organization_id", input.organizationId)
      .eq("conversation_id", input.conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ultima = (data as { body?: string | null } | null)?.body ?? null;
    return comecaComPalavraDeSaida(ultima) ? "suspeita_de_opt_out" : gravado;
  } catch {
    return gravado;
  }
}

/**
 * Quantos podem assumir agora, no vocabulário que o texto espera.
 *
 * Reusa `carregarRosterDeAtendimento` + `podeAssumirAgora` — o par supabase-js
 * que a rota do painel e a capacidade do agente já usam. Não é um terceiro
 * leitor: é o MESMO predicado (`isAttendantEligible`) que o motor lê por `pg` em
 * `quemPodeAssumirAgora`. Duas portas, uma régua.
 *
 * `null` quando a leitura falha — e `textoDoAviso` lê `null` como "não prometa
 * prazo", que é a direção certa do erro.
 */
async function quemPodeAssumir(
  admin: SupabaseClient,
  organizationId: string,
): Promise<QuemPodeAssumir | null> {
  try {
    const agora = new Date();
    const roster = await carregarRosterDeAtendimento(admin, organizationId, agora);
    return {
      total: roster.length,
      disponiveis: roster.filter((a) => podeAssumirAgora(a, agora)).length,
    };
  } catch (err) {
    logger.warn("[handoff-orchestrator] disponibilidade não lida — aviso sem prazo", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }
}

/**
 * A CONVERSA, nas duas perguntas das guardas 3 e 4 — em UMA leitura.
 *
 * `esperando` = a última mensagem é do CLIENTE: `last_inbound_at` mais novo que
 * `last_outbound_at`. É a régua de "o que o cliente disse e ninguém respondeu"
 * que o resto do repositório já usa (`falasPendentes` em `./orchestrator.ts`,
 * `silence-sweep` para o silêncio); as duas colunas são o MÁXIMO por direção, e
 * comparar máximo com máximo é exatamente "quem falou por último".
 *
 * Mensagem de entrada no MESMO instante da saída não conta: é empate de relógio,
 * não espera — e mandar a frase por causa de um empate seria avisar sem motivo.
 *
 * Três estados, e o terceiro não é decoração: `indeterminado` (linha ausente ou
 * leitura que falhou) NÃO vira `esperando: false`. A guarda 3 trata como "não
 * avisa", e o `porque` devolvido nomeia a leitura — não a conversa — como a
 * causa do silêncio.
 *
 * `canal` é o `channel_session_id` da MESMA linha: a janela de horário é a do
 * número por onde esta conversa sai, nunca a de outro número da organização.
 */
type ConversaDoAviso =
  | { tipo: "ok"; esperando: boolean; canal: string | null }
  | { tipo: "indeterminado" };

async function lerConversa(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<ConversaDoAviso> {
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("last_inbound_at, last_outbound_at, channel_session_id")
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId)
      .maybeSingle();
    if (error) {
      logger.warn("[handoff-orchestrator] conversa não lida — aviso não enviado", {
        conversation_id: input.conversationId,
        error: error.message.slice(0, 200),
      });
      return { tipo: "indeterminado" };
    }
    const c = data as {
      last_inbound_at?: string | null;
      last_outbound_at?: string | null;
      channel_session_id?: string | null;
    } | null;
    // Conversa que não está lá é conversa que não tem a quem avisar: mandar
    // seria criar mensagem órfã. Fail-closed, como a leitura que falha.
    if (c === null || c === undefined) return { tipo: "indeterminado" };

    const entrada = c.last_inbound_at ?? null;
    const saida = c.last_outbound_at ?? null;
    const esperando =
      entrada !== null && (saida === null || new Date(entrada).getTime() > new Date(saida).getTime());
    const canal = c.channel_session_id ?? null;
    return { tipo: "ok", esperando, canal: canal !== "" ? canal : null };
  } catch (err) {
    logger.warn("[handoff-orchestrator] conversa não lida — aviso não enviado", {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { tipo: "indeterminado" };
  }
}
