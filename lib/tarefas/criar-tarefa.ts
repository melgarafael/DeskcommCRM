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
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { truncar } from "@/lib/notifications/push_payload";
import { enviarPushAoUsuario } from "@/lib/notifications/web_push";
import { PRIORIDADES_DA_TAREFA, type PrioridadeDaTarefa } from "@/lib/tarefas/tipos";

/**
 * Quem fica com a tarefa: o dono do negócio, ou uma pessoa escolhida na regra.
 *
 * `dono_do_lead` é a forma nominal — quem monta a regra não sabe (nem deve
 * saber) o uuid de quem vai atender amanhã; o dono muda, a regra não.
 */
export type AtribuicaoDaTarefa = "dono_do_lead" | { usuario_id: string };

export interface PedidoDeTarefa {
  organizationId: string;
  /** Título com placeholders `{{lead.title}}` e `{{contact.name}}`. */
  titulo: string;
  /** De quantos dias o prazo cai a partir de agora. `0` = vence hoje. */
  venceEmDias: number;
  atribuirA: AtribuicaoDaTarefa;
  prioridade: PrioridadeDaTarefa;
  leadId?: string | null;
  contactId?: string | null;
  descricao?: string | null;
  /** De onde veio: `automation:create_task`, `followup:internal_task`, … */
  origem: string;
  requestId?: string;
  agora?: Date;
}

export type ResultadoDaTarefa =
  | { ok: true; tarefa_id: string; assigned_to: string | null }
  | { ok: false; codigo: "sem_alvo" | "sem_dono" | "titulo_vazio" | "falha"; erro?: string };

type LeadDoPedido = {
  id: string;
  title?: string | null;
  contact_id?: string | null;
  owner_user_id?: string | null;
};

type ContatoDoPedido = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};

/**
 * Os placeholders que o título entende, na forma em que o operador os escreve.
 *
 * `{{contact.name}}` prefere `display_name` (o rótulo que a tela mostra) e cai
 * para `name` — mesma cadeia do resto do produto, para o título não mostrar o
 * identificador técnico de WhatsApp no meio do nome.
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
 * Grava a tarefa, audita e (se houver responsável) manda o push.
 *
 * A ordem importa: INSERT → audit → push. Se cair no meio, sobra a tarefa sem
 * o aviso — o cenário recuperável (a pessoa vê a tarefa na lista); a ordem
 * contrária deixaria push apontando para tarefa que não existe.
 *
 * `sem_dono` não é erro de infraestrutura: a regra pediu "dono do negócio" e o
 * negócio não tem dono. Não criamos tarefa órfã — ela não lembra ninguém, e a
 * lista de tarefas sem responsável vira ruído que ensina o time a ignorar.
 */
export async function criarTarefaInterna(
  db: SupabaseClient,
  pedido: PedidoDeTarefa,
): Promise<ResultadoDaTarefa> {
  const agora = pedido.agora ?? new Date();
  const lead = pedido.leadId
    ? ((
        await db
          .from("crm_leads")
          .select("id, title, contact_id, owner_user_id")
          .eq("id", pedido.leadId)
          .eq("organization_id", pedido.organizationId)
          .maybeSingle()
      ).data as LeadDoPedido | null)
    : null;

  const contactId = pedido.contactId ?? lead?.contact_id ?? null;
  const contact = contactId
    ? ((
        await db
          .from("contacts")
          .select("id, name, display_name")
          .eq("id", contactId)
          .eq("organization_id", pedido.organizationId)
          .maybeSingle()
      ).data as ContatoDoPedido | null)
    : null;

  if (!lead && !contact) {
    return { ok: false, codigo: "sem_alvo" };
  }

  const assignedTo =
    typeof pedido.atribuirA === "object" ? pedido.atribuirA.usuario_id : (lead?.owner_user_id ?? null);
  if (typeof pedido.atribuirA === "object" && !assignedTo) {
    return { ok: false, codigo: "sem_dono" };
  }
  if (typeof pedido.atribuirA === "string" && !assignedTo) {
    return { ok: false, codigo: "sem_dono" };
  }

  const titulo = interpolarTitulo(pedido.titulo, { lead, contact });
  if (!titulo) return { ok: false, codigo: "titulo_vazio" };

  const dueDate = new Date(agora.getTime() + pedido.venceEmDias * 86_400_000).toISOString();

  const { data: criada, error } = await db
    .from("crm_tasks")
    .insert({
      organization_id: pedido.organizationId,
      title: titulo,
      description: pedido.descricao ?? null,
      due_date: dueDate,
      priority: pedido.prioridade,
      status: "pending",
      lead_id: lead?.id ?? null,
      contact_id: contactId,
      assigned_to: assignedTo,
      created_by: null,
    })
    .select("id")
    .maybeSingle();

  if (error || !criada) {
    return { ok: false, codigo: "falha", erro: error?.message };
  }

  const tarefaId = criada.id as string;

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
      vence_em_dias: pedido.venceEmDias,
    },
    ...(pedido.requestId ? { requestId: pedido.requestId } : {}),
  });

  if (assignedTo) {
    try {
      await enviarPushAoUsuario(pedido.organizationId, assignedTo, {
        title: "Nova tarefa",
        body: truncar(titulo),
        tag: `task:${tarefaId}`,
        href: "/app/tasks",
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
