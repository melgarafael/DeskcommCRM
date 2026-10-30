import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * Motor de regras: consome eventos-gatilho do event_log e executa as
 * automation_rules ativas do tenant. Registrado no registry via engine.handler.
 *
 * Anti-loop: eventos com metadata.caused_by_rule OU metadata.request_id
 * prefixado "rule:" não reprocessam (profundidade 1 no v1 — cadeia
 * regra→regra fica pra v2/Task 9, que estampa esse metadata nos eventos que
 * uma ação do motor emite).
 *
 * entity_kind guard: o trigger legado `fn_emit_event_on_lead_change` emite
 * lead.created/lead.stage_changed com entity_kind='lead' (derivado por
 * split_part do event_type), enquanto os handlers desta feature emitem com
 * entity_kind='crm_lead'. Sem este filtro o motor rodaria a regra 2x por
 * mudança de lead (uma vez por linha de event_log duplicada).
 *
 * A exceção de #1528: os quatro gatilhos de encerramento/reabertura/atribuição
 * SÓ existem como linha do trigger, portanto SÓ existem com entity_kind='lead'.
 * Para eles `'lead'` vale como `'crm_lead'` (`entidadeDoEvento`) — sem isso a
 * regra nunca roda, ou roda sem o objeto `lead` no contexto. O `lead.stage_changed`
 * legado continua recusado: é o mesmo fato que o moveLeadHandler já emite com
 * `crm_lead`, e aceitá-lo entregaria o webhook duas vezes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { evaluateConditions, type Conditions } from "@/lib/automation/conditions";
import { hidratarCamposDoFunil } from "@/lib/automation/campos-do-render";
import { getAction } from "@/lib/automation/actions";
import { falhaDeExecucaoParaRecibo, resultadosParaRecibo } from "@/lib/automation/resultado-para-recibo";
import type { ActionResultDetail } from "@/lib/automation/types";
import { audit } from "@/lib/audit";
import { regraDoEvento } from "@/lib/automation/gatilho-de-data-do-funil";
import {
  acoesQueFechamLaco,
  ENTIDADE_ESPERADA_POR_GATILHO,
  GATILHOS_DO_TRIGGER_DE_LEAD,
} from "@/lib/schemas/webhooks";
import { logger } from "@/lib/logger";
import { ocultarProvaMetaNaResposta } from "@/lib/leads/prova-meta-lead-submitted";

export const AUTOMATION_CONSUMER_KEY = "automation-rules";

const EXPECTED_ENTITY_KIND: Record<string, string> = ENTIDADE_ESPERADA_POR_GATILHO;

/** Os gatilhos que o trigger do banco grava com `entity_kind='lead'` (#1528). */
const GATILHOS_DO_TRIGGER = new Set<string>(GATILHOS_DO_TRIGGER_DE_LEAD);

/**
 * A entidade que a REGRA enxerga — nem sempre a que está gravada na linha.
 *
 * Para os quatro gatilhos do trigger do banco, `'lead'` (o que o `fn_log_event`
 * deriva do `split_part` do event_type) é o MESMO fato que `'crm_lead'`
 * (o que os handlers da feature emitem, e o que `buildContext` sabe hidratar).
 * Só para eles: em qualquer outro evento, o `entity_kind` gravado segue
 * mandando, que é a anti-duplicação de sempre.
 */
function entidadeDoEvento(row: Pick<EventRow, "event_type" | "entity_kind">): string {
  if (row.entity_kind === "lead" && GATILHOS_DO_TRIGGER.has(row.event_type)) return "crm_lead";
  return row.entity_kind;
}

interface RuleRow {
  id: string;
  name: string;
  conditions: Conditions;
  actions: Array<{ type: string; config?: Record<string, unknown> }>;
  trigger_config?: Record<string, unknown> | null;
}

/** Hidrata o contexto avaliado pelas condições/ações a partir do entity do evento. */
export async function buildContext(admin: SupabaseClient, row: EventRow): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = { event: row.payload };
  // Admin client bypassa RLS — todo lookup filtra organization_id do evento
  // (doutrina multi-tenant; um FK cross-org corrompido nunca vaza pro contexto).
  const org = row.organization_id;
  // `lead` ≡ `crm_lead` para os gatilhos do trigger do banco (#1528): sem
  // isto, `lead.won`/`lead.lost`/`lead.reopened`/`lead.assigned` chegavam com a
  // entidade que o `fn_log_event` deriva e a regra rodava SEM o objeto `lead`
  // — um webhook de ganho sem o negócio dentro, que é pior que webhook nenhum.
  const entidade = entidadeDoEvento(row);
  if (entidade === "crm_lead") {
    // O id vem da linha (o `fn_log_event` grava `entity_id` = payload.lead_id);
    // o payload é o fallback para fixtures e para o Reenviar.
    const payloadLeadId = typeof row.payload?.lead_id === "string" ? row.payload.lead_id : null;
    const leadId = row.entity_id ?? payloadLeadId;
    const { data: lead } = leadId
      ? await admin
          .from("crm_leads")
          .select("*")
          .eq("id", leadId)
          .eq("organization_id", org)
          .maybeSingle()
      : { data: null };
    if (lead) {
      context.lead = ocultarProvaMetaNaResposta(lead as Record<string, unknown>);
      if (lead.contact_id) {
        const { data: contact } = await admin
          .from("contacts")
          .select("*")
          .eq("id", lead.contact_id)
          .eq("organization_id", org)
          .maybeSingle();
        if (contact) context.contact = contact;
      }
      // O rótulo das opções (#3605): o card guarda `paris-franca`, e é a
      // DEFINIÇÃO do funil que diz o que o cliente deve ler. Vai no contexto
      // porque quem renderiza (`lib/automation/template.ts`) é função pura — e
      // porque o mesmo contexto serve às condições e às ações.
      await hidratarCamposDoFunil(context, admin, org);
    }
  } else if (row.entity_kind === "contact" && row.entity_id) {
    const { data: contact } = await admin
      .from("contacts")
      .select("*")
      .eq("id", row.entity_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (contact) context.contact = contact;
  } else if (row.entity_kind === "calendar_appointment" && row.entity_id) {
    const { data: appointment } = await admin
      .from("calendar_appointments")
      .select("*")
      .eq("id", row.entity_id)
      .eq("organization_id", org)
      .maybeSingle();
    if (appointment) {
      context.appointment = appointment;
      // O contato sai do COMPROMISSO, não do payload: quem escreve a regra vai
      // querer `contact.name` no texto da mensagem, e a linha do banco é a
      // versão de agora — o payload é a de quando o evento nasceu.
      if (appointment.contact_id) {
        const { data: contact } = await admin
          .from("contacts")
          .select("*")
          .eq("id", appointment.contact_id)
          .eq("organization_id", org)
          .maybeSingle();
        if (contact) context.contact = contact;
      }
    }
  } else if (row.entity_kind === "message" && row.entity_id) {
    const contactId = row.payload.contact_id as string | undefined;
    if (contactId) {
      const { data: contact } = await admin
        .from("contacts")
        .select("*")
        .eq("id", contactId)
        .eq("organization_id", org)
        .maybeSingle();
      if (contact) context.contact = contact;
    }
  }
  return context;
}

/**
 * Grava a linha do adiamento — a única evidência de que a regra casou e está
 * esperando.
 *
 * Um run por adiamento, e não um por tique do drain: o evento só volta na hora
 * marcada por `retry_at`, então não há repetição a cada minuto. Se a janela
 * seguir fechada quando ele voltar, sai outra linha — e aí a repetição É a
 * informação (a automação está presa há três dias).
 *
 * Fire-and-forget quanto a erro: perder o registro não pode impedir o
 * adiamento, que é o que protege o número.
 */
async function registrarAdiamento(
  admin: SupabaseClient,
  row: EventRow,
  rule: RuleRow,
  actionType: string,
  retryAt: string,
): Promise<void> {
  const { error } = await admin.from("automation_rule_runs").insert({
    organization_id: row.organization_id,
    rule_id: rule.id,
    event_id: row.id,
    status: "adiado",
    actions_result: [
      {
        type: actionType,
        status: "postponed",
        detail: {
          reason: "fora_da_janela_de_envio",
          retry_at: retryAt,
          explicacao:
            "A regra casou e está esperando a janela de envio do número reabrir — nada foi tentado ainda.",
        },
      },
    ],
  });
  if (error) {
    logger.error("[automation.engine] não foi possível registrar o adiamento", {
      rule_id: rule.id,
      organization_id: row.organization_id,
      error: error.message,
    });
  }
}

/** O contato do evento, quando ele existe — direto ou via conversa. */
async function contatoDoEvento(
  admin: SupabaseClient,
  row: EventRow,
): Promise<string | null> {
  const direto = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
  if (direto) return direto;
  const conversa =
    typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
  if (!conversa) return null;
  const { data } = await admin
    .from("conversations")
    .select("contact_id")
    .eq("id", conversa)
    .eq("organization_id", row.organization_id)
    .maybeSingle();
  return (data as { contact_id?: string } | null)?.contact_id ?? null;
}

/**
 * A REGRA PEDIU "NO MÁXIMO UMA VEZ POR CONTATO"? (#2974)
 *
 * Chave do `trigger_config`, booleana (o schema da API recusa o resto). Ausente
 * ou `false` = o comportamento de sempre — a regra roda em todo evento que casa
 * —, e é isso que faz esta entrega não mexer com quem não ligou a opção.
 */
export function regraRodaUmaVezPorContato(rule: Pick<RuleRow, "trigger_config">): boolean {
  return rule.trigger_config?.uma_vez_por_contato === true;
}

/**
 * O contato hidratado no CONTEXTO — o do lead do evento, do compromisso, do
 * aniversário.
 *
 * É o segundo caminho, e existe porque `contatoDoEvento` só olha o payload
 * (`contact_id`/`conversation_id`): um `lead.created` traz o contato PELO LEAD,
 * e sem este fallback a opção seria silenciosamente inútil justamente no
 * gatilho de contato novo, que é o caso da issue.
 */
function contatoDoContexto(context: Record<string, unknown>): string | null {
  const id = (context.contact as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : null;
}

/**
 * O ESTADO PERSISTIDO: esta regra já tem execução registrada para este contato?
 *
 * A pergunta vai ao BANCO, nunca a uma memória do processo — é o que faz a
 * decisão sobreviver a reinício do worker (e a decisão de um evento alcançar o
 * próximo, que chega numa execução nova). Qualquer linha da regra com este
 * `contact_id` conta: a opção é "no máximo UMA VEZ", não "até conseguir" — o
 * modo por intervalo (horas/dias) é a outra fatia da issue, e é lá que "tentar
 * de novo depois" mora.
 *
 * FAIL-OPEN na leitura: se a consulta falhar, a regra roda como sempre rodou.
 * Negar por erro de leitura esconderia automação legítima sem deixar rastro do
 * porquê; o erro sai no log.
 *
 * Ela é o CAMINHO RÁPIDO, não o árbitro da corrida: o caso comum é o contato que
 * JÁ executou, e aí a regra morre aqui, sem tocar no banco de novo. Quem decide a
 * corrida entre dois drenos simultâneos é a RESERVA
 * (`reservarExecucaoPorContato`), tomada depois das condições e antes de
 * executar — consultar e depois executar são dois passos, e entre eles cabia
 * outro dreno.
 */
async function regraJaRodouParaOCntato(
  admin: SupabaseClient,
  organizationId: string,
  ruleId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("automation_rule_runs")
    // `limit(1)` + lista, NUNCA `maybeSingle()`: um contato pode ter VÁRIAS
    // linhas desta regra (cada mensagem dele que casou deixa uma, inclusive a
    // da própria decisão de bloqueio), e o `maybeSingle` do PostgREST responde
    // ERRO quando há mais de uma — erro que, no fail-open, voltaria a rodar a
    // regra que deveria estar bloqueada.
    .select("id")
    .eq("organization_id", organizationId)
    .eq("rule_id", ruleId)
    .eq("contact_id", contactId)
    .limit(1);
  if (error) {
    logger.warn(
      "[automation.engine] não foi possível conferir o limite por contato — a regra segue (fail-open)",
      { rule_id: ruleId, organization_id: organizationId, error: error.message },
    );
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * A RESERVA NO BANCO — a chave (regra, contato) tomada ANTES de executar (#2974).
 *
 * A leitura acima é o CAMINHO RÁPIDO, e não o árbitro: ela responde "esta regra
 * já rodou para este contato?" sobre o estado que EXISTE, e o caso comum (o
 * contato que já executou) morre ali, sem chegar aqui. O que ela não faz é
 * RESERVAR: consultar e depois executar são dois passos, e entre eles cabe
 * outro dreno. O laço do worker e o cron drenam o `event_log` em paralelo e,
 * numa instalação sem worker, o dreno roda dentro da própria requisição de
 * captação — dois `lead.created` do MESMO contato (o "reenviou porque demorou"
 * da issue) chegam aos dois drenos ao mesmo tempo, os dois leem "nunca rodou",
 * os dois executam, e a sequência sai duas vezes.
 *
 * Aqui a decisão é ATÔMICA: `insert ... on conflict do nothing` sobre a chave
 * única `(organization_id, rule_id, contact_id)` — que é o que
 * `.upsert(…, { ignoreDuplicates: true })` manda no fio (`on_conflict=` +
 * `resolution=ignore-duplicates`). Quem consegue o insert
 * executa; quem não consegue não executa e só registra o bloqueio. Não há
 * janela entre decidir e executar, porque a decisão É a escrita.
 *
 * FAIL-OPEN no erro que NÃO é a chave tomada (banco fora do ar, por exemplo):
 * negar por erro de escrita esconderia automação legítima sem deixar rastro do
 * porquê — a mesma doutrina da leitura acima, e o log diz que foi isso. A chave
 * já tomada NÃO é erro: com `ignoreDuplicates` o PostgREST responde 201 com
 * lista vazia, e é por aí que "não reservei" chega.
 */
async function reservarExecucaoPorContato(
  admin: SupabaseClient,
  row: EventRow,
  rule: RuleRow,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("automation_rule_contact_claims")
    .upsert(
      {
        organization_id: row.organization_id,
        rule_id: rule.id,
        contact_id: contactId,
        event_id: row.id,
      },
      { onConflict: "organization_id,rule_id,contact_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle();
  if (error) {
    logger.warn(
      "[automation.engine] não foi possível reservar a execução única do contato — a regra segue (fail-open)",
      { rule_id: rule.id, organization_id: row.organization_id, error: error.message },
    );
    return true;
  }
  // Lista vazia = a chave já era de outro dreno (foi `on conflict do nothing`),
  // e o `maybeSingle` traduz isso em `data` nulo. Ninguém executa duas vezes.
  return data !== null;
}

/**
 * A DECISÃO DE NÃO RODAR, gravada com a razão (#2974).
 *
 * Mesmo desenho de `registrarAdiamento`: um run que registra o que aconteceu em
 * vez de o evento sumir sem deixar linha. Aqui nada foi tentado e nada vai
 * chegar — por isso as ações saem como `skipped` com `error:
 * uma_vez_por_contato`, e o agregador (`statusDoRun`, o MESMO do run normal)
 * fecha o estado como `failed`: a doutrina do motor é que `skipped` conta junto
 * de `failed`, porque as duas significam "não saiu, e a fila não resolve
 * sozinha". Sem esta linha, "não apareceu nada na Atividade" e "a regra não
 * rodou" voltariam a ser a mesma tela — o defeito que originou o `adiado`
 * (migration 0175).
 *
 * Não mexe em `run_count`/`last_run_at`: a regra NÃO rodou, e o contador
 * informativo não pode dizer que sim.
 */
async function registrarBloqueioPorLimite(
  admin: SupabaseClient,
  row: EventRow,
  rule: RuleRow,
  contactId: string,
): Promise<void> {
  const results: ActionResultDetail[] = (rule.actions ?? []).map((action) => ({
    type: action.type,
    status: "skipped" as const,
    error: "uma_vez_por_contato",
  }));
  const { error } = await admin.from("automation_rule_runs").insert({
    organization_id: row.organization_id,
    rule_id: rule.id,
    event_id: row.id,
    contact_id: contactId,
    status: statusDoRun(results),
    actions_result: resultadosParaRecibo(results),
  });
  if (error) {
    logger.error("[automation.engine] não foi possível registrar o bloqueio por contato", {
      rule_id: rule.id,
      organization_id: row.organization_id,
      error: error.message,
    });
  }
}

/**
 * O estado do run a partir do desfecho de cada ação.
 *
 * Esta função é a única fonte da regra: o run normal e o registro da decisão de
 * bloqueio por contato passam os dois por ela. A doutrina inteira está no
 * comentário do call site, em `runAutomationForEvent`.
 */
export function statusDoRun(
  results: readonly ActionResultDetail[],
): "success" | "partial" | "failed" | "adiado" {
  const naoEnviadas = results.filter((r) => r.status === "failed" || r.status === "skipped").length;
  const adiados = results.filter((r) => r.status === "postponed").length;
  return naoEnviadas > 0
    ? naoEnviadas === results.length
      ? "failed"
      : "partial"
    : adiados > 0
      ? "adiado"
      : "success";
}

/**
 * Verdadeiro quando o evento é de um contato pessoal (spec 21, caminho 8).
 *
 * Fail-open de propósito: sem conseguir resolver o contato, a regra segue o
 * caminho de sempre — calar por falta de leitura esconderia automação legítima
 * sem deixar rastro do porquê.
 */
async function eventoEhDeContatoPessoal(
  admin: SupabaseClient,
  row: EventRow,
): Promise<boolean> {
  try {
    const contatoId = await contatoDoEvento(admin, row);
    if (!contatoId) return false;
    const { data } = await admin
      .from("contacts")
      .select("is_personal")
      .eq("id", contatoId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    return (data as { is_personal?: boolean } | null)?.is_personal === true;
  } catch {
    return false;
  }
}

export async function runAutomationForEvent(
  admin: SupabaseClient,
  row: EventRow,
): Promise<HandlerResult> {
  const serviceBoundaries = new Map<string, Promise<ServiceBoundary>>();
  const requestId = row.metadata?.request_id;
  const causedByRule =
    Boolean(row.metadata?.caused_by_rule) || (typeof requestId === "string" && requestId.startsWith("rule:"));
  if (causedByRule) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "caused_by_rule" };
  }

  const expectedKind = EXPECTED_ENTITY_KIND[row.event_type];
  if (expectedKind && entidadeDoEvento(row) !== expectedKind) {

    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "entity_kind_mismatch" };
  }

  // Contato pessoal (spec 21, caminho 8): evento de pessoal não casa com regra
  // nenhuma — nem webhook externo sai por ele.
  if (await eventoEhDeContatoPessoal(admin, row)) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "contato_pessoal" };
  }

  const { data: rules, error } = await admin
    .from("automation_rules")
    .select("id, name, conditions, actions, trigger_config")
    .eq("organization_id", row.organization_id)
    .eq("trigger_event", row.event_type)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (error) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "error", detail: error.message };
  }
  const todas = (rules ?? []) as unknown as RuleRow[];
  if (!todas.length) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok", detail: "no_rules" };
  }

  // ═══ EVENTO DIRIGIDO: A REGRA QUE O RELÓGIO APONTOU ═══
  //
  // O gatilho de data do funil (`lead.date_field_due`) não nasce de uma ação de
  // ninguém: quem o emite é a varredura `cron/lead-date-field-due`, e ela sabe
  // PARA QUAL REGRA — o payload traz `rule_id`. Sem este recorte, duas regras do
  // mesmo gatilho com `dias` diferentes (240 dias antes do casamento e 60
  // depois dele) rodariam as duas no mesmo evento, porque aqui só se casa
  // `event_type`: a confirmação de entrega sairia junto com o aviso de 240 dias.
  //
  // Todo outro gatilho emite payload sem `rule_id`, então `regraDoEvento`
  // devolve `null` e a seleção segue exatamente como sempre foi: todas as
  // regras ativas daquele tipo.
  const regraApontada = regraDoEvento(row.payload);
  const matched = regraApontada ? todas.filter((r) => r.id === regraApontada) : todas;
  if (!matched.length) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok", detail: "no_rules" };
  }

  const context = await buildContext(admin, row);
  // O pré-check acima só acha o contato pelo payload (`contact_id`/`conversation_id`).
  // O aniversário (`contact.birthday`) traz o contato em `entity_id`, e o evento de
  // negócio ou de compromisso traz o contato pelo lead/compromisso: o contexto
  // hidratado é quem os alcança.
  if ((context.contact as { is_personal?: boolean } | undefined)?.is_personal === true) {
    return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "skipped", detail: "contato_pessoal" };
  }
  const lead = context.lead as
    | { source_metadata?: Record<string, unknown> | null }
    | undefined;
  const webhookSourceId = lead?.source_metadata?.webhook_source_id;

  // ═══ "NO MÁXIMO UMA VEZ POR CONTATO" (#2974) ═══
  //
  // O contato do evento vem do PAYLOAD (`contatoDoEvento`) e, se o payload não
  // o traz, do contexto hidratado — o lead, o compromisso, o aniversário. Sem
  // contato resolvível não há o que contar, e aí a regra segue como sempre foi
  // (fail-open, declarado no gate abaixo): calar por falta de leitura
  // esconderia automação legítima, e é o mesmo desfecho do evento de contato
  // pessoal indisponível.
  const contatoIdDoEvento = (await contatoDoEvento(admin, row)) ?? contatoDoContexto(context);
  // A pergunta ao banco é feita UMA vez por regra, antes do filtro (o filtro é
  // síncrono e não pode esperar): quem já rodou para este contato está aqui.
  const jaRodouParaOCntato = new Map<string, boolean>();
  for (const rule of matched) {
    if (!regraRodaUmaVezPorContato(rule) || !contatoIdDoEvento) continue;
    jaRodouParaOCntato.set(
      rule.id,
      await regraJaRodouParaOCntato(admin, row.organization_id, rule.id, contatoIdDoEvento),
    );
  }

  const barradasPeloLimite: RuleRow[] = [];
  const applicable = matched.filter((rule) => {
    const configuredSourceId = rule.trigger_config?.webhook_source_id;
    if (
      row.event_type === "lead.created" &&
      typeof configuredSourceId === "string" &&
      configuredSourceId !== webhookSourceId
    ) {
      return false;
    }
    if (!evaluateConditions(rule.conditions ?? [], context)) return false;
    if (regraRodaUmaVezPorContato(rule)) {
      if (!contatoIdDoEvento) {
        // FAIL-OPEN: sem contato resolvível a regra segue como hoje e o run
        // grava `contact_id` nulo — que é o rastro de que a conferência não
        // pôde ser feita.
        logger.warn(
          "[automation.engine] regra 'uma vez por contato' sem contato resolvível — segue como sempre (fail-open)",
          {
            rule_id: rule.id,
            organization_id: row.organization_id,
            event_id: row.id,
            event_type: row.event_type,
          },
        );
        return true;
      }
      if (jaRodouParaOCntato.get(rule.id) === true) {
        barradasPeloLimite.push(rule);
        return false;
      }
    }
    return true;
  });

  // A decisão fica REGISTRADA, ainda que nada tenha rodado: quem montou a regra
  // precisa ver na aba Atividade que ela pulou este contato de propósito.
  for (const rule of barradasPeloLimite) {
    if (contatoIdDoEvento) await registrarBloqueioPorLimite(admin, row, rule, contatoIdDoEvento);
  }

  if (!applicable.length) {
    return {
      consumer_key: AUTOMATION_CONSUMER_KEY,
      status: "ok",
      detail: barradasPeloLimite.length ? "uma_vez_por_contato" : "no_match",
    };
  }

  // Pré-checagem de postpone (throttle etc.): all-or-nothing ANTES de executar
  // qualquer ação — reexecução parcial no retry seria pior que atraso.
  for (const rule of applicable) {
    for (const action of rule.actions ?? []) {
      const executor = getAction(action.type);
      if (!executor?.postponeUntil) continue;
      const until = await executor.postponeUntil(
        { admin, serviceBoundaries, organizationId: row.organization_id, ruleId: rule.id, ruleName: rule.name, event: row, context, requestId: row.id },
        action.config ?? {},
      );
      if (until) {
        // A ESPERA É UM ESTADO, e um estado que ninguém vê é indistinguível de
        // morte. Sem esta linha o evento sumia até a janela reabrir e a aba
        // Atividade não mostrava NADA — para quem montou a regra, "não apareceu
        // nada" e "não rodou" são a mesma tela (migration 0175).
        await registrarAdiamento(admin, row, rule, action.type, until);
        return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "retry", retry_at: until };
      }
    }
  }

  // ═══ A RESERVA ANTES DE EXECUTAR (#2974) ═══
  //
  // A pré-checagem de adiamento acima vem ANTES de propósito: o adiamento devolve
  // o evento para a hora marcada (`retry_at`), e reservar antes disso consumiria
  // a única execução do contato sem nada ter saído — a regra esperaria a janela
  // e, quando ela reabrisse, encontraria a própria reserva e não rodaria nunca.
  //
  // Daqui para baixo a chave (regra, contato) está tomada, e o SEGUNDO dreno do
  // mesmo contato não executa: ele registra o bloqueio e o evento segue sem nada
  // sair. Sem contato resolvível não há chave a tomar, e aí não há o que reservar
  // (fail-open já declarado no filtro acima).
  const barradasPelaReserva: RuleRow[] = [];
  if (contatoIdDoEvento) {
    for (const rule of applicable) {
      if (!regraRodaUmaVezPorContato(rule)) continue;
      if (!(await reservarExecucaoPorContato(admin, row, rule, contatoIdDoEvento))) {
        barradasPelaReserva.push(rule);
      }
    }
    for (const rule of barradasPelaReserva) {
      await registrarBloqueioPorLimite(admin, row, rule, contatoIdDoEvento);
    }
  }

  const paraExecutar = applicable.filter((rule) => !barradasPelaReserva.includes(rule));
  if (!paraExecutar.length) {
    // Toda regra que casou perdeu a corrida pela chave do contato. O desfecho é o
    // MESMO do bloqueio decidido na leitura (`detail: uma_vez_por_contato`) — a
    // diferença é só onde a corrida foi decidida: lá, sobre o estado gravado;
    // aqui, no próprio insert. O que a Atividade mostra são as linhas de bloqueio
    // gravadas acima.
    return {
      consumer_key: AUTOMATION_CONSUMER_KEY,
      status: "ok",
      detail: "uma_vez_por_contato",
    };
  }

  for (const rule of paraExecutar) {
    const results: ActionResultDetail[] = [];
    // O índice é o da lista INTEIRA — a posição do resultado em
    // `actions_result` e parte do id da entrega do webhook (#1529).
    for (const [indiceDaAcao, action] of (rule.actions ?? []).entries()) {
      const executor = getAction(action.type);
      if (!executor) {
        results.push({ type: action.type, status: "failed", error: "unknown_action" });
        continue;
      }
      // Defesa em profundidade do veto de #1528: a regra pode ter chegado por
      // outra porta que não o schema (SQL, import). Regravar o lead aqui
      // reemitiria o próprio gatilho, sem marca de anti-laço.
      if (acoesQueFechamLaco(row.event_type, [action]).length) {
        results.push({ type: action.type, status: "skipped", error: "acao_fecharia_laco" });
        continue;
      }
      try {
        results.push(
          await executor.execute(
            {
              admin,
              serviceBoundaries,
              organizationId: row.organization_id,
              ruleId: rule.id,
              ruleName: rule.name,
              event: row,
              context,
              requestId: row.id,
              actionIndex: indiceDaAcao,
              ruleActions: rule.actions ?? [],
            },
            action.config ?? {},
          ),
        );
      } catch (err) {
        results.push(falhaDeExecucaoParaRecibo(action.type, err));
      }
    }

    // ═══ O AGREGADOR TAMBÉM PRECISA DIZER A VERDADE ═══
    //
    // `failed === 0 ? "success"` fazia uma ação `postponed` — mensagem que ficou
    // em `queued` e NÃO chegou ao cliente — virar "Sucesso" verde na tela. É o
    // MESMO defeito que `desfecho-do-envio.ts` existe para matar, ressurgindo
    // um nível acima: a ação passou a ser honesta e quem soma continuava
    // mentindo. Conserto por instância, não por classe.
    //
    // Achado por revisão adversarial, com o cenário alcançável: instalação sem
    // o transporte de WhatsApp configurado (o caso de TODA instalação nova), a
    // janela aberta, `postponeUntil` devolve null, a ação executa, e o envio
    // termina em `queued` com `queued_reason`. É exatamente o estado congelado
    // em `tests/invariants/automation-send-whatsapp.test.ts` caso 2.
    //
    // A MESMA mentira reapareceu de novo, um degrau abaixo: `status ===
    // "skipped"` (guarda-do-contato.ts — sem contato, bloqueado, sem telefone,
    // OU sem consentimento) também não era `failed` nem `postponed`, então caía
    // no `else` e virava "Sucesso" — pra uma mensagem que nunca foi NEM
    // TENTADA. Achado pelo e2e `tests/e2e/automacao-diz-a-verdade.spec.ts`: um
    // lead de webhook genérico (sem Respondi, sem pergunta de consentimento)
    // nunca tem `consent.marketing.granted_at`, então TODO envio automático
    // pra um lead assim batia no gate de consentimento — e a tela dizia
    // "Sucesso" pra um envio que nem chegou a discar o WhatsApp. Pior que o
    // defeito original: aquele pelo menos tinha TENTADO.
    //
    // `skipped` entra junto de `failed` na contagem: as duas significam "não
    // saiu, e não é a fila que vai resolver sozinha" — a diferença entre elas
    // (uma tentou e não conseguiu, a outra nem tentou) é o `reason`/`error` que
    // a ação já registra, não o status agregado.
    //
    // A ordem importa: falha (+ skip) vence adiamento. Uma regra em que uma
    // ação falhou/pulou e outra ficou esperando é `partial` — quem lê precisa
    // saber que algo quebrou, não que está tudo a caminho.
    // (A regra em si vive em `statusDoRun`, porque o registro da decisão de
    // bloqueio por contato — #2974 — também precisa dela: duas cópias da mesma
    // régua divergem no primeiro conserto que só um lado recebe.)
    const status = statusDoRun(results);
    const { data: runRow, error: runErr } = await admin
      .from("automation_rule_runs")
      .insert({
        organization_id: row.organization_id,
        rule_id: rule.id,
        event_id: row.id,
        // O contato da execução (#2974): é esta linha que barra a segunda
        // passagem do MESMO contato por esta regra. Nulo quando o evento não
        // deixa resolvê-lo — e nulo não casa com nada, que é o fail-open.
        contact_id: contatoIdDoEvento,
        status,
        actions_result: resultadosParaRecibo(results),
      })
      .select("id")
      .maybeSingle();
    if (runErr) logger.error("[automation.engine] run insert failed", { error: runErr.message });

    // Audit só em falha/partial (spec §9) — não inflar audit em toda run.
    if (status !== "success") {
      void audit({
        action: "automation.rule_executed",
        organizationId: row.organization_id,
        resourceType: "automation_rule_run",
        resourceId: runRow?.id ?? null,
        metadata: { rule_id: rule.id, status, event_type: row.event_type },
      });
    }

    // run_count sem RPC de increment: read-modify-write é aceitável aqui
    // (contador informativo de UI, não invariante).
    const { data: cur } = await admin.from("automation_rules").select("run_count").eq("id", rule.id).maybeSingle();
    await admin
      .from("automation_rules")
      .update({ last_run_at: new Date().toISOString(), run_count: (cur?.run_count ?? 0) + 1 })
      .eq("id", rule.id);
  }

  return { consumer_key: AUTOMATION_CONSUMER_KEY, status: "ok" };
}
