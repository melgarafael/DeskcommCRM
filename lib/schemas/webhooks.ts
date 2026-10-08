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
  return tiposDeAcao(actions).filter((t) => (ACOES_QUE_REGRAVAM_O_LEAD as readonly string[]).includes(t));
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

export const conditionSchema = z.object({
  field: z.string().min(1).max(200),
  op: z.enum(["eq", "neq", "contains"]),
  value: z.string().max(500),
});

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
  z.object({ type: z.literal("send_whatsapp_message"), config: z.object({ channel_session_id: z.string().uuid(), template: z.string().min(1).max(2000) }) }),
  z.object({ type: z.literal("add_tag"), config: z.object({ tags: z.array(z.string().min(1).max(60)).min(1).max(10) }) }),
  z.object({ type: z.literal("assign_owner"), config: z.object({ user_id: z.string().uuid() }) }),
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
  z.object({
    type: z.literal("start_message_flow"),
    config: z.object({ flow_pointer_id: z.string().uuid() }),
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
});

export const createAutomationRuleSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger_event: z.enum(TRIGGER_EVENTS),
    conditions: z.array(conditionSchema).max(10).default([]),
    actions: z.array(actionSchema).min(1).max(10),
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
  .superRefine(recusarLacoDeLead);

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
    conditions: z.array(conditionSchema).max(10).optional(),
    actions: z.array(actionSchema).min(1).max(10).optional(),
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
  // Só vê o laço quando o PATCH traz gatilho E ações; o PATCH parcial é
  // conferido contra a regra gravada na rota.
  .superRefine(recusarLacoDeLead);

export type CreateWebhookSourceInput = z.infer<typeof createWebhookSourceSchema>;
export type UpdateWebhookSourceInput = z.infer<typeof updateWebhookSourceSchema>;
export type CreateAutomationRuleInput = z.infer<typeof createAutomationRuleSchema>;
export type UpdateAutomationRuleInput = z.infer<typeof updateAutomationRuleSchema>;
