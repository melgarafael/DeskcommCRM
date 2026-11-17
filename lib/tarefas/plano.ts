/**
 * PLANO DE TAREFAS — a sequência reutilizável aplicada a um negócio (#1752).
 *
 * Processos comerciais se repetem ("proposta enviada → ligar em 2 dias →
 * mandar o caso de sucesso em 5 → cobrar em 10") e hoje cada tarefa nasce à
 * mão. Um PLANO guarda a sequência UMA vez; aplicar é um comando.
 *
 * ═══ ONDE O PLANO VIVE (e por que não é tabela) ═══
 *
 * `organizations.settings.task_plans` — JSONB da organização, coluna que já
 * existe, MESMO sítio onde o produto já guarda configuração por tenant em
 * lista (`settings.proposals.modelos_ocultos`,
 * `settings.canonical_conversation_tags`, `settings.lost_reasons` no funil).
 * As tabelas da proposta (`task_plans` + `task_plan_steps`) exigem a migration
 * triplice (migration + `baseline.sql` + `MANIFEST.md`), que esta entrega não
 * traz — declarado na issue, não escondido aqui. O custo honesto dessa escolha:
 * o plano é lido como JSON (uma leitura por aplicação, sem índice) e a
 * cadastros por tela ainda não existem.
 *
 * ═══ ONDE FICA A PROVA DE QUE JÁ FOI APLICADO ═══
 *
 * `crm_tasks` não tem coluna de origem (migration de novo), então a marca é
 * uma linha em `crm_lead_activities` com type `task_plan_applied` e
 * `payload.plano_id`. São duas vantagens numa só: a marca é DURÁVEL e com
 * identidade exata (nome de plano não é chave), e ao mesmo tempo entra na
 * linha do tempo do negócio — quem abre o card vê que a sequência rodou.
 *
 * A marca nasce DEPOIS das tarefas gravadas (nada de "aplicado" no timeline
 * sem tarefa nenhuma). O custo dessa ordem é declarado no PR: uma falha de
 * infra no MEIO da aplicação deixa as tarefas já criadas sem marca, e a
 * retomada recria os passos anteriores. Fechar essa janela é coluna
 * `plan_id` + constraint única — migration.
 *
 * Um módulo, DUAS portas como `criar-tarefa.ts`: a ação de automação
 * `apply_task_plan` (`lib/automation/actions/apply-task-plan.ts`) e quem mais
 * quiser aplicar um plano. A regra (leitura, idempotência, ordem) mora aqui
 * de propósito: dois executores escritos à mão divergiriam no primeiro
 * ajuste, e a divergência seria invisível — os dois "aplicam o plano", só que
 * um deles duplica tarefa.
 */
import { z } from "zod";

import type { Db } from "@/lib/db";
import {
  criarTarefaInterna,
  recusaDeConfiguracao,
  type AtribuicaoDaTarefa,
  type ContatoDoPedido,
  type LeadDoPedido,
} from "@/lib/tarefas/criar-tarefa";
import { insereAtividadeDoLead } from "@/lib/tarefas/atividade";
import { LIMITES_DO_PLANO } from "@/lib/tarefas/limites-do-plano";
import {
  MOTIVOS_SEM_PRAZO,
  camposDoNegocio,
  prazoDoPasso as prazoNormalizado,
  prazoDoPassoSchema,
  resolverPrazoDoCampo,
  type MotivoSemPrazo,
  type PrazoDoPasso,
} from "@/lib/tarefas/prazo-relativo";
import { PRIORIDADES_DA_TAREFA, type PrioridadeDaTarefa } from "@/lib/tarefas/tipos";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

/** Um passo, já normalizado: `ordem` SEMPRE preenchida com a posição final. */
export interface PassoDePlano {
  ordem: number;
  titulo: string;
  descricao: string | null;
  /**
   * De ONDE o prazo conta: da aplicação (`dias_a_partir_de_hoje`, o modo de
   * sempre) ou de um campo de data do card (`campo_de_data`, #4717 item 4).
   * Relativo sempre — data solta no plano envelhece no dia seguinte.
   */
  prazo: PrazoDoPasso;
  /**
   * Formato ANTIGO do prazo: N dias a partir da aplicação. Continua aceito na
   * LEITURA de `settings` gravado antes do #4717 item 4, e o schema normaliza
   * para `prazo` — quem grava usa `prazo`. A tela lê este campo para abrir um
   * plano antigo no seletor sem quebrar (`prazoNaTela`).
   */
  vence_em_dias?: number;
  prioridade: PrioridadeDaTarefa;
  atribuir_a: AtribuicaoDaTarefa;
}

export interface PlanoDeTarefas {
  id: string;
  nome: string;
  descricao: string | null;
  passos: PassoDePlano[];
}

/**
 * A forma que `organizations.settings.task_plans` precisa ter.
 *
 * Campos ausentes caem no valor que o operador teria escolhido por padrão
 * (`prioridade` média, `atribuir_a` no dono do negócio) e passo torto derruba
 * SÓ o plano que o contém: uma sequência mal escrita à mão não pode travar a
 * leitura de todas as outras — `settings` é JSON escrito por gente, não por
 * schema.
 */
const passoSchema = z
  .object({
    ordem: z.number().int().min(1).max(500).optional(),
    titulo: z.string().trim().min(1).max(LIMITES_DO_PLANO.tituloDoPasso),
    descricao: z.string().max(LIMITES_DO_PLANO.descricaoDoPasso).nullish(),
    /**
     * O modo de sempre — e o ÚNICO obrigatório até o #4717 item 4.
     *
     * Virou opcional porque o passo de campo de data mede o prazo por outro
     * relógio (a data do card), e exigir `vence_em_dias` junto seria gravar um
     * número que ninguém lê. Plano antigo continua válido: o campo está lá, e
     * `prazoDoPasso` o transforma em `{ modo: "dias_a_partir_de_hoje" }`.
     */
    vence_em_dias: z.number().int().min(0).max(LIMITES_DO_PLANO.venceEmDias).optional(),
    /** O prazo relativo a um campo de data do negócio. Ausente = modo de sempre. */
    prazo: prazoDoPassoSchema.optional(),
    prioridade: z.enum(PRIORIDADES_DA_TAREFA).default("medium"),
    atribuir_a: z
      .union([z.literal("dono_do_lead"), z.object({ usuario_id: z.string().uuid() })])
      .default("dono_do_lead"),
  })
  // Duas recusas, e as duas são de CONFIGURAÇÃO do passo, não do card: o passo
  // sem prazo nenhum nunca foi aceito, e o modo de campo sem a chave do campo
  // chegaria à aplicação como "sem prazo para sempre" — indistinguível, na
  // tela, de um card que só não preencheu o campo.
  .superRefine((passo, ctx) => {
    if (passo.prazo?.modo === "campo_de_data" && !passo.prazo.campo) {
      ctx.addIssue({
        code: "custom",
        path: ["prazo", "campo"],
        message: "passo_sem_campo_de_data",
      });
    }
    if (!passo.prazo && passo.vence_em_dias === undefined) {
      ctx.addIssue({ code: "custom", path: ["vence_em_dias"], message: "passo_sem_prazo" });
    }
    // O negativo só tem sentido contado de uma DATA do card ("7 dias antes da
    // viagem"). Contado da aplicação, -5 é tarefa que já nasce vencida — o
    // formato antigo (`vence_em_dias`, mínimo 0) nunca deixou, e a forma nova
    // não pode abrir pela API o que a tela e o formato antigo recusam.
    if (passo.prazo?.modo === "dias_a_partir_de_hoje" && passo.prazo.dias < 0) {
      ctx.addIssue({ code: "custom", path: ["prazo", "dias"], message: "prazo_negativo_sem_campo" });
    }
  });

export const planoSchema = z.object({
  id: z.string().trim().min(1).max(64),
  nome: z.string().trim().min(1).max(LIMITES_DO_PLANO.nome),
  descricao: z.string().max(LIMITES_DO_PLANO.descricao).nullish(),
  passos: z.array(passoSchema).min(1).max(LIMITES_DO_PLANO.passos),
});

/**
 * A LISTA na forma em que a rota de settings (`settings/task-plans`) aceita
 * gravar — um `planoSchema` por item, o MESMO que a leitura do motor aplica.
 *
 * Exportada porque a tela e o motor têm de recusar a mesma coisa: um plano que
 * `lePlanosDoSettings` descartaria jamais pode entrar pelo formulário. Escrito
 * duas vezes, os dois cadastros divergiriam no primeiro ajuste, e a divergência
 * seria invisível — os dois "validam o plano", só que um deixa passar o que o
 * outro ignora.
 */
export const planosSchema = z.array(planoSchema).max(LIMITES_DO_PLANO.planos);

/**
 * Lê `organizations.settings` e devolve SÓ os planos válidos, na ordem em que
 * a lista os declara (o `ordem` de cada passo decide a sequência interna).
 *
 * Nunca lança: `settings` pode ser `null`, ausente ou conter o que o operador
 * colou. Lista vazia = nenhum plano aplicável, que é uma resposta, não um
 * erro — quem chama decide se isso é recusa (`plano_nao_encontrado`).
 */
export function lePlanosDoSettings(settings: unknown): PlanoDeTarefas[] {
  const raiz =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as { task_plans?: unknown })
      : null;
  const bruto = raiz?.task_plans;
  if (!Array.isArray(bruto)) return [];

  return bruto.flatMap((item) => {
    const plano = planoSchema.safeParse(item);
    if (!plano.success) return [];

    // A ordem declarada vale; passo sem `ordem` fica na posição em que está.
    // Depois do ordenar, a `ordem` gravada É a posição — dois passos com o
    // mesmo número não podem mais existir, e a leitura bate com a escrita.
    const ordenados = plano.data.passos
      .map((passo, indice) => ({ passo, chave: passo.ordem ?? indice + 1 }))
      .sort((a, b) => a.chave - b.chave)
      .map(({ passo }) => passo);

    return [
      {
        id: plano.data.id,
        nome: plano.data.nome,
        descricao: plano.data.descricao ?? null,
        passos: ordenados.map((passo, indice) => {
          const prazo = prazoNormalizado(passo);
          return {
            ordem: indice + 1,
            titulo: passo.titulo,
            descricao: passo.descricao ?? null,
            prazo,
            // O GET de `settings/task-plans` sempre devolveu `vence_em_dias`, e
            // quem lê a API por fora conta com ele. No modo de sempre ele é o
            // MESMO número do `prazo`; no de campo de data não há número que o
            // signifique, e inventar um seria mentir o prazo.
            ...(prazo.modo === "dias_a_partir_de_hoje" ? { vence_em_dias: prazo.dias } : {}),
            prioridade: passo.prioridade,
            atribuir_a: passo.atribuir_a,
          };
        }),
      },
    ];
  });
}

export type CodigoDaAplicacao =
  /** O `plano_id` não está em `settings.task_plans` (nunca existe). */
  | "plano_nao_encontrado"
  /** Aplicar plano é aplicar a UM negócio: sem `leadId`, não há timeline nem dono. */
  | "sem_alvo"
  /** Os códigos de `criarTarefaInterna`, repassados intactos. */
  | "sem_dono"
  | "titulo_vazio"
  /** Falha de infra (leitura, INSERT ou a própria marca da aplicação). */
  | "falha";

export type ResultadoDaAplicacao =
  | { ok: true; ja_aplicado: boolean; tarefa_ids: string[] }
  | { ok: false; codigo: CodigoDaAplicacao; erro?: string };

export interface PedidoDeAplicacao {
  organizationId: string;
  /** O negócio onde a sequência vira tarefas. Obrigatório — ver `sem_alvo`. */
  leadId: string | null;
  /** `task_plans[].id`. */
  planoId: string;
  /** De onde veio: `automation:regra-1`, `tela:lead`, … — entra na marca. */
  origem: string;
  requestId?: string;
  /** Relógio fixo para o teste; o prazo de cada passo é contado daqui. */
  agora?: Date;
}

/**
 * Aplica o plano ao negócio: as tarefas NA ORDEM declarada, cada prazo
 * contado a partir de `agora`, e a marca da aplicação no fim.
 *
 * Idempotente pela marca: uma segunda chamada do MESMO `planoId` no MESMO
 * negócio devolve `ja_aplicado` e não escreve nada. `for` sequencial de
 * propósito — paralelizar gravaria as tarefas fora da ordem que o operador
 * leu, e a ordem é metade do contrato de um plano.
 */
export async function aplicarPlanoDeTarefas(
  db: Db,
  pedido: PedidoDeAplicacao,
): Promise<ResultadoDaAplicacao> {
  const { organizationId, leadId, planoId, origem, requestId, agora } = pedido;
  if (!leadId) return { ok: false, codigo: "sem_alvo" };

  let organizacao: { settings?: unknown; timezone?: string | null } | null;
  try {
    // O `timezone` vem na MESMA leitura: o prazo de um passo de campo de data é
    // dia de calendário do tenant (#4717 item 4), e uma segunda ida ao banco
    // abriria a janela em que o fuso muda entre a leitura e a conta.
    organizacao = await db.queryOne<{ settings?: unknown; timezone?: string | null }>(
      `select settings, timezone
         from organizations
        where id = $1
        limit 1`,
      [organizationId],
    );
  } catch (err) {
    return { ok: false, codigo: "falha", erro: mensagemDoErro(err) };
  }

  const plano = lePlanosDoSettings(
    (organizacao as { settings?: unknown } | null)?.settings,
  ).find(
    (p) => p.id === planoId,
  );
  if (!plano) return { ok: false, codigo: "plano_nao_encontrado" };

  const marca = await jaFoiAplicado(db, organizationId, leadId, planoId);
  if (marca.erro) return { ok: false, codigo: "falha", erro: marca.erro };
  if (marca.ja) return { ok: true, ja_aplicado: true, tarefa_ids: [] };

  // ═══ O plano INTEIRO contra o negócio ANTES do primeiro INSERT ═══
  //
  // A recusa por configuração (`sem_dono`, `titulo_vazio`) acontecia DENTRO do
  // laço: um plano com um passo recusável no meio criava os passos anteriores
  // e saía sem a marca, então cada disparo novo recriava a mesma sobra — dois
  // disparos, duas tarefas órfãs para a pessoa apagar. Medido na revisão do
  // #2213; o teste `plano [usuario_id, dono_do_lead]` num negócio sem dono,
  // aplicado 2×, tem de dar 0 tarefa nas DUAS vezes.
  //
  // A ordem das perguntas é a do laço (passo a passo, `sem_dono` antes de
  // `titulo_vazio`): o código que volta é o MESMO que voltaria antes, só que
  // sem nada gravado. `recusaDeConfiguracao` é a própria regra de
  // `criarTarefaInterna` — as duas portas não podem divergir.
  const negocio = await lerNegocioDoPlano(db, organizationId, leadId);
  if (negocio.erro) return { ok: false, codigo: "falha", erro: negocio.erro };
  const lead = negocio.lead;
  if (!lead) return { ok: false, codigo: "sem_alvo" };

  const contactId = lead.contact_id ?? null;
  const contato = contactId
    ? await lerContatoDoPlano(db, organizationId, contactId)
    : null;

  for (const passo of plano.passos) {
    const recusa = recusaDeConfiguracao(passo.atribuir_a, passo.titulo, { lead, contact: contato });
    if (recusa) return { ok: false, codigo: recusa };
  }

  const fuso = fusoUtilizavel(
    (organizacao as { timezone?: string | null } | null)?.timezone,
  );
  const campos = camposDoNegocio(lead.custom_fields);
  const tarefa_ids: string[] = [];
  /**
   * Os passos que nasceram SEM prazo, com o campo que faltou.
   *
   * Não é log: vai no `payload` da marca e no `reason` da linha do tempo, que é
   * a tela onde quem abriu o card lê o que aconteceu. Sem isso, a tarefa sem
   * prazo é indistinguível de uma tarefa criada sem prazo por escolha — e
   * ninguém vai olhar o campo do card para descobrir o que faltou.
   */
  const semPrazo: Array<{ ordem: number; campo: string; motivo: MotivoSemPrazo }> = [];
  for (const passo of plano.passos) {
    const comum = {
      organizationId,
      titulo: passo.titulo,
      descricao: passo.descricao,
      atribuirA: passo.atribuir_a,
      prioridade: passo.prioridade,
      leadId,
      origem,
      plano: {
        id: plano.id,
        passo: passo.ordem,
        campo: passo.prazo.modo === "campo_de_data" ? passo.prazo.campo : null,
        dias: passo.prazo.dias,
      },
      ...(requestId ? { requestId } : {}),
      ...(agora ? { agora } : {}),
    };

    // O prazo sai de um relógio ou do outro, nunca dos dois: passo de campo de
    // data NÃO usa `agora` (é justamente o que o modo antigo não sabia fazer).
    let resultado: Awaited<ReturnType<typeof criarTarefaInterna>>;
    if (passo.prazo.modo === "campo_de_data") {
      const resolvido = await resolverPrazoDoCampo(db, {
        campo: passo.prazo.campo,
        dias: passo.prazo.dias,
        campos,
        fuso,
      });
      if (resolvido.motivo) {
        semPrazo.push({ ordem: passo.ordem, campo: passo.prazo.campo, motivo: resolvido.motivo });
      }
      resultado = await criarTarefaInterna(db, {
        ...comum,
        venceEm: resolvido.venceEm,
        prazoMotivo: resolvido.motivo,
      });
    } else {
      resultado = await criarTarefaInterna(db, { ...comum, venceEmDias: passo.prazo.dias });
    }
    if (!resultado.ok) return { ok: false, codigo: resultado.codigo, erro: resultado.erro };
    tarefa_ids.push(resultado.tarefa_id);
  }

  const gravada = await insereAtividadeDoLead(db, {
    organizationId,
    leadId,
    type: "task_plan_applied",
    sourceModule: "tarefas",
    sourceId: null,
    actor: { type: "webhook_source", id: origem },
    // O motivo de um passo sem prazo entra no MESMO texto que a pessoa lê na
    // linha do tempo do negócio: campo de data é configuração do funil, não
    // dado do cliente, e o operador precisa saber QUAL campo preencher para a
    // tarefa ganhar prazo. O valor do campo NUNCA entra aqui (§9).
    reason: `Plano «${plano.nome}» aplicado (${plano.passos.length} tarefas)${
      semPrazo.length > 0
        ? `; ${semPrazo.length} passo(s) sem prazo: ${semPrazo
            .map((s) => `«${s.campo}» ${s.motivo === MOTIVOS_SEM_PRAZO.campoInvalido ? "com valor que não é data" : "vazio"}`)
            .join(", ")}`
        : ""
    }`,
    payload: {
      plano_id: plano.id,
      plano_nome: plano.nome,
      passos: plano.passos.length,
      tarefa_ids,
      ...(semPrazo.length > 0 ? { sem_prazo: semPrazo } : {}),
    },
  });
  // A marca É a idempotência: sem ela, a próxima aplicação duplica o que já
  // existe. Diferente do audit (fire-and-forget), este erro não pode ser
  // engolido em silêncio — é reportado como `falha` para o operador ver.
  if (!gravada.ok) return { ok: false, codigo: "falha", erro: gravada.error };

  return { ok: true, ja_aplicado: false, tarefa_ids };
}

/**
 * Já existe a marca deste plano neste negócio?
 *
 * O filtro por tipo e negócio sai da query; o `plano_id` é conferido aqui
 * dentro porque ele mora dentro do `payload` (jsonb) — e a lista de marcas de
 * UM negócio é curta, não vale operador Postgres por causa dela.
 */
async function jaFoiAplicado(
  db: Db,
  organizationId: string,
  leadId: string,
  planoId: string,
): Promise<{ ja: boolean; erro?: string }> {
  let linhas: Array<{ payload?: { plano_id?: unknown } }>;
  try {
    linhas = await db.query<{ payload?: { plano_id?: unknown } }>(
      `select payload
         from crm_lead_activities
        where organization_id = $1
          and lead_id = $2
          and type = $3
        limit 200`,
      [organizationId, leadId, "task_plan_applied"],
    );
  } catch (err) {
    return { ja: false, erro: mensagemDoErro(err) };
  }

  const ja = linhas.some((linha) => linha.payload?.plano_id === planoId);
  return { ja };
}

/** Mensagem crua do driver — o `erro` que o operador vê no `detail` da ação. */
function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * O negócio do plano, na organização do pedido.
 *
 * Erro de leitura é `falha` (infra) — aqui o PostgREST ANTIGO também
 * distinguia, ao contrário da leitura tolerante de `criar-tarefa.ts`.
 */
async function lerNegocioDoPlano(
  db: Db,
  organizationId: string,
  leadId: string,
): Promise<{ lead: LeadDoPedido | null; erro?: string }> {
  try {
    const lead = await db.queryOne<LeadDoPedido>(
      `select id, title, contact_id, owner_user_id, custom_fields
         from crm_leads
        where id = $1
          and organization_id = $2
        limit 1`,
      [leadId, organizationId],
    );
    return { lead };
  } catch (err) {
    return { lead: null, erro: mensagemDoErro(err) };
  }
}

/**
 * O contato do negócio. Erro é tolerado (vira `null`), como era com o
 * `.maybeSingle()` — o contato só serve para interpolar `{{contact.name}}`, e
 * um contato ilegível recusa o passo por `titulo_vazio`, nunca grava torto.
 */
async function lerContatoDoPlano(
  db: Db,
  organizationId: string,
  contactId: string,
): Promise<ContatoDoPedido | null> {
  try {
    return await db.queryOne<ContatoDoPedido>(
      `select id, name, display_name
         from contacts
        where id = $1
          and organization_id = $2
        limit 1`,
      [contactId, organizationId],
    );
  } catch {
    return null;
  }
}
