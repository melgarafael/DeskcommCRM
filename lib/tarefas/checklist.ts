/**
 * CHECKLIST DO CARD (#4717, FASE 1) — o plano aplicado como LISTA ÚNICA no
 * negócio, com estado por item, autor da marcação e progresso.
 *
 * ═══ POR QUE NÃO HÁ TABELA NEM COLUNA NOVA ═══
 *
 * Aplicar um plano já grava tudo o que um checklist precisa:
 *
 *   · `aplicarPlanoDeTarefas` (`lib/tarefas/plano.ts`) cria UMA tarefa por
 *     passo, NA ORDEM do plano, e depois grava a marca `task_plan_applied` em
 *     `crm_lead_activities` com `payload.tarefa_ids` — a lista de ids na ORDEM
 *     em que os passos foram criados;
 *   · marcar uma tarefa como concluída já grava `task_completed` na linha do
 *     tempo do negócio, com `performed_by_user_id` (quem) e o `created_at` da
 *     própria linha (quando);
 *   · desmarcar é voltar o `crm_tasks.status` para `pending` e NÃO apaga a
 *     linha `task_completed` — o autor da marcação original é história, não
 *     estado.
 *
 * Ou seja: a ordem está no `payload`, o estado está em `crm_tasks.status`, o
 * autor e a data estão em `crm_lead_activities`. Uma tabela `task_checklist`
 * (+ `task_checklist_items`) duplicaria os três e criaria uma segunda verdade
 * sobre "esta etapa foi cumprida?" — a tarefa continuaria existindo na aba
 * Tarefas, com o seu próprio status, e as duas divergiriam no primeiro dia em
 * que alguém concluísse a tarefa por lá.
 *
 * O custo honesto desta escolha, declarado no PR: a leitura monta a lista a
 * partir do `payload` de jsonb (duas consultas por card, não uma view) e um
 * item apagado na aba Tarefas some do checklist — o que é o desfecho certo,
 * porque o checklist É a tarefa.
 *
 * ═══ SEM PLANO APLICADO, NÃO HÁ CHECKLIST ═══
 *
 * `null` é a resposta para "este negócio nunca recebeu um plano", e é diferente
 * de lista vazia: o painel do card não desenha a seção, e ninguém procura um
 * recurso que não existe.
 */
import type { Db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import type { PrioridadeDaTarefa, SituacaoDaTarefa } from "@/lib/tarefas/tipos";

/** O `type` da marca que `aplicarPlanoDeTarefas` grava — a origem da lista. */
const TIPO_DA_APLICACAO = "task_plan_applied";
/** O `type` da linha que a conclusão de tarefa já grava (autor e data). */
const TIPO_DA_CONCLUSAO = "task_completed";

/**
 * O teto de aplicações lidas por negócio. Um card recebe um plano por
 * automação; 200 é folga de sobra para o histórico e impede que um laço de
 * automação mal configurado transforme a leitura do painel numa varredura.
 */
const LIMITE_DE_APLICACOES = 200;

/** Um item do checklist — sempre uma linha de `crm_tasks`. */
export interface ItemDoChecklist {
  /** O id da TAREFA. É a chave do item: não existe item sem tarefa. */
  tarefa_id: string;
  /** Posição na lista única do card, 1-based. Ordem do plano, não do prazo. */
  ordem: number;
  titulo: string;
  status: SituacaoDaTarefa;
  /** `status === "done"`. Cancelada NÃO conta como concluída. */
  concluido: boolean;
  prazo: string | null;
  /** O plano que criou o item (`payload.plano_id` da aplicação). */
  plano_id: string;
  plano_nome: string;
  /**
   * A ÚLTIMA marcação de conclusão: quem e quando. Continua preenchida depois
   * de desmarcar — é o histórico, e é ele que não pode ser perdido (#4717).
   */
  marcado_por: string | null;
  marcado_por_nome: string | null;
  marcado_em: string | null;
}

export interface ChecklistDoNegocio {
  negocio_id: string;
  itens: ItemDoChecklist[];
  /** Itens com `status === "done"`. */
  concluidos: number;
  total: number;
  /** Os planos que compõem a lista, na ordem em que foram aplicados. */
  planos: string[];
}

export type CodigoDaLeitura = "negocio_fora_do_escopo" | "falha";

export type ResultadoDaLeitura =
  | { ok: true; checklist: ChecklistDoNegocio | null }
  | { ok: false; codigo: CodigoDaLeitura; erro?: string };

export type CodigoDaMarcacao =
  | "negocio_fora_do_escopo"
  | "item_fora_do_checklist"
  | "falha";

export type ResultadoDaMarcacao =
  | {
      ok: true;
      checklist: ChecklistDoNegocio;
      item: ItemDoChecklist;
      /** A situação ANTES do gesto — `anterior === item.status` é "nada mudou". */
      anterior: SituacaoDaTarefa;
    }
  | { ok: false; codigo: CodigoDaMarcacao; erro?: string };

function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iso(valor: string | Date | null): string | null {
  if (valor === null) return null;
  return valor instanceof Date ? valor.toISOString() : valor;
}

/** Os ids de tarefa de UMA aplicação, na ordem declarada — tolerante ao jsonb. */
function idsDaAplicacao(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const bruto = (payload as { tarefa_ids?: unknown }).tarefa_ids;
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function nomeDoPlano(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const nome = (payload as { plano_nome?: unknown }).plano_nome;
  return typeof nome === "string" && nome.trim() ? nome : null;
}

function idDoPlano(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = (payload as { plano_id?: unknown }).plano_id;
  return typeof id === "string" && id.trim() ? id : null;
}

/**
 * A REGRA da lista, pura: junta as aplicações (na ordem em que rodaram), as
 * tarefas e as marcações numa lista única.
 *
 * Item duplicado entre duas aplicações do MESMO plano não existe, porque a
 * aplicação é idempotente; entre planos DIFERENTES, o primeiro dono do id vence
 * — o `tarefa_ids` de uma aplicação não repete id de outra, mas a leitura não
 * depende disso para estar certa.
 */
export function montarChecklistDoNegocio(entrada: {
  negocioId: string;
  aplicacoes: ReadonlyArray<{ payload: unknown }>;
  tarefas: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    due_date: string | Date | null;
  }>;
  marcas: ReadonlyArray<{
    source_id: string | null;
    performed_by_user_id: string | null;
    created_at: string | Date;
  }>;
  nomes?: ReadonlyMap<string, string | null>;
}): ChecklistDoNegocio | null {
  const tarefaPorId = new Map(entrada.tarefas.map((t) => [t.id, t]));
  /** Última marcação por tarefa: a linha mais recente vence. */
  const marcaPorTarefa = new Map<string, { autor: string | null; quando: string }>();
  for (const marca of entrada.marcas) {
    if (!marca.source_id) continue;
    const quando = iso(marca.created_at);
    if (!quando) continue;
    marcaPorTarefa.set(marca.source_id, {
      autor: marca.performed_by_user_id,
      quando,
    });
  }

  const itens: ItemDoChecklist[] = [];
  const planos: string[] = [];
  const vistos = new Set<string>();

  for (const aplicacao of entrada.aplicacoes) {
    const planoId = idDoPlano(aplicacao.payload) ?? "";
    const planoNome = nomeDoPlano(aplicacao.payload) ?? "";
    if (planoNome && !planos.includes(planoNome)) planos.push(planoNome);

    for (const tarefaId of idsDaAplicacao(aplicacao.payload)) {
      if (vistos.has(tarefaId)) continue;
      const tarefa = tarefaPorId.get(tarefaId);
      // Tarefa apagada (ou de outro negócio) sai da lista: o checklist É a
      // tarefa, e item fantasma não se marca.
      if (!tarefa) continue;
      vistos.add(tarefaId);
      const marca = marcaPorTarefa.get(tarefaId);
      const concluido = tarefa.status === "done";
      itens.push({
        tarefa_id: tarefaId,
        ordem: itens.length + 1,
        titulo: tarefa.title,
        status: tarefa.status as SituacaoDaTarefa,
        concluido,
        prazo: iso(tarefa.due_date),
        plano_id: planoId,
        plano_nome: planoNome,
        marcado_por: marca?.autor ?? null,
        marcado_por_nome: marca?.autor ? (entrada.nomes?.get(marca.autor) ?? null) : null,
        marcado_em: marca?.quando ?? null,
      });
    }
  }

  if (itens.length === 0) return null;

  return {
    negocio_id: entrada.negocioId,
    itens,
    concluidos: itens.filter((item) => item.concluido).length,
    total: itens.length,
    planos,
  };
}

/** O negócio existe NESTA organização? Sem isso não há escopo nem escrita. */
async function negocioDaOrganizacao(
  db: Db,
  organizationId: string,
  leadId: string,
): Promise<boolean> {
  const linha = await db.queryOne<{ id: string }>(
    `select id
       from crm_leads
      where id = $1
        and organization_id = $2
      limit 1`,
    [leadId, organizationId],
  );
  return Boolean(linha);
}

interface AplicacaoLida {
  payload: unknown;
}

async function aplicacoesDoNegocio(
  db: Db,
  organizationId: string,
  leadId: string,
): Promise<AplicacaoLida[]> {
  return db.query<AplicacaoLida>(
    `select payload
       from crm_lead_activities
      where organization_id = $1
        and lead_id = $2
        and type = $3
      order by created_at asc, id asc
      limit $4`,
    [organizationId, leadId, TIPO_DA_APLICACAO, LIMITE_DE_APLICACOES],
  );
}

/** Os ids na ORDEM do plano, para a leitura das tarefas e das marcações. */
function idsNaOrdem(aplicacoes: ReadonlyArray<AplicacaoLida>): string[] {
  const ids: string[] = [];
  const vistos = new Set<string>();
  for (const aplicacao of aplicacoes) {
    for (const id of idsDaAplicacao(aplicacao.payload)) {
      if (vistos.has(id)) continue;
      vistos.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Lê o checklist de um negócio. `checklist: null` = nenhum plano foi aplicado
 * (não é erro). Negócio de outra organização é RECUSA, não lista vazia: quem
 * não vê o negócio não vê o checklist.
 */
export async function lerChecklistDoNegocio(
  db: Db,
  pedido: { organizationId: string; leadId: string },
): Promise<ResultadoDaLeitura> {
  const { organizationId, leadId } = pedido;

  try {
    if (!(await negocioDaOrganizacao(db, organizationId, leadId))) {
      return { ok: false, codigo: "negocio_fora_do_escopo" };
    }

    const aplicacoes = await aplicacoesDoNegocio(db, organizationId, leadId);
    const ids = idsNaOrdem(aplicacoes);
    if (ids.length === 0) return { ok: true, checklist: null };

    const tarefas = await db.query<{
      id: string;
      title: string;
      status: string;
      due_date: string | Date | null;
    }>(
      `select id, title, status, due_date
         from crm_tasks
        where organization_id = $1
          and lead_id = $2
          and id = any($3::uuid[])`,
      [organizationId, leadId, ids],
    );

    const marcas = await db.query<{
      source_id: string | null;
      performed_by_user_id: string | null;
      created_at: string | Date;
    }>(
      `select source_id, performed_by_user_id, created_at
         from crm_lead_activities
        where organization_id = $1
          and lead_id = $2
          and type = $3
          and source_id = any($4::uuid[])
        order by created_at asc, id asc`,
      [organizationId, leadId, TIPO_DA_CONCLUSAO, ids],
    );

    // Nome de quem marcou: a MESMA função que o resto do produto usa
    // (`fn_nomes_dos_membros`), uma consulta para todos os ids. Sem nome, o
    // item continua dizendo QUEM pelo id — o nome é cortesia, nunca a verdade.
    const nomes = new Map<string, string | null>();
    const autores = [...new Set(marcas.map((m) => m.performed_by_user_id).filter(Boolean))] as string[];
    if (autores.length > 0) {
      try {
        const linhas = await db.query<{ user_id: string; full_name: string | null; email: string | null }>(
          `select user_id, full_name, email
             from public.fn_nomes_dos_membros($1, $2::uuid[])`,
          [organizationId, autores],
        );
        for (const linha of linhas) {
          nomes.set(linha.user_id, linha.full_name?.trim() || linha.email || null);
        }
      } catch (err) {
        // O nome é cortesia: sem ele o item segue dizendo QUEM pelo id. Mas a
        // falha fica registrada — o baseline cria a função, então ela faltar é
        // defeito de instalação, não estado normal.
        logger.warn("[checklist] nomes de quem marcou indisponíveis", {
          organization_id: organizationId,
          error: mensagemDoErro(err),
        });
      }
    }

    return {
      ok: true,
      checklist: montarChecklistDoNegocio({
        negocioId: leadId,
        aplicacoes,
        tarefas,
        marcas,
        nomes,
      }),
    };
  } catch (err) {
    return { ok: false, codigo: "falha", erro: mensagemDoErro(err) };
  }
}

/**
 * Grava a nova situação da tarefa COM A PERMISSÃO DE QUEM PEDIU. Devolve
 * `false` quando a escrita não alcançou a linha (a régua de escrita da sessão
 * a recusou). Quem chama da rota passa o client da sessão; a lib não escolhe a
 * permissão, porque a porta da aplicação não passa por ela.
 */
export type GravarSituacao = (tarefaId: string, alvo: SituacaoDaTarefa) => Promise<boolean>;

/**
 * Marca (ou desmarca) UM item do checklist.
 *
 * Três guardas antes de qualquer escrita, na ordem em que importam:
 *
 *   1. o NEGÓCIO é desta organização — negócio de outra org responde
 *      `negocio_fora_do_escopo`, e nada é lido nem gravado;
 *   2. a TAREFA pertence ao checklist DESTE negócio — pedir um id qualquer
 *      (de outro card, de outra org, ou de uma tarefa avulsa) responde
 *      `item_fora_do_checklist`. Sem esta guarda o painel viraria uma porta
 *      para escrever em qualquer tarefa da organização;
 *   3. nada a fazer é `ok` — marcar o que já está marcado não grava segunda
 *      linha na timeline (a mesma regra do PATCH de tarefa).
 *
 * Concluir grava `task_completed` via `registraAtividadeDaTarefa` — a MESMA
 * função da rota de tarefas, para o autor e a data do checklist serem os
 * mesmos que a linha do tempo do negócio mostra. Desmarcar NÃO apaga essa
 * linha: o autor da marcação original é histórico (#4717).
 */
export async function marcarItemDoChecklist(
  db: Db,
  pedido: {
    organizationId: string;
    leadId: string;
    tarefaId: string;
    /** Quem está marcando — o autor gravado na atividade. */
    usuarioId: string;
    concluido: boolean;
    /** De onde veio o gesto (`tela:inbox`), como no resto das atividades. */
    origem?: string;
  },
  gravarSituacao: GravarSituacao,
): Promise<ResultadoDaMarcacao> {
  const { organizationId, leadId, tarefaId, usuarioId, concluido } = pedido;

  try {
    if (!(await negocioDaOrganizacao(db, organizationId, leadId))) {
      return { ok: false, codigo: "negocio_fora_do_escopo" };
    }

    const aplicacoes = await aplicacoesDoNegocio(db, organizationId, leadId);
    if (!idsNaOrdem(aplicacoes).includes(tarefaId)) {
      return { ok: false, codigo: "item_fora_do_checklist" };
    }

    const tarefa = await db.queryOne<{
      id: string;
      title: string;
      description: string | null;
      status: SituacaoDaTarefa;
      priority: PrioridadeDaTarefa;
      due_date: string | Date | null;
      lead_id: string | null;
      contact_id: string | null;
    }>(
      `select id, title, description, status, priority, due_date, lead_id, contact_id
         from crm_tasks
        where id = $1
          and organization_id = $2
          and lead_id = $3
        limit 1`,
      [tarefaId, organizationId, leadId],
    );
    if (!tarefa) return { ok: false, codigo: "item_fora_do_checklist" };

    const alvo: SituacaoDaTarefa = concluido ? "done" : "pending";

    if (tarefa.status !== alvo) {
      if (!(await gravarSituacao(tarefaId, alvo))) {
        return { ok: false, codigo: "item_fora_do_checklist" };
      }

      if (alvo === "done") {
        const atividade = await registraAtividadeDaTarefa(db, {
          organizationId,
          tarefa: {
            id: tarefa.id,
            title: tarefa.title,
            due_date: iso(tarefa.due_date),
            priority: tarefa.priority,
            lead_id: tarefa.lead_id,
            contact_id: tarefa.contact_id,
          },
          tipo: "task_completed",
          actor: { type: "user", id: usuarioId },
        });
        // O estado JÁ foi gravado; a linha com o autor, não. Reportar falha é a
        // única forma de o painel não mostrar "concluído" sem dizer quem — o
        // defeito que a sabotagem do #4717 reproduz (marcar sem autor/data).
        if (!atividade.ok) {
          return { ok: false, codigo: "falha", erro: atividade.error };
        }
      }
    }

    // A lista volta do SERVIDOR — o painel desenha o que o card gravou, não o
    // que o clique achou que gravou.
    const depois = await lerChecklistDoNegocio(db, { organizationId, leadId });
    if (!depois.ok) return { ok: false, codigo: "falha", erro: depois.erro };
    const item = depois.checklist?.itens.find((i) => i.tarefa_id === tarefaId);
    if (!depois.checklist || !item) {
      return { ok: false, codigo: "item_fora_do_checklist" };
    }
    return { ok: true, checklist: depois.checklist, item, anterior: tarefa.status };
  } catch (err) {
    return { ok: false, codigo: "falha", erro: mensagemDoErro(err) };
  }
}
