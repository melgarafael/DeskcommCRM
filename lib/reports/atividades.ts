/**
 * O RELATÓRIO DE ATIVIDADES — a leitura do barramento no eixo do PERÍODO.
 *
 * ## A pergunta que este relatório responde
 *
 * Uma só: **"o que aconteceu na operação neste período, e quem fez cada
 * coisa — gente ou máquina?"**
 *
 * Ela está escrita aqui em cima porque um relatório que mostra tudo não
 * responde nada, e a pressão para acrescentar "mais uma coluna" é constante.
 * Número que não muda uma decisão é ruído (invariante 5): cada peça abaixo tem
 * de responder à pergunta ou sair.
 *
 * ## Por que a divisão gente × máquina é a espinha
 *
 * `crm_lead_activities.actor_kind` é o ÚNICO lugar do produto onde "isto foi um
 * agente decidindo sozinho" e "isto foi uma pessoa" convivem na mesma linha. O
 * `api_audit_log` conta chamadas de rota (e o motor do agente escreve por fora
 * do HTTP, então nem aparece lá); `/app/metrics` conta desfecho (ganho/perdido)
 * e não conta quem trabalhou. Sem esta divisão, um mês inteiro atendido pela IA
 * e um mês inteiro atendido pela equipe têm exatamente a mesma cara.
 *
 * ## Vocabulário: NENHUMA palavra de nicho mora aqui
 *
 * O rótulo do acontecimento vem de `ACTIVITY_LABELS` (fonte única de escrita e
 * leitura) e o nome do ator de `actorName`/`actorLabel`. A palavra do NEGÓCIO
 * vem do `vocabulary` do funil — clínica escreve "Paciente", imobiliária
 * escreve "Imóvel", e nenhuma delas precisa de código próprio. Esta é a razão
 * de o produto servir cinco nichos com o mesmo binário, e é o pilar que uma
 * extração de contribuição de um nicho não pode serrar.
 */
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { PipelineVocabulary } from "@/lib/kanban/types";
import { resolveVocabulary } from "@/lib/kanban/vocabulary";
import {
  activityLabel,
  actorName,
  actorShape,
  type ActivityActorShape,
} from "@/lib/leads/activity-vocabulary";

// ---------------------------------------------------------------------------
// O que `fn_activity_report` devolve (migration 0215) — identificadores, nunca
// nomes: quem sabe traduzir id em nome é a camada que também sabe degradar
// quando o nome falta.
// ---------------------------------------------------------------------------

export interface AtorBruto {
  actor_kind: string | null;
  user_id: string | null;
  agent_id: string | null;
  count: number;
}

export interface TipoBruto {
  type: string;
  count: number;
}

export interface DiaBruto {
  date: string;
  count: number;
}

export interface ItemBruto {
  id: string;
  type: string;
  performed_at: string;
  actor_kind: string | null;
  user_id: string | null;
  agent_id: string | null;
  reason: string | null;
  lead_id: string | null;
  lead_title: string | null;
  contact_id: string | null;
  contact_display_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
}

export interface RelatorioBruto {
  total: number;
  by_actor: AtorBruto[];
  by_type: TipoBruto[];
  daily: DiaBruto[];
  items: ItemBruto[];
  items_truncated: boolean;
}

// ---------------------------------------------------------------------------
// O que a tela consome
// ---------------------------------------------------------------------------

/**
 * As três ORIGENS do trabalho, e por que são três e não cinco.
 *
 * `actor_kind` tem cinco valores no banco (user/ai/system/rule/contact). Cinco
 * fatias numa barra não respondem "quanto disso foi gente" — obrigam quem lê a
 * somar de cabeça. A leitura grossa é: uma PESSOA do time agiu, um AGENTE agiu,
 * ou nem um nem outro (regra, produto, ou a própria pessoa atendida).
 */
export interface ResumoPorOrigem {
  pessoas: number;
  agentes: number;
  automatico: number;
}

export interface LinhaDeAtor {
  /** Estável para `key` de lista: a mesma tripla que o SQL agrupou. */
  chave: string;
  nome: string;
  actorKind: string | null;
  forma: ActivityActorShape;
  userId: string | null;
  agentId: string | null;
  quantidade: number;
  /** 0–100, já arredondado — a barra não recalcula nem inventa denominador. */
  fatia: number;
}

export interface LinhaDeTipo {
  type: string;
  rotulo: string;
  quantidade: number;
  fatia: number;
}

export interface LinhaDoDia {
  data: string;
  /** "03/09" — dia e mês, que é o que cabe embaixo de uma barra. */
  rotulo: string;
  quantidade: number;
}

export interface LinhaDeAtividade {
  id: string;
  type: string;
  rotulo: string;
  quando: string;
  atorNome: string;
  atorForma: ActivityActorShape;
  motivo: string | null;
  negocioId: string | null;
  negocioTitulo: string | null;
  contatoId: string | null;
  contatoNome: string | null;
}

export interface RelatorioDeAtividades {
  total: number;
  resumo: ResumoPorOrigem;
  atores: LinhaDeAtor[];
  tipos: LinhaDeTipo[];
  dias: LinhaDoDia[];
  atividades: LinhaDeAtividade[];
  /** A lista foi cortada — sem isto um período movimentado pareceria calmo. */
  truncado: boolean;
  /** Como esta organização chama um negócio (do `vocabulary` do funil). */
  vocabulario: Required<PipelineVocabulary>;
}

/** Nomes que a rota resolveu: id → como a pessoa/agente se chama. */
export interface NomesConhecidos {
  usuarios: Record<string, string | null>;
  agentes: Record<string, string | null>;
}

export interface ContextoDoRelatorio {
  nomes: NomesConhecidos;
  vocabulary: PipelineVocabulary | null | undefined;
  /** Tradutor da interface. Identidade por padrão — a função é pura. */
  t?: (texto: string) => string;
}

function fatiaDe(quantidade: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((quantidade / total) * 100);
}

/**
 * Uma PESSOA é `user`. Um AGENTE é `ai`. Todo o resto — `system`, `rule`,
 * `contact`, e o `null` de linhas anteriores à migration 0071 — é automático:
 * ninguém do time escolheu fazer aquilo.
 *
 * `contact` cai em "automático" e não em "pessoas" de propósito: a pergunta é
 * "o que a EQUIPE fez", e o cliente respondendo não é trabalho da equipe.
 */
function origemDoAtor(actorKind: string | null): keyof ResumoPorOrigem {
  if (actorKind === "user") return "pessoas";
  if (actorKind === "ai") return "agentes";
  return "automatico";
}

/** "2026-09-03" → "03/09". Sem `new Date`: a string já vem no fuso do leitor. */
export function rotuloDoDia(iso: string): string {
  const partes = iso.split("-");
  if (partes.length !== 3) return iso;
  return `${partes[2]}/${partes[1]}`;
}

/**
 * A janela do período, semiaberta [de, até). `dias` conta para TRÁS a partir de
 * `agora` — o relatório responde "esta semana", não "de tal dia a tal dia", e
 * um seletor de datas seria um controle a mais para a mesma resposta.
 */
export function janelaDoPeriodo(dias: number, agora: Date): { de: Date; ate: Date } {
  const ate = new Date(agora.getTime());
  const de = new Date(ate.getTime() - dias * 24 * 60 * 60 * 1000);
  return { de, ate };
}

/**
 * Fuso do navegador é entrada externa e vai para dentro de uma função SQL que
 * levanta exceção com nome inválido. Recusar aqui é mais barato que 500 lá.
 */
export function fusoValido(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function montarRelatorio(
  bruto: RelatorioBruto,
  ctx: ContextoDoRelatorio,
): RelatorioDeAtividades {
  const t = ctx.t ?? ((texto: string) => texto);
  const vocabulario = resolveVocabulary(ctx.vocabulary);

  const resumo: ResumoPorOrigem = { pessoas: 0, agentes: 0, automatico: 0 };
  for (const a of bruto.by_actor) {
    resumo[origemDoAtor(a.actor_kind)] += a.count;
  }

  const nomeDoAtor = (
    actorKind: string | null,
    userId: string | null,
    agentId: string | null,
  ): string =>
    actorName(
      actorKind,
      {
        agente: agentId ? ctx.nomes.agentes[agentId] : null,
        usuario: userId ? ctx.nomes.usuarios[userId] : null,
      },
      t,
    );

  const atores: LinhaDeAtor[] = bruto.by_actor.map((a) => ({
    chave: `${a.actor_kind ?? "-"}:${a.user_id ?? "-"}:${a.agent_id ?? "-"}`,
    nome: nomeDoAtor(a.actor_kind, a.user_id, a.agent_id),
    actorKind: a.actor_kind,
    forma: actorShape(a.actor_kind),
    userId: a.user_id,
    agentId: a.agent_id,
    quantidade: a.count,
    fatia: fatiaDe(a.count, bruto.total),
  }));

  const tipos: LinhaDeTipo[] = bruto.by_type.map((tp) => ({
    type: tp.type,
    rotulo: t(activityLabel(tp.type)),
    quantidade: tp.count,
    fatia: fatiaDe(tp.count, bruto.total),
  }));

  const dias: LinhaDoDia[] = bruto.daily.map((d) => ({
    data: d.date,
    rotulo: rotuloDoDia(d.date),
    quantidade: d.count,
  }));

  const atividades: LinhaDeAtividade[] = bruto.items.map((i) => ({
    id: i.id,
    type: i.type,
    rotulo: t(activityLabel(i.type)),
    quando: i.performed_at,
    atorNome: nomeDoAtor(i.actor_kind, i.user_id, i.agent_id),
    atorForma: actorShape(i.actor_kind),
    motivo: i.reason,
    negocioId: i.lead_id,
    negocioTitulo: i.lead_title,
    contatoId: i.contact_id,
    // Sem contato vinculado a linha não inventa um rótulo: `rotuloDoContato`
    // devolveria "Sem nome", que afirmaria existir alguém ali.
    contatoNome: i.contact_id
      ? rotuloDoContato({
          display_name: i.contact_display_name,
          name: i.contact_name,
          phone_number: i.contact_phone,
        })
      : null,
  }));

  return {
    total: bruto.total,
    resumo,
    atores,
    tipos,
    dias,
    atividades,
    truncado: bruto.items_truncated,
    vocabulario,
  };
}
