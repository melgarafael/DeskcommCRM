/**
 * Zod schemas for webhook-sources e automation-rules (feature Webhooks, Task 12).
 *
 * `ENTIDADE_ESPERADA_POR_GATILHO`, logo abaixo, é a fonte única dos gatilhos:
 * `lib/automation/engine.ts` e `lib/automation/engine.handler.ts` leem daqui.
 * (Este cabeçalho já afirmou "exatamente os 5 eventos" — número que envelheceu
 * na primeira vez que alguém acrescentou um. Agora não há número a envelhecer.)
 */
import { z } from "zod";
import { webhookFormFieldsSchema } from "@/lib/webhooks/formulario";

import { conditionsSchema } from "@/lib/automation/conditions";
import { configDoAniversario } from "@/lib/automation/aniversario-do-contato";
import {
  GATILHO_DE_DATA_DO_FUNIL,
  configDoGatilhoDeData,
} from "@/lib/automation/gatilho-de-data-do-funil";
import {
  GATILHO_ETAPA_PARADA,
  GATILHO_SILENCIO,
  configDaEtapaParada,
  configDoSilencio,
} from "@/lib/automation/gatilhos-de-tempo";

/**
 * Os gatilhos que o motor reconhece, e a entidade que cada um tem que trazer.
 *
 * É UMA FONTE, e não três, porque as três divergiam: este arquivo listava os
 * gatilhos para o Zod, `engine.ts` repetia o mapa de entidade, e
 * `engine.handler.ts` repetia a lista de novo para se registrar no dispatcher.
 * Acrescentar um gatilho exigia lembrar dos três lugares, e esquecer o terceiro
 * produz o pior desfecho possível: a regra aparece na tela, o operador a salva,
 * o evento acontece — e nada roda, porque o handler não assinou aquele evento.
 * Sem erro, sem log, sem run.
 *
 * A entidade existe porque o trigger legado `fn_emit_event_on_lead_change` emite
 * `lead.created` com `entity_kind='lead'` (derivado por `split_part` do
 * event_type) enquanto os handlers desta feature emitem `crm_lead`. Sem o guard,
 * o motor rodaria a regra duas vezes por mudança de lead.
 */
export const ENTIDADE_ESPERADA_POR_GATILHO = {
  "lead.created": "crm_lead",
  "lead.stage_changed": "crm_lead",
  // Os quatro do ENCAMENTO (#1528), que nascem do trigger do banco
  // `fn_emit_event_on_lead_change`: ele reage ao UPDATE de `crm_leads.status`
  // e de `owner_user_id`/`owner_agent_id`, então valem para TODOS os caminhos
  // que terminam naquele UPDATE — arrastar o card, o botão Ganhou/Perdeu, o
  // mover em lote, o `crm_close_demand` da IA e o mover do `create_or_move_lead`
  // — com o MESMO payload, porque há UM emissor, não um por caminho. Criar o
  // negócio já ganho/perdido ou já com dono NÃO emite: o trigger só reage a
  // UPDATE (retorna cedo no INSERT). Antes disto,
  // arrastar disparava `lead.stage_changed` e o botão não disparava regra
  // nenhuma: o fato era o mesmo e o webhook dependia do botão.
  // A entidade que a REGRA enxerga é `crm_lead` (o que o `buildContext`
  // hidrata); o `entity_kind` gravado no `event_log` é `'lead'` — o `fn_log_event`
  // deriva do `split_part` do event_type —, e o motor aceita um como sinônimo
  // do outro SÓ para os quatro (`GATILHOS_DO_TRIGGER_DE_LEAD` logo abaixo).
  "lead.won": "crm_lead",
  "lead.lost": "crm_lead",
  "lead.reopened": "crm_lead",
  "lead.assigned": "crm_lead",
  "message.received": "message",
  // A entrega FALHOU depois de aceita — o 131047 que a Meta recusa pelo
  // webhook de status, o timeout do transporte, o pré-voo do próprio envio.
  // Gatilho novo porque quem integra via token não lê o nosso banco (#1614):
  // sem ele, a linha virava `failed` sozinha e o sistema do lado de fora
  // registrava "mensagem enviada" para uma mensagem que nunca chegou.
  "message.failed": "message",
  "lead.tag_added": "crm_lead",
  "contact.tag_added": "contact",
  // O contato GANHOU telefone (#2812): a ficha que estava sem número passa a ter
  // um. É o gatilho que faltava para a operação que só consegue chamar o cliente
  // no WhatsApp depois que ele informa o número — sem ele, a única saída era o
  // operador fazer à mão. A entidade é o CONTATO (é dele o dado que mudou), como
  // os irmãos `contact.tag_added` e `contact.birthday`. O emissor vive em
  // `app/api/v1/contacts/_handler.ts`, depois do UPDATE que grava o número.
  "contact.phone_added": "contact",
  // O aniversário nasce do cron `contact-birthdays`, e não de uma ação de
  // alguém: a entidade que ele traz é o próprio contato que faz aniversário.
  "contact.birthday": "contact",
  "appointment.created": "calendar_appointment",
  "appointment.confirmed": "calendar_appointment",
  "appointment.rescheduled": "calendar_appointment",
  "appointment.cancelled": "calendar_appointment",
  // Desfecho (#1612): quem acompanha compromisso por webhook precisa saber se a
  // pessoa VEIO — comparecimento e falta não eram gatilho, e a única fonte
  // interna (`appointment.outcome_confirmed`) emite só para falta. Os dois
  // nascem da transição, em `lib/agenda/laco.ts`, e a entidade é a mesma dos
  // irmãos: o motor já sabe hidratar compromisso.
  "appointment.completed": "calendar_appointment",
  "appointment.no_show": "calendar_appointment",
  // O gatilho de DATA do funil (#989) também nasce do relógio, e não de uma
  // ação de alguém — quem o emite é a varredura `lead-date-field-due`, e a
  // entidade que ele traz é o NEGÓCIO dono do campo de data. É `crm_lead`, e
  // não `lead`: é a entidade que os handlers desta feature emitem, e a que o
  // `buildContext` do motor sabe hidratar (o negócio, e o contato dele).
  "lead.date_field_due": "crm_lead",
  // Os dois gatilhos por TEMPO (#1540): silêncio e etapa parada. Nascem do
  // relógio, como o de data do funil — quem os emite é a varredura
  // `cron/lead-time-triggers`, e a entidade é o NEGÓCIO que ficou parado.
  // O `rule_id` no payload é o mesmo recorte do gatilho de data: sem ele, duas
  // regras do mesmo gatilho com N diferentes disparariam juntas.
  "lead.silent_for": "crm_lead",
  "lead.stage_stale": "crm_lead",
} as const;

export type GatilhoDeAutomacao = keyof typeof ENTIDADE_ESPERADA_POR_GATILHO;

/**
 * Os gatilhos cujo `entity_kind` no `event_log` é `'lead'`: os quatro que o
 * trigger `fn_emit_event_on_lead_change` grava via `fn_log_event`, que deriva a
 * entidade do `split_part` do event_type.
 *
 * O motor trata `'lead'` como sinônimo de `'crm_lead'` SÓ para estes. É a
 * diferença entre fazer a regra de ganho rodar e voltar a rodar em duplicata o
 * `lead.stage_changed` legado — a linha antiga do trigger (entity_kind='lead')
 * e a que o `moveLeadHandler` já emite com `crm_lead` são o MESMO fato para o
 * guard, e rodar as duas entregaria o webhook duas vezes.
 */
export const GATILHOS_DO_TRIGGER_DE_LEAD = [
  "lead.won",
  "lead.lost",
  "lead.reopened",
  "lead.assigned",
] as const satisfies readonly GatilhoDeAutomacao[];

/**
 * As ações que regravam o status ou o dono do lead — vetadas nos gatilhos acima.
 *
 * Esses eventos nascem do trigger com `metadata '{}'`, e o anti-laço do motor só
 * reconhece `caused_by_rule`. Uma regra "responsável mudou → atribuir" ou
 * "ganhou → mover para etapa aberta" regrava o lead, o trigger emite o próximo
 * evento, e duas regras opostas se realimentam sem fim (cada volta dobra os
 * eventos). Critério de aceite da #1528: "regra lead.assigned → assign_owner não
 * entra em laço".
 *
 * ponytail: veto inteiro, não detecção de laço. Cai quando o item 5 da #1528
 * existir (GUC `app.caused_by_rule` copiada pelo trigger para `metadata`).
 *
 * A EXCEÇÃO é a continuação do ganho (#2769), tratada em
 * `acoesQueFechamLaco`: em `lead.won` a ação que a regra DECLARA só tem uma
 * moda — criar o card no funil de pós-venda, sem tocar no negócio que ganhou.
 * Quem garante isso é a própria ação (`lib/automation/actions/create-or-move-lead.ts`
 * recusa `lead.won` no MESMO funil); aqui é só a porta que deixa a regra ser
 * criada e a tela oferecer o passo.
 */
export const ACOES_QUE_REGRAVAM_O_LEAD = ["assign_owner", "create_or_move_lead"] as const;

export const MENSAGEM_DO_LACO_DE_LEAD =
  "Neste gatilho a automação não pode atribuir responsável nem mover o lead: a própria mudança dispararia a automação de novo, sem fim.";

/**
 * Os tipos de ação que uma regra declara, DESCOBRINDO os que estão DENTRO de
 * um `ai_decide` (#1970).
 *
 * O veto de #1528 é por TIPO, e o `ai_decide` esconde a ação-alvo escolhida
 * dentro do `config.opcoes`. Sem este passe, "gatilho lead.assigned → o agente
 * escolhe `assign_owner`" passaria pela checagem de laço (o tipo de topo é
 * `ai_decide`, que não consta em `ACOES_QUE_REGRAVAM_O_LEAD`) e regravaria o
 * lead que disparou a própria regra — exatamente o laço que a lista existe para
 * barrar, chegando pela porta dos fundos. Quem descobre é UMA função, usada
 * pelo schema (recusa na porta) e pelo motor (defesa em profundidade).
 */
function tiposDeAcao(actions: readonly { type: string; config?: Record<string, unknown> }[] | undefined): string[] {
  const tipos: string[] = [];
  for (const a of actions ?? []) {
    if (a.type === "ai_decide") {
      const opcoes = Array.isArray(a.config?.opcoes) ? (a.config.opcoes as Array<{ acao?: { type?: unknown } }>) : [];
      for (const opcao of opcoes) {
        const alvo = typeof opcao?.acao?.type === "string" ? opcao.acao.type : null;
        if (alvo) tipos.push(alvo);
      }
      continue;
    }
    tipos.push(a.type);
  }
  return tipos;
}

/** As ações da regra que fechariam laço com o gatilho dela (vazio = regra segura). */
export function acoesQueFechamLaco(
  triggerEvent: string | undefined,
  actions: readonly { type: string; config?: Record<string, unknown> }[] | undefined,
): string[] {
  if (!triggerEvent || !(GATILHOS_DO_TRIGGER_DE_LEAD as readonly string[]).includes(triggerEvent)) return [];
  const fecham: string[] = [];
  for (const acao of actions ?? []) {
    // A EXCEÇÃO #2769: a porta do ganho. Em `lead.won`, `create_or_move_lead`
    // declarada NA PRÓPRIA regra é a continuação do negócio para o funil de
    // pós-venda — ela cria um card NOVO e não escreve no negócio ganho, então o
    // laço que a #1528 vetou não existe aqui. É a ação que recusa `lead.won` no
    // MESMO funil, então o caminho "mover o recém-ganho" continua fechado.
    //
    // O alvo é ESTREITO de propósito: vale quando a regra declara a ação com o
    // funil visível no editor. `ai_decide` que ESCOLHE mover fica de fora — o
    // alvo mora dentro de `config.opcoes`, o modelo decide em tempo de execução
    // e a recusa da #1528 continua valendo para o par. Ampliar é medir antes.
    const ehContinuacaoDoGanho = acao.type === "create_or_move_lead" && triggerEvent === "lead.won";
    for (const tipo of tiposDeAcao([acao])) {
      if (!(ACOES_QUE_REGRAVAM_O_LEAD as readonly string[]).includes(tipo)) continue;
      if (ehContinuacaoDoGanho && tipo === "create_or_move_lead") continue;
      fecham.push(tipo);
    }
  }
  return fecham;
}

function recusarLacoDeLead(
  regra: { trigger_event?: string; actions?: readonly { type: string }[] },
  ctx: z.RefinementCtx,
): void {
  if (!acoesQueFechamLaco(regra.trigger_event, regra.actions).length) return;
  ctx.addIssue({ code: "custom", path: ["actions"], message: MENSAGEM_DO_LACO_DE_LEAD });
}

export const TRIGGER_EVENTS = Object.keys(ENTIDADE_ESPERADA_POR_GATILHO) as [
  GatilhoDeAutomacao,
  ...GatilhoDeAutomacao[],
];

/**
 * As condições de uma regra (#2727): o schema e o avaliador vivem juntos em
 * `lib/automation/conditions.ts`, para a tela, a porta da API e o motor lerem a
 * MESMA definição. Aqui só se reexporta — `conditionsSchema` aceita a lista
 * antiga (≡ `all`) e o grupo `{all|any}` do topo (o aninhamento é recusado na
 * porta; ver `conditionGroupSchema`).
 */
export { conditionSchema } from "@/lib/automation/conditions";

/**
 * O `config` de `assign_owner` (#2041): uma pessoa fixa, a forma de sempre, ou
 * um RODÍZIO, em que a posição na `fila` é a ordem e `pausado` tira a pessoa da
 * vez sem tirá-la da fila.
 *
 * `modo` é o discriminador e é OPCIONAL na forma fixa: as regras gravadas antes
 * do rodízio têm só `{ user_id }` e continuam válidas sem migração de dados. O
 * union discriminado (e não `z.union`) mantém o caminho do erro no campo
 * (`fila`, `user_id`), que é o que a tela usa para dizer o que corrigir.
 *
 * ─── As duas opções da #3514, e por que são OPT-IN ────────────────────────
 *
 * `contato` passa também a carteira do cliente (`contacts.carteira_user_id`) e
 * `conversas` passa as conversas ABERTAS do contato para o novo responsável —
 * a passagem SDR → Closer. As duas são `optional()` e o executor só as lê com
 * `=== true`: payload gravado antes desta mudança (sem as chaves) continua
 * válido e continua fazendo SÓ o que fazia. Nenhuma automação existente passa a
 * mover conversa porque o schema ganhou um campo.
 *
 * No rodízio elas não entram NESTA entrega, e não por acaso: a vez é decidida
 * dentro de `fn_automation_rodizio_atribuir`, que grava o dono do negócio na
 * MESMA transação em que registra a escolha. Passar cliente e conversas ali
 * seria uma SEGUNDA passada, com um destinatário que o banco escolheu e que a
 * ação só conhece depois do commit — desenho que merece issue própria em vez de
 * vir de carona nesta.
 */
export const configDoAtribuirSchema = z.discriminatedUnion("modo", [
  z.object({
    modo: z.literal("fixo").optional(),
    user_id: z.string().uuid(),
    /** #3514 — o cliente vai junto com o negócio? Desligado por padrão. */
    contato: z.boolean().optional(),
    /** #3514 — as conversas abertas do cliente vão junto? Desligado por padrão. */
    conversas: z.boolean().optional(),
  }),
  z.object({
    modo: z.literal("rodizio"),
    fila: z
      .array(z.object({ user_id: z.string().uuid(), pausado: z.boolean() }))
      .min(1)
      .max(50)
      .superRefine((fila, ctx) => {
        const vistos = new Set<string>();
        for (const [indice, pessoa] of fila.entries()) {
          if (vistos.has(pessoa.user_id)) {
            ctx.addIssue({
              code: "custom",
              path: [indice, "user_id"],
              message: "Cada pessoa entra uma vez só na fila do rodízio.",
            });
          }
          vistos.add(pessoa.user_id);
        }
      }),
  }),
]);

const ehRodizio = (acao: { type: string; config?: unknown }) =>
  acao.type === "assign_owner" && (acao.config as { modo?: unknown } | undefined)?.modo === "rodizio";

export const MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR =
  "Uma automação tem no máximo um rodízio de atendentes, como ação direta: a vez de cada pessoa é contada pela automação.";

/**
 * Uma regra tem no máximo UM rodízio, e só como ação direta. A vez de cada
 * pessoa é contada por regra (`fn_automation_rodizio_atribuir` lê a fila da
 * própria regra), então um segundo rodízio na mesma regra — ou um escondido
 * dentro de `ai_decide` — andaria pela fila do primeiro, calado.
 */
function umRodizioPorRegra(
  acoes: ReadonlyArray<{ type: string; config?: unknown }>,
  ctx: z.RefinementCtx,
): void {
  let rodizios = 0;
  for (const [indice, acao] of acoes.entries()) {
    if (acao.type === "ai_decide") {
      const opcoes = (acao.config as { opcoes?: Array<{ acao?: { type: string; config?: unknown } }> }).opcoes ?? [];
      for (const [k, opcao] of opcoes.entries()) {
        if (opcao.acao && ehRodizio(opcao.acao)) {
          ctx.addIssue({
            code: "custom",
            path: [indice, "config", "opcoes", k, "acao", "config", "modo"],
            message: MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR,
          });
        }
      }
      continue;
    }
    if (ehRodizio(acao) && ++rodizios > 1) {
      ctx.addIssue({ code: "custom", path: [indice, "config", "modo"], message: MENSAGEM_DO_RODIZIO_FORA_DO_LUGAR });
    }
  }
}

/**
 * As ações FIXAS do motor — a fonte única de "que ações existem, e com que
 * config".
 *
 * Vivem num array próprio, e não dentro do union, porque a `ai_decide` (#1970)
 * precisa do MESMO conjunto como domínio de escolha: a ação-alvo de cada opção
 * é uma destas, nunca outra `ai_decide` — sem anel, sem recursão. Um segundo
 * union escrito à mão envelheceria no primeiro ajuste de config (a mesma
 * cicatriz de lista duplicada que `ENTIDADE_ESPERADA_POR_GATILHO` existe para
 * matar): aqui, acrescentar ação é acrescentar UMA vez e as duas leem.
 *
 * Os objetos são os MESMOS de sempre, byte a byte — só mudou onde moram.
 */
const acoesFixas = [
  z.object({ type: z.literal("create_or_move_lead"), config: z.object({ pipeline_id: z.string().uuid(), stage_id: z.string().uuid() }) }),
  z.object({
    type: z.literal("send_whatsapp_message"),
    config: z.object({
      channel_session_id: z.string().uuid(),
      template: z.string().min(1).max(2000),
      /**
       * #2734 — MÍDIA OPCIONAL por URL. Quando presente, o `template` deixa de ser
       * a mensagem inteira e vira a LEGENDA da mídia (imagem, vídeo, áudio ou
       * documento). Opcional de propósito: a regra antiga (só texto) não tem a
       * chave e continua idêntica. O `nullish` deixa o editor gravar
       * `null`/ausente sem recusar a regra.
       *
       * O `type` (imagem × vídeo × áudio × documento) NÃO mora aqui: quem o
       * decide é o envio, a partir do MIME — a extensão da URL quando não há
       * MIME. Guardar uma cópia do tipo no config criaria uma segunda verdade
       * que envelhece se a URL mudar.
       */
      media_url: z.string().url().max(2000).nullish(),
    }),
  }),
  // #2726 — o e-mail como SAÍDA. O transporte não é configuração da regra: ele
  // já existe em `lib/email` (SMTP ou Resend, escolhido em Admin › E-mail), e
  // esta ação só diz QUEM recebe, o ASSUNTO e o CORPO. `destinatario` é o modo
  // (contato / responsável / pessoa da equipe / endereço fixo) e `email_fixo`
  // só existe para o último — por isso é opcional: exigir endereço num envio ao
  // contato recusaria na porta a regra que não precisa dele.
  //
  // #2642 (recorte do PR #2834) — o modo `membro_da_equipe` é o e-mail para uma
  // PESSOA da equipe, que antes morava no `notify_team`. Duas peças vieram
  // juntas: o vínculo do membro é conferido NO MOMENTO DO ENVIO (membro
  // removido da organização não recebe — o defeito do #2794) e o modelo ganha a
  // variável `{{resumo}}` com o resumo automático do negócio. O teto de envios
  // por organização desta ação vale para tudo isso sem mudar uma linha.
  z.object({
    type: z.literal("send_email"),
    config: z.object({
      destinatario: z.enum(["contato", "dono_do_lead", "membro_da_equipe", "fixo"]),
      // O editor guarda o campo como "" (input controlado) quando o modo não
      // é `fixo`; "" vira AUSÊNCIA aqui, na porta que o editor e a API
      // dividem, e não um e-mail inválido. Quem EXIGE o endereço é o
      // `superRefine` abaixo — só no modo `fixo`.
      email_fixo: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().email("E-mail inválido").max(320).optional(),
      ),
      // Mesma tolerância de `email_fixo`: o editor deixa o campo em "" quando o
      // modo não é `membro_da_equipe`. O endereço NÃO mora aqui — só o vínculo;
      // o e-mail sai do GoTrue da própria pessoa, no disparo.
      membro_id: z.preprocess(
        (v) => (v === "" ? undefined : v),
        z.string().uuid().optional(),
      ),
      // Assunto e corpo levam as MESMAS variáveis do WhatsApp: `{{nome}}`,
      // `{{primeiro_nome}}`, `{{lead.*}}` e o campo do funil (`{{destino}}`).
      // `{{resumo}}` é a variável desta ação (#2642): o resumo do negócio
      // montado no disparo, com a pontuação, o motivo e o que a passagem
      // combinou. Só é resolvida quando o modelo a referencia.
      assunto: z.string().min(1).max(200),
      corpo: z.string().min(1).max(5000),
      // Texto simples (padrão) ou HTML simples — negrito, links e quebras.
      formato: z.enum(["texto", "html"]).optional(),
    }).superRefine((config, ctx) => {
      // Sem isto, `fixo` sem endereço salvaria e só falharia na execução
      // (`missing_config` em send-email.ts) — a regra "salva" que nunca envia.
      if (config.destinatario === "fixo" && !config.email_fixo) {
        ctx.addIssue({
          code: "custom",
          path: ["email_fixo"],
          message: "Informe o endereço de e-mail que recebe os envios desta regra.",
        });
      }
      // Mesma régua do endereço fixo: sem a pessoa escolhida, a regra salvaria
      // e só falharia no disparo (`sem_membro` em send-email.ts).
      if (config.destinatario === "membro_da_equipe" && !config.membro_id) {
        ctx.addIssue({
          code: "custom",
          path: ["membro_id"],
          message: "Escolha a pessoa da equipe que recebe os envios desta regra.",
        });
      }
    }),
  }),
  z.object({
    type: z.literal("add_tag"),
    config: z.object({
      tags: z.array(z.string().min(1).max(60)).min(1).max(10),
      /**
       * #2498 — onde a etiqueta é GRAVADA: `card` (padrão, o comportamento de
       * sempre) ou `contato`. Opcional de propósito: as regras antigas não têm
       * a chave e continuam iguais; sem `.optional()` o zod descartaria o campo
       * no save e a tela mostraria uma escolha que não foi gravada.
       */
      destino: z.enum(["card", "contato"]).optional(),
    }),
  }),
  z.object({ type: z.literal("assign_owner"), config: configDoAtribuirSchema }),
  z.object({
    type: z.literal("send_ai_message"),
    config: z.object({
      /** Agente PUBLICADO que assina a mensagem. */
      agent_id: z.string().uuid(),
      channel_session_id: z.string().uuid(),
      /**
       * O que fazer com os dados do formulário. Mesmo teto do `prompt_hint` de
       * um passo de follow-up (1000): é instrução, não roteiro — quem escreve
       * mais que isso está tentando pôr o prompt do agente aqui dentro.
       */
      instruction: z.string().min(1).max(1000),
    }),
  }),
  z.object({
    type: z.literal("call_webhook"),
    config: z.object({
      url: z.string().url().max(2000),
      // Input do usuário (plaintext, write-only) — a rota troca por secret_enc.
      secret: z.string().max(200).optional(),
      // Ciphertext hex (round-trip do editor: GET devolve, PATCH preserva).
      secret_enc: z.string().max(4000).optional(),
      /**
       * Opt-in do RESPONSÁVEL (#1612, mesma régua proposta em #1528).
       *
       * Sem isto, o corpo não leva quem atende — nem `owner_user_id`, nem nome.
       * O compromisso é dado interno do estúdio: quem integra pediu horário,
       * status e tipo, não a identidade da equipe. Vazar por padrão seria
       * transformar um dado protegido em detalhe acidental de payload; só sai
       * quando quem monta a regra pede, na cara, na tela.
       */
      include_owner: z.boolean().optional(),
    }),
  }),
  // #2647 — a ação alcança o fluxo de ATENDIMENTO, e o caminho é o do produto
  // (iniciarFluxoDeAtendimento, `coletando`), não o enroll de follow-up.
  // `surface` é OPCIONAL de propósito: config sem ela é o follow-up de sempre,
  // então toda regra já gravada continua apontando para o MESMO fluxo.
  z.object({
    type: z.literal("start_message_flow"),
    config: z.object({
      flow_pointer_id: z.string().uuid(),
      surface: z.enum(["followup", "atendimento"]).optional(),
    }),
  }),
  // #1540 — a ação que NUNCA fala com o cliente: grava `crm_tasks` e avisa o
  // responsável. Advocacia, saúde e serviços regulados precisam do lembrete e
  // não da mensagem; é a diferença entre o sistema lembrar a equipe e o
  // sistema falar. Mesmos campos do nó `internal_task` dos fluxos.
  z.object({
    type: z.literal("create_task"),
    config: z.object({
      /** Título com `{{lead.title}}` e `{{contact.name}}`. */
      titulo: z.string().min(1).max(200),
      vence_em_dias: z.number().int().min(0).max(365),
      atribuir_a: z.union([
        z.literal("dono_do_lead"),
        z.object({ usuario_id: z.string().uuid() }),
      ]),
      prioridade: z.enum(["low", "medium", "high", "urgent"]),
    }),
  }),
  // #1752 — a SEQUÊNCIA: aplicar um plano de tarefas (`task_plans[]` em
  // `organizations.settings.task_plans`) ao negócio, criando as N tarefas de
  // uma vez e na ordem. Idempotente pela marca `task_plan_applied`: repetir a
  // regra não duplica tarefa. `plano_id` é o id do JSON, não uuid — as
  // tabelas da proposta (`task_plans` + `task_plan_steps`) ficam para a
  // migration que esta entrega não traz.
  z.object({
    type: z.literal("apply_task_plan"),
    config: z.object({
      plano_id: z.string().trim().min(1).max(64),
    }),
  }),
  // #3727 — a PONTE para o gatilho de data do funil (#989): grava a data do
  // atendimento num campo de DATA do negócio, e é a regra "Quando faltarem N
  // dias para uma data do funil" (com N negativo) que manda a mensagem N dias
  // depois. Dois campos e nada mais: o `pipeline_id` é o funil dono do campo (é
  // ele que a varredura consulta) e o `campo` é a CHAVE em
  // `pipelines.settings.fields`, nunca o rótulo — o mesmo par que o
  // `trigger_config` do gatilho de data guarda. Quem espera NÃO é esta ação:
  // ela grava e sai na hora do comparecimento, e por isso não segura a vaga de
  // "um follow-up vivo por contato".
  z.object({
    type: z.literal("set_lead_date_field"),
    config: z.object({
      pipeline_id: z.string().uuid(),
      campo: z.string().trim().min(1).max(80),
    }),
  }),
  // #2642 — a ação que avisa a EQUIPE na virada para ganho. O recorte do
  // mantenedor no PR #2834 deixou UM caminho: o WhatsApp para o número que o
  // ADMIN já registrou em Avisos. Por isso a configuração é só isto — não tem
  // número, endereço, pessoa nem texto: colar destino aqui seria a mesma porta
  // de spam que a disciplina da #1347 fechou, e "quem recebe" deixou de ser
  // escolha (o destino é o da empresa).
  //
  // O e-mail para uma pessoa da equipe não mora mais nesta ação: ele é o
  // destinatário `membro_da_equipe` do `send_email`, com o teto de envios por
  // organização valendo e a variável `{{resumo}}` disponível no modelo.
  z.object({
    type: z.literal("notify_team"),
    // `strictObject` SÓ aqui, entre as ações: é o único destino que a regra não
    // pode carregar. As irmãs aceitam campos extras por tolerância a round-trip
    // do editor; esta ação não tem o que tolerar — qualquer `telefone`/`email`
    // colado na regra é a porta de spam que a disciplina da #1347 fechou, e o
    // destinatário é sempre o que o ADMIN registrou (ver notify-team.ts).
    //
    // `canal` é `literal` e não `enum` de propósito: `z.enum(["whatsapp",
    // "email"])` era o ramo de e-mail que o recorte tirou, e o literal faz a
    // regra que ainda peça e-mail morrer aqui, na porta, em vez de sair pelo
    // WhatsApp como se o pedido tivesse sido respeitado.
    config: z.strictObject({
      canal: z.literal("whatsapp"),
    }),
  }),
] as const;

/**
 * O domínio de escolha da `ai_decide`: UMA ação-alvo por opção, e a ação tem
 * que ser uma das fixas. Exportado porque o teste de schema confere que este
 * union e o de `actionSchema` continuam sendo o mesmo conjunto.
 */
export const acaoAlvoSchema = z.discriminatedUnion("type", [...acoesFixas]);

/**
 * Uma opção do `ai_decide` (#1970) — o conjunto FINITO que a IA pode escolher.
 *
 * `id` é o que a IA devolve e `acao` é o que aquele id dispara; `rotulo` é o
 * que quem lê o run vê. Três campos porque dois não fecham: id sem ação não
 * executa nada, ação sem id não é escolhível, e nenhum dos dois diz em
 * português o que aquela opção significa.
 */
export const opcaoDoAiDecideSchema = z.object({
  id: z.string().min(1).max(60),
  rotulo: z.string().min(1).max(120),
  acao: acaoAlvoSchema,
});

export const aiDecideSchema = z.object({
  type: z.literal("ai_decide"),
  config: z.object({
    /**
     * O REGISTRO EXPLÍCITO do custo de token (#1970).
     *
     * `z.literal(true)`: a regra só existe se quem montou declarou, na cara,
     * que esta ação gasta token — não dá para ligar IA sem escrever isto, nem
     * por default, nem por herança de outra ação. Ausente, o schema recusa a
     * regra na porta e a ação recusa de novo na execução (defesa em
     * profundidade): gasto tácito é o defeito que o registro de pontos de IA do
     * repo existe para impedir.
     */
    custo_de_token: z.literal(true),
    /** A instrução de quem montou a regra — o que a IA pondera ao escolher. */
    instrucao: z.string().min(1).max(1000),
    /**
     * O conjunto FINITO de opções: 2 a 6, cada uma com id único. Um id
     * repetido faria a IA "escolher" e o executor acertar a PRIMEIRA opção
     * com aquele id — a escolha registrada não seria a executada.
     */
    opcoes: z
      .array(opcaoDoAiDecideSchema)
      .min(2)
      .max(6)
      .superRefine((opcoes, ctx) => {
        const vistos = new Set<string>();
        for (const [indice, opcao] of opcoes.entries()) {
          if (vistos.has(opcao.id)) {
            ctx.addIssue({
              code: "custom",
              path: [indice, "id"],
              message: "Cada opção precisa de um id único: é o id que a IA escolhe e o que a execução acerta.",
            });
          }
          vistos.add(opcao.id);
        }
      }),
  }),
});

export const actionSchema = z.discriminatedUnion("type", [...acoesFixas, aiDecideSchema]);

export const createWebhookSourceSchema = z.object({
  name: z.string().min(1).max(120),
  default_pipeline_id: z.string().uuid(),
  default_stage_id: z.string().uuid(),
  redirect_to: z.string().url().max(2000).nullish(),
  field_map: z
    .object({
      name: z.array(z.string()).optional(),
      phone: z.array(z.string()).optional(),
      email: z.array(z.string()).optional(),
    })
    .optional(),
  form_fields: webhookFormFieldsSchema.optional(),
  secret: z.string().min(16).max(200).nullish(),
});
export const updateWebhookSourceSchema = createWebhookSourceSchema.partial().extend({
  name: z.string().trim().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  authorize_ai_on_capture: z.boolean().optional(),
  /**
   * A opção do #2316: quando o `external_id` já existe, ATUALIZAR o card da
   * MESMA fonte em vez de descartar o envio como reenvio.
   *
   * Só entra no PATCH — criar fonte com ela ligada não existe, porque o
   * segredo que a habilita é da mesma tela e vem depois. Nasce DESLIGADA por
   * DEFAULT na coluna (migration 0683): quem nunca mexer aqui segue exatamente
   * como antes do #2316, sem a integração poder reescrever edição manual.
   */
  update_existing_lead_on_capture: z.boolean().optional(),
  /**
   * A opção do #3101: quando o envio NÃO traz `external_id` e o contato casado
   * já tem card ABERTO no mesmo funil, ATUALIZAR esse card (campos e etapa) em
   * vez de abrir outro.
   *
   * Só entra no PATCH, como a opção irmã: nasce DESLIGADA por DEFAULT na coluna
   * (migration 0722), e quem nunca mexer aqui segue exatamente como antes —
   * cada envio vira um card novo.
   *
   * Como `update_existing_lead_on_capture`, só liga em fonte com assinatura
   * configurada — mesma régua da opção irmã (`opcaoSemAssinatura`, conferida
   * na rota do PATCH): reescrever um card que já existe é integração entre
   * sistemas.
   */
  reuse_open_lead_on_capture: z.boolean().optional(),
});

export const createAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger_event: z.enum(TRIGGER_EVENTS),
    conditions: conditionsSchema.default([]),
    actions: z.array(actionSchema).min(1).max(10).superRefine(umRodizioPorRegra),
    /**
     * O que o gatilho precisa saber além do nome dele (#989).
     *
     * Só o gatilho de DATA do funil usa: o campo de data é de UM funil
     * (`pipelines.settings.fields`), então a regra guarda funil + campo + N. Os
     * outros gatilhos nascem de um evento que já traz tudo, e seguem com o
     * objeto vazio.
     */
    trigger_config: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine(exigirConfigDoGatilhoDeData)
  .superRefine(exigirConfigDosGatilhosDeTempo)
  .superRefine(exigirIdDaFonteWebhook)
  .superRefine(recusarLimitePorContatoTorto)
  .superRefine(recusarAntecedenciaTorta)
  .superRefine(recusarLacoDeLead);

/**
 * "Dias de antecedência" do aniversário (#3726) é um inteiro de 0 a 365.
 *
 * A varredura lê a chave com `configDoAniversario`, que devolve `null` para
 * qualquer coisa que não seja inteiro na faixa — e uma regra dessas seria salva
 * e nunca dispararia, com a tela dizendo que foi salva. Recusar na porta é o
 * único desfecho honesto, como nas demais chaves do gatilho.
 *
 * Ausente passa: é o `{}` de toda regra criada antes desta feature, que
 * continua valendo com 0 (no dia).
 */
function recusarAntecedenciaTorta(
  regra: { trigger_config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const config = regra.trigger_config;
  if (!config || !("dias_antecedencia" in config)) return;
  if (configDoAniversario(config)) return;
  ctx.addIssue({
    code: "custom",
    path: ["trigger_config", "dias_antecedencia"],
    message: "Escolha entre 0 e 365 dias de antecedência (0 = no dia do aniversário).",
  });
}

function exigirIdDaFonteWebhook(
  regra: { trigger_config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const sourceId = regra.trigger_config?.webhook_source_id;
  if (sourceId === undefined || sourceId === null) return;
  if (typeof sourceId !== "string" || !z.string().uuid().safeParse(sourceId).success) {
    ctx.addIssue({
      code: "custom",
      path: ["trigger_config", "webhook_source_id"],
      message: "Escolha uma fonte de formulário válida.",
    });
  }
}

/**
 * "No máximo uma vez por contato" (#2974) é LIGADO/DESLIGADO — booleano.
 *
 * O motor lê a chave com `=== true` (`regraRodaUmaVezPorContato`), então um
 * `"sim"` ou um `1` gravado por outra porta seria silenciosamente DESLIGADO: a
 * tela diria que a regra roda uma vez por contato e ela rodaria sempre. Recusar
 * na porta é o único desfecho honesto, como nas demais chaves do gatilho.
 *
 * Ausente (ou `null`, que é o mesmo "não configurado") passa: é o comportamento
 * de antes desta feature.
 */
function recusarLimitePorContatoTorto(
  regra: { trigger_config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  const valor = regra.trigger_config?.uma_vez_por_contato;
  if (valor === undefined || valor === null || typeof valor === "boolean") return;
  ctx.addIssue({
    code: "custom",
    path: ["trigger_config", "uma_vez_por_contato"],
    message: "A opção “uma vez por contato” só aceita ligado ou desligado.",
  });
}

/**
 * O gatilho de data sem a configuração dele é uma regra que NUNCA dispara — a
 * varredura não sabe onde olhar. Recusar na porta é o único desfecho honesto:
 * aceitar calado produziria a tela dizendo "salvo" e o operador esperando.
 */
/**
 * Os gatilhos por TEMPO (#1540) sem a configuração deles: mesma recusa do
 * gatilho de data, pela mesma razão — a varredura precisa saber N dias (e, no
 * silêncio, de QUEM é o silêncio). Aceitar calado produziria regra salva que
 * nunca dispara.
 *
 * Só roda para os dois gatilhos novos; os demais seguem com `{}` e voltam
 * `true` sem custo.
 */
function exigirConfigDosGatilhosDeTempo(
  regra: { trigger_event: string; trigger_config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  if (regra.trigger_event === GATILHO_SILENCIO) {
    if (configDoSilencio(regra.trigger_config)) return;
    ctx.addIssue({
      code: "custom",
      path: ["trigger_config"],
      message: "Escolha há quantos dias de silêncio e de quem é o silêncio (equipe, cliente ou qualquer).",
    });
    return;
  }
  if (regra.trigger_event === GATILHO_ETAPA_PARADA) {
    if (configDaEtapaParada(regra.trigger_config)) return;
    ctx.addIssue({
      code: "custom",
      path: ["trigger_config"],
      message: "Escolha há quantos dias o negócio está parado na mesma etapa.",
    });
  }
}

function exigirConfigDoGatilhoDeData(
  regra: { trigger_event: string; trigger_config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
): void {
  if (regra.trigger_event !== GATILHO_DE_DATA_DO_FUNIL) return;
  if (configDoGatilhoDeData(regra.trigger_config)) return;
  ctx.addIssue({
    code: "custom",
    path: ["trigger_config"],
    message: "Escolha o funil, o campo de data e em quantos dias avisar.",
  });
}

export const updateAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    trigger_event: z.enum(TRIGGER_EVENTS).optional(),
    conditions: conditionsSchema.optional(),
    actions: z.array(actionSchema).min(1).max(10).superRefine(umRodizioPorRegra).optional(),
    trigger_config: z.record(z.string(), z.unknown()).optional(),
    is_active: z.boolean().optional(),
  })
  .superRefine((patch, ctx) => {
    // O PATCH que troca o gatilho PARA o de data, sem mandar a configuração,
    // deixaria a regra existindo e jamais disparando — mesmo defeito da criação,
    // pela porta do lado.
    if (patch.trigger_event !== GATILHO_DE_DATA_DO_FUNIL) return;
    if (configDoGatilhoDeData(patch.trigger_config)) return;
    ctx.addIssue({
      code: "custom",
      path: ["trigger_config"],
      message: "Escolha o funil, o campo de data e em quantos dias avisar.",
    });
  })
  .superRefine((patch, ctx) => {
    // O PATCH que troca o gatilho PARA um dos gatilhos por tempo, sem mandar a
    // configuração, produz o mesmo calado da criação (#1540): regra salva que
    // a varredura não sabe avaliar.
    exigirConfigDosGatilhosDeTempo(patch as { trigger_event: string; trigger_config?: Record<string, unknown> }, ctx);
  })
  .superRefine(exigirIdDaFonteWebhook)
  .superRefine(recusarLimitePorContatoTorto)
  .superRefine(recusarAntecedenciaTorta)
  // Só vê o laço quando o PATCH traz gatilho E ações; o PATCH parcial é
  // conferido contra a regra gravada na rota.
  .superRefine(recusarLacoDeLead);

export type CreateWebhookSourceInput = z.infer<typeof createWebhookSourceSchema>;
export type UpdateWebhookSourceInput = z.infer<typeof updateWebhookSourceSchema>;
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
