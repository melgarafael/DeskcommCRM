/**
 * CRIAR TAREFA — o lembrete interno que nunca vira mensagem ao cliente (#1540).
 *
 * Um módulo, DUAS portas: a ação de automação `create_task`
 * (`lib/automation/actions/create-task.ts`) e o nó `internal_task` dos fluxos
 * de follow-up (`lib/followup/node-handlers.ts` → `criarTarefaInterna` no
 * adapter do engine). As duas precisam gravar, auditar e avisar do mesmo jeito —
 * regras escritas duas vezes divergem no primeiro ajuste, e a divergência aqui
 * é invisível: as duas rotinas "criam tarefa", só que uma delas esquece o audit
 * ou o aviso.
 *
 * ═══ O QUE ESTE MÓDULO NÃO FAZ ═══
 *
 * Não manda nada ao cliente. Não existe `send_*` aqui dentro: o título da tarefa
 * é lido por uma pessoa na tela, e o push vai só para o RESPONSÁVEL. É a
 * diferença que a issue pede — advocacia, saúde e serviços regulados precisam
 * que o sistema LEMBRE a equipe e não que o sistema fale.
 *
 * ═══ O BANCO VEM PELA PORTA (#3715) ═══
 *
 * As três consultas (negócio, contato, INSERT da tarefa) deixaram de ser a
 * cadeia do PostgREST e são SQL com parâmetros em `lib/db`. Quem chama passa a
 * PORTA (`portaDaAplicacao()`), não mais o cliente do SDK: aceitar os dois
 * seria aceitar um cliente que a função ignora — e o chamador acharia que a
 * escrita foi por ele. Os quatro chamadores (as duas ações de automação, o nó
 * `internal_task` do follow-up e o aviso de carteira) foram adaptados junto.
 * A organização é filtro de SQL em toda leitura: o pool não passa por RLS.
 */
import type { Db } from "@/lib/db";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { truncar } from "@/lib/notifications/push_payload";
import { enviarPushAoUsuario } from "@/lib/notifications/web_push";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import type { MotivoSemPrazo } from "@/lib/tarefas/prazo-relativo";
import { HREF_MINHAS_TAREFAS, PRIORIDADES_DA_TAREFA, type PrioridadeDaTarefa } from "@/lib/tarefas/tipos";

/**
 * Quem fica com a tarefa: o dono do negócio, ou uma pessoa escolhida na regra.
 *
 * `dono_do_lead` é a forma nominal — quem monta a regra não sabe (nem deve
 * saber) o uuid de quem vai atender amanhã; o dono muda, a regra não.
 */
export type AtribuicaoDaTarefa =
  | "dono_do_lead"
  | { usuario_id: string }
  /**
   * Exatamente este responsável — inclusive NENHUM (`null`).
   *
   * É o da OCORRÊNCIA de uma série que se repete (#4595): o que a próxima herda
   * é o dono da série, e se a série não tem dono a próxima também não tem. Usar
   * `dono_do_lead` aqui inventaria um responsável que ninguém escolheu; recusar
   * por `sem_dono` deixaria a série sem gerar para sempre.
   */
  | { exato: string | null };

export interface PedidoDeTarefa {
  organizationId: string;
  /** Título com placeholders `{{lead.title}}` e `{{contact.name}}`. */
  titulo: string;
  /**
   * De quantos dias o prazo cai a partir de agora. `0` = vence hoje.
   *
   * Ignorado quando `venceEm` vem preenchido: a ocorrência de uma série não
   * vence "em N dias", ela vence numa data e hora do calendário.
   *
   * Um dos dois prazos é obrigatório — este ou `venceEm` —, mas NENHUM dos dois
   * é exigido pelo tipo: quem não manda prazo cria a tarefa sem prazo, que é um
   * estado legítimo da coluna (`due_date` nulo).
   */
  venceEmDias?: number;
  /**
   * O prazo já calculado, em instante ISO. `null` = SEM prazo: o passo do plano
   * apontava para um campo de data vazio (ou com lixo) e o prazo não foi
   * inventado (#4717 item 4). Quando presente, ganha de `venceEmDias`.
   *
   * É por aqui que a OCORRÊNCIA de uma série recebe a data e hora que
   * `proximaOcorrencia` calculou (#4595).
   */
  venceEm?: string | null;
  /** Por que a tarefa nasceu sem prazo. Só faz sentido junto de `venceEm: null`. */
  prazoMotivo?: MotivoSemPrazo | null;
  /**
   * O plano que criou a tarefa e o passo de onde ela veio.
   *
   * É o que deixa o gatilho do card (`crm_leads_recalcula_prazos_do_plano`)
   * encontrar as tarefas AINDA ABERTAS do plano quando a data do campo muda —
   * sem coluna de origem a marca da aplicação só sabe dizer "aplicado", não
   * QUAIS linhas são daquele plano.
   */
  plano?: { id: string; passo: number; campo: string | null; dias: number };
  atribuirA: AtribuicaoDaTarefa;
  prioridade: PrioridadeDaTarefa;
  leadId?: string | null;
  contactId?: string | null;
  /** A demanda do atendimento a que a tarefa fica presa (#2818). */
  demandaId?: string | null;
  descricao?: string | null;
  /**
   * A série que gerou esta ocorrência (#4595). Nulo = tarefa avulsa ou a
   * própria série — é o que a lista usa para dizer "esta faz parte de uma
   * rotina" sem repetir a regra em cada linha.
   */
  recurrenceSourceId?: string | null;
  /**
   * Tarefa SOLTA é permitida (`crm_tasks` nasce com `lead_id` e `contact_id`
   * nulos de propósito — migration 0210). A recusa `sem_alvo` existe para as
   * automações, que só fazem sentido presas a um negócio ou contato; a
   * ocorrência de uma série solta é o caso legítimo de desligá-la.
   */
  alvoOpcional?: boolean;
  /** Quem criou. A ocorrência herda o autor da série. */
  createdBy?: string | null;
  /** De onde veio: `automation:create_task`, `followup:internal_task`, … */
  origem: string;
  requestId?: string;
  agora?: Date;
}

export type ResultadoDaTarefa =
  | { ok: true; tarefa_id: string; assigned_to: string | null }
  | {
      ok: false;
      /**
       * `ja_existe` NÃO é falha: é o índice único `(recurrence_source_id,
       * due_date)` recusando a segunda ocorrência da mesma série na mesma data —
       * exatamente o que faz concluir duas vezes não criar duas tarefas.
       */
      codigo: "sem_alvo" | "sem_dono" | "titulo_vazio" | "ja_existe" | "falha";
      erro?: string;
    };

export type LeadDoPedido = {
  id: string;
  title?: string | null;
  contact_id?: string | null;
  owner_user_id?: string | null;
  /** `crm_leads.custom_fields` — de onde o prazo de um passo de data é lido. */
  custom_fields?: unknown;
};

export type ContatoDoPedido = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};

/**
 * Os placeholders que o título entende, na forma em que o operador os escreve.
 *
 * `{{contact.name}}` segue a MESMA cadeia do resto do produto
 * (`nomeDoContato`): `name` primeiro, e `display_name` só quando o nome de
 * cadastro está vazio ou é identificador técnico — para o título não mostrar
 * o identificador técnico de WhatsApp no meio do nome. Inverter essa ordem
 * aqui seria inverter em todo o produto (a ressalva está escrita em
 * `lib/contacts/rotulo-do-contato.ts`, que é de onde esta função puxa o nome).
 *
 * Placeholder sem dado NÃO é apagado: `{{lead.title}}` vazio viraria título em
 * branco (o CHECK `crm_tasks_titulo_nao_vazio` recusaria a linha sem dizer
 * por quê), e apagar esconderia do operador que falta preencher o campo.
 */
export function interpolarTitulo(
  titulo: string,
  valores: { lead?: LeadDoPedido | null; contact?: ContatoDoPedido | null },
): string {
  const leadTitle = valores.lead?.title?.trim() ?? "";
  const contatoNome = nomeDoContato(valores.contact) ?? "";
  return titulo
    .replaceAll("{{lead.title}}", leadTitle)
    .replaceAll("{{contact.name}}", contatoNome)
    .trim();
}

/**
 * A recusa de CONFIGURAÇÃO de UM passo — sem escrever nada.
 *
 * Esta função É a regra `sem_dono`/`titulo_vazio`, num sítio só: quem chama
 * duas vezes com a mesma entrada tem de recusar do mesmo jeito. O portão novo
 * é o do plano (`lib/tarefas/plano.ts`), que confere TODOS os passos antes do
 * primeiro INSERT; sem esta função, a validação do plano seria uma cópia das
 * linhas abaixo e as duas divergiriam no primeiro ajuste — os dois "validam o
 * mesmo passo", só que um deixa passar o que o outro recusa.
 *
 * `sem_alvo` NÃO é daqui: ele depende de não haver lead nem contato, que é uma
 * pergunta do pedido, não do passo.
 */
export function donoDoPedido(
  atribuirA: AtribuicaoDaTarefa,
  lead: LeadDoPedido | null | undefined,
): string | null {
  if (atribuirA === "dono_do_lead") return lead?.owner_user_id ?? null;
  if ("exato" in atribuirA) return atribuirA.exato;
  return atribuirA.usuario_id;
}

export function recusaDeConfiguracao(
  atribuirA: AtribuicaoDaTarefa,
  titulo: string,
  valores: { lead?: LeadDoPedido | null; contact?: ContatoDoPedido | null },
): "sem_dono" | "titulo_vazio" | null {
  // `exato: null` é uma ESCOLHA (a série não tem dono), não um dono que faltou:
  // recusar aqui faria a recorrência de uma tarefa solta nunca gerar nada.
  const escolhaExplicita = typeof atribuirA === "object" && "exato" in atribuirA;
  const atribuido = donoDoPedido(atribuirA, valores.lead);
  if (!atribuido && !escolhaExplicita) return "sem_dono";
  if (!interpolarTitulo(titulo, valores)) return "titulo_vazio";
  return null;
}

/**
 * Leitura de UMA linha que já tolerava erro — e continua tolerando.
 *
 * Com o PostgREST, `.maybeSingle()` devolvia `{ data: null, error }` e este
 * módulo olhava só `data`: um erro de leitura virava "não achei", e a recusa
 * saía como `sem_alvo` (configuração) e não como `falha` (infra). Preservar
 * isso é preservar o contrato visível de quem chama — inclusive o desfecho
 * FECHADO (nunca cria tarefa com um alvo que não conseguiu ler). Distinguir os
 * dois casos é decisão de produto, não de migração.
 */
async function lerLinha<T>(
  db: Db,
  sql: string,
  parametros: readonly unknown[],
): Promise<T | null> {
  try {
    return await db.queryOne<T>(sql, parametros);
  } catch {
    return null;
  }
}

/** Mensagem crua do driver, sem SQL montado — é o que vira `erro` no resultado. */
function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Grava a tarefa, audita, registra na linha do tempo do negócio e (se houver
 * responsável) manda o push.
 *
 * A ordem importa: INSERT → audit → atividade → push. Se cair no meio, sobra a
 * tarefa sem o aviso — o cenário recuperável (a pessoa vê a tarefa na lista); a
 * ordem contrária deixaria push apontando para tarefa que não existe.
 *
 * `sem_dono` não é erro de infraestrutura: a regra pediu "dono do negócio" e o
 * negócio não tem dono. Não criamos tarefa órfã — ela não lembra ninguém, e a
 * lista de tarefas sem responsável vira ruído que ensina o time a ignorar.
 */
export async function criarTarefaInterna(
  db: Db,
  pedido: PedidoDeTarefa,
): Promise<ResultadoDaTarefa> {
  const agora = pedido.agora ?? new Date();

  const lead = pedido.leadId
    ? await lerLinha<LeadDoPedido>(
        db,
        `select id, title, contact_id, owner_user_id
           from crm_leads
          where id = $1
            and organization_id = $2
          limit 1`,
        [pedido.leadId, pedido.organizationId],
      )
    : null;

  const contactId = pedido.contactId ?? lead?.contact_id ?? null;
  const contact = contactId
    ? await lerLinha<ContatoDoPedido>(
        db,
        `select id, name, display_name
           from contacts
          where id = $1
            and organization_id = $2
          limit 1`,
        [contactId, pedido.organizationId],
      )
    : null;

  if (!lead && !contact && !pedido.alvoOpcional) {
    return { ok: false, codigo: "sem_alvo" };
  }

  const recusa = recusaDeConfiguracao(pedido.atribuirA, pedido.titulo, { lead, contact });
  if (recusa) return { ok: false, codigo: recusa };

  const assignedTo = donoDoPedido(pedido.atribuirA, lead);
  const titulo = interpolarTitulo(pedido.titulo, { lead, contact });

  // Três origens de prazo, nesta ordem de precedência:
  //
  //   1. `venceEm` — o instante JÁ calculado (passo de campo de data do plano,
  //      #4717 item 4). `null` é resposta, não ausência: nasce sem prazo.
  //   2. `venceEmDias` — o modo de sempre, com a MESMA conta de antes
  //      (`agora + N × 24h`). Não mexer nesta linha é o que mantém o plano
  //      antigo idêntico ao que era.
  //   3. nenhum → sem prazo. A coluna aceita nulo de propósito.
  const dueDate =
    pedido.venceEm !== undefined
      ? pedido.venceEm
      : pedido.venceEmDias !== undefined
        ? new Date(agora.getTime() + pedido.venceEmDias * 86_400_000).toISOString()
        : null;

  // INSERT … RETURNING id: o `.insert().select("id").maybeSingle()` do
  // PostgREST devolvia a linha criada numa segunda ida (Prefer: return=
  // representation); aqui o id vem na MESMA ida.
  let tarefaId: string;
  try {
    // O `on conflict` é a IDEMPOTÊNCIA DA RECORRÊNCIA (#4595): concluir a mesma
    // tarefa duas vezes calcula a mesma data e chega duas vezes aqui. O índice
    // único parcial `(recurrence_source_id, due_date)` (migration 9369) recusa a
    // segunda, e `do nothing` transforma a recusa em "já existia" — nunca em
    // erro, nunca em duas tarefas. Para tarefa avulsa a cláusula é inerte: sem
    // `recurrence_source_id` a linha fica fora do índice.
    const criadas = await db.query<{ id: string }>(
      `insert into crm_tasks
         (organization_id, title, description, due_date, priority, status,
          lead_id, contact_id, demanda_id, assigned_to, created_by,
          plan_id, plan_step, prazo_campo, prazo_dias, prazo_motivo,
          recurrence_source_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       on conflict (recurrence_source_id, due_date)
         where recurrence_source_id is not null and due_date is not null
       do nothing
       returning id`,
      [
        pedido.organizationId,
        titulo,
        pedido.descricao ?? null,
        dueDate,
        pedido.prioridade,
        "pending",
        lead?.id ?? null,
        contactId,
        pedido.demandaId ?? null,
        assignedTo,
        pedido.createdBy ?? null,
        pedido.plano?.id ?? null,
        pedido.plano?.passo ?? null,
        pedido.plano?.campo ?? null,
        pedido.plano?.dias ?? null,
        pedido.prazoMotivo ?? null,
        pedido.recurrenceSourceId ?? null,
      ],
    );

    // `RETURNING id` devolve exatamente a linha inserida; se o driver não
    // devolveu nada, ou o INSERT não aconteceu ou o índice único barrou a
    // duplicata. A segunda leitura é a que decide qual dos dois foi.
    const criada = criadas[0];
    if (!criada) {
      return pedido.recurrenceSourceId
        ? { ok: false, codigo: "ja_existe" }
        : { ok: false, codigo: "falha" };
    }
    tarefaId = criada.id;
  } catch (err) {
    return { ok: false, codigo: "falha", erro: mensagemDoErro(err) };
  }

  // Fire-and-forget quanto a erro: perder o audit ou o push não pode desfazer a
  // tarefa que já existe (lei do CLAUDE.md §Audit log — mesma razão dos crons
  // que só auditam quando há efeito).
  await audit({
    action: "crm_task.created",
    resourceType: "crm_task",
    resourceId: tarefaId,
    organizationId: pedido.organizationId,
    metadata: {
      origem: pedido.origem,
      lead_id: lead?.id ?? null,
      contact_id: contactId,
      assigned_to: assignedTo,
      prioridade: pedido.prioridade,
      vence_em_dias: pedido.venceEmDias ?? null,
      // "Nasceu sem prazo" tem de sobrar no audit: é a consequência de um campo
      // do card vazio, e o motivo é o que explica a tarefa sem data na lista.
      ...(pedido.prazoMotivo ? { sem_prazo: pedido.prazoMotivo } : {}),
      ...(pedido.plano ? { plano_id: pedido.plano.id, plano_passo: pedido.plano.passo } : {}),
    },
    ...(pedido.requestId ? { requestId: pedido.requestId } : {}),
  });

  // O LAÇO DE RETORNO (#1540): a tarefa automática entra na linha do tempo do
  // negócio do MESMO jeito que a criada pela tela (`POST /api/v1/tasks` →
  // `registraAtividadeDaTarefa`). Sem esta chamada, o card do lead mostrava a
  // conversa parada sem sinal nenhum de que o sistema marcou um retorno — e o
  // operador perguntava se o follow-up tinha parado. O ator é `system`
  // (`webhook_source` com a origem, o padrão de `nascimento-do-lead.ts`):
  // quem criou foi a regra, não uma pessoa.
  await registraAtividadeDaTarefa(db, {
    organizationId: pedido.organizationId,
    tarefa: {
      id: tarefaId,
      title: titulo,
      due_date: dueDate,
      priority: pedido.prioridade,
      lead_id: lead?.id ?? null,
      contact_id: contactId,
    },
    tipo: "task_created",
    actor: { type: "webhook_source", id: pedido.origem },
  });

  if (assignedTo) {
    try {
      await enviarPushAoUsuario(pedido.organizationId, assignedTo, {
        title: "Nova tarefa",
        body: truncar(titulo),
        tag: `task:${tarefaId}`,
        href: HREF_MINHAS_TAREFAS,
      });
    } catch (err) {
      logger.warn("task_push_failed", {
        organization_id: pedido.organizationId,
        task_id: tarefaId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: true, tarefa_id: tarefaId, assigned_to: assignedTo };
}

/** Rótulo do resultado para o `detail` da ação — código, nunca frase solta. */
export function motivoDoResultado(resultado: ResultadoDaTarefa): string | null {
  return resultado.ok ? null : resultado.codigo;
}

/** Conferência defensiva: a prioridade vem do banco, não do operador. */
export function prioridadeValida(v: unknown): v is PrioridadeDaTarefa {
  return typeof v === "string" && (PRIORIDADES_DA_TAREFA as readonly string[]).includes(v);
}
