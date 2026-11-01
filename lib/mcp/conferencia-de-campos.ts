/**
 * A PORTA DA CONFERÊNCIA (#2234) — onde `crm_update_lead` e `crm_create_lead` decidem se conferem.
 *
 * Três decisões moram aqui, e nenhuma é regra inventada: são as da issue,
 * postas no ponto em que elas valem.
 *
 *  1. **ORIGEM.** A conferência só existe para o AGENTE DE IA: papel
 *     `ai_operator` E contato do turno (`ctx.contatoDoTurno`, injetado só pela
 *     ponte do turno, `lib/ai/runtime/tools.ts`). Tela, API de terceiros e
 *     automação não passam por aqui — e não fazem NENHUMA leitura extra
 *     (catraca por origem, provada em `tests/unit/conferencia-de-campo-personalizado.test.ts`).
 *  2. **AS MENSAGENS.** As pendentes do turno = o último bloco de inbound,
 *     depois de pular as outbound do FIM — 1 a 3 mensagens, em geral. Pular o
 *     fim é o que serve aos dois papéis: o Conversador chama antes de responder
 *     (ou depois de já ter mandado algo no mesmo turno), e o Operador roda
 *     depois de a resposta sair (`operator-turn.ts`).
 *     Todas passam pelo `scrubMessage` ANTES de sair daqui: o texto que segue é
 *     o que o aceite cobre, e o que a linha em `jev_observacoes` nem vê.
 *  3. **RÓTULO DO FUNIL.** `campo.nome` é o label que o dono deu em
 *     `pipeline.settings.fields`; sem leitura (falhou, ou lead sem funil) vale a
 *     própria chave — nunca é motivo para não conferir.
 *
 * Tudo isto é fail-open por desenho: qualquer leitura que falhe devolve o
 * `custom_fields` intacto, sem conferência, com `estado` dizendo o porquê.
 */
import { conferirCamposDoNegocio, type CampoPersonalizado, type CampoRecusado } from "@/lib/ai/decisao/campo-do-negocio";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { estadoEfetivoDaTarefa, TAREFA_DA_CONFERENCIA_DE_CAMPO } from "@/lib/ai/decisao/tarefas";
import type { DependenciasDoPonto } from "@/lib/ai/decisao/ponto";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";
import {
  defsDoPadraoDoFunil,
  mensagemDaRecusa,
  recusasDePadrao,
  type DefComPadrao,
  type MotivoDoPadrao,
  type RecusaDePadrao,
} from "@/lib/leads/padrao-do-campo";
import { testaComPrazo } from "@/lib/leads/padrao-do-campo-no-servidor";
import { scrubMessage } from "@/lib/sentry/scrub";

import type { McpContext } from "./types";

/**
 * A origem é o AGENTE DE IA? Os dois juntos: o papel do turno (tela e token de
 * terceiro nunca são `ai_operator` sem serem o agente) e o contato do turno,
 * que só a ponte do atendimento injeta. Um token de API com papel de agente, vindo
 * de fora, não tem contato do turno — e sem contato não há conversa para conferir.
 */
export function origemEhAgenteDeIa(ctx: Pick<McpContext, "role" | "contatoDoTurno">): boolean {
  return ctx.role === "ai_operator" && ctx.contatoDoTurno !== undefined;
}

interface MensagemDoTurno {
  direction: string;
  body: string | null;
  media_derived_text: string | null;
  created_at: string;
}

/** Quantas mensagens recentes a leitura alcança — o turno cabe nelas com folga. */
const MENSAGENS_LIDAS = 50;

/**
 * As mensagens do cliente deste turno, passadas pelo `scrubMessage`: do mais
 * novo para trás, pula as outbound do fim (a resposta deste turno, que o
 * Operador já encontra enviada) e junta as inbound até a outbound anterior (a
 * resposta do turno de antes). A leitura é das `MENSAGENS_LIDAS` mais recentes:
 * em ordem crescente e sem limite, o PostgREST cortaria em 1000 linhas e as
 * "pendentes" de uma conversa longa sairiam das antigas. Falha de leitura
 * devolve lista vazia, e a conferência transforma isso em fail-open
 * (`sem_mensagens_do_turno`), nunca em veto.
 */
export async function mensagensPendentesDoTurno(
  ctx: McpContext,
): Promise<{ conversationId: string | null; mensagens: string[] }> {
  const contato = ctx.contatoDoTurno;
  if (!contato) return { conversationId: null, mensagens: [] };
  try {
    const { data: conversa, error } = await ctx.supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contato)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !conversa) return { conversationId: null, mensagens: [] };
    const conversationId = (conversa as { id: string }).id;
    const { data, error: msgErr } = await ctx.supabase
      .from("messages")
      .select("direction, body, media_derived_text, created_at")
      .eq("organization_id", ctx.organizationId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MENSAGENS_LIDAS);
    if (msgErr) return { conversationId, mensagens: [] };
    const linhas = (data ?? []) as MensagemDoTurno[];
    let i = 0;
    while (i < linhas.length && linhas[i]?.direction === "outbound") i += 1;
    const pendentes: string[] = [];
    for (; i < linhas.length; i += 1) {
      const m = linhas[i];
      if (m === undefined || m.direction === "outbound") break;
      const corpo = (m.body?.trim() ? m.body : m.media_derived_text) ?? "";
      if (corpo.trim() !== "") pendentes.unshift(corpo);
    }
    // Sem os perfis de país (#2418): a pergunta ao Jev leva o valor CRU, e um
    // `[CEP]` aqui faria a conferência recusar o CEP que o cliente digitou.
    return { conversationId, mensagens: pendentes.map((m) => scrubMessage(m, { perfisDePais: false })) };
  } catch {
    return { conversationId: null, mensagens: [] };
  }
}

/**
 * De onde sai o funil: o negócio que já existe (`crm_update_lead`) ou o funil
 * em que ele vai nascer (`crm_create_lead`, #2297 — ainda não há linha em
 * `crm_leads` para ler).
 */
export type AlvoDaConferencia = { leadId: string } | { pipelineId: string };

/**
 * O funil da conferência: rótulos (a #2234) e DEFINIÇÕES (o `padrao` da #2730),
 * das duas leituras de sempre — negócio (`crm_update_lead`) ou funil de
 * nascimento (`crm_create_lead`, #2297). Um só descer às linhas, porque as
 * duas coisas saem do MESMO `settings`, e descer duas vezes seria pagar o
 * custo da leitura por nada.
 */
interface FunilDaConferencia {
  rotulos: Map<string, string>;
  defs: DefComPadrao[];
}

async function funilDaConferencia(ctx: McpContext, alvo: AlvoDaConferencia): Promise<FunilDaConferencia> {
  try {
    let settings: unknown;
    if ("pipelineId" in alvo) {
      // O id vem do ARGUMENTO do modelo, não de uma linha da organização: o
      // filtro de organização aqui é o que impede o rótulo de um funil alheio
      // de voltar no erro de ensino (o client do turno é service-role).
      const { data, error } = await ctx.supabase
        .from("crm_pipelines")
        .select("settings")
        .eq("organization_id", ctx.organizationId)
        .eq("id", alvo.pipelineId)
        .maybeSingle();
      if (error || !data) return { rotulos: new Map(), defs: [] };
      settings = (data as { settings?: unknown }).settings;
    } else {
      const { data, error } = await ctx.supabase
        .from("crm_leads")
        .select("pipeline_id")
        .eq("organization_id", ctx.organizationId)
        .eq("id", alvo.leadId)
        .maybeSingle();
      if (error || !data) return { rotulos: new Map(), defs: [] };
      settings = await settingsDoFunil(ctx.supabase, (data as { pipeline_id?: string | null }).pipeline_id);
    }
    const defs = defsDoPadraoDoFunil(settings);
    return {
      rotulos: new Map(defs.map((c) => [c.key, c.label ?? c.key])),
      defs,
    };
  } catch {
    return { rotulos: new Map(), defs: [] };
  }
}

export interface ConferenciaDeCampos {
  /** `undefined` quando não havia `custom_fields` — o resto da escrita não muda. */
  custom_fields?: Record<string, unknown>;
  /** A de CONFERÊNCIA (#2234) e a de PADRÃO (#2730) — mesma forma, dois motivos. */
  recusados: RecusaDoTurno[];
  /** Por que não houve conferência, ou o estado em que ela rodou. */
  estado: string;
  /** `jev_*` quando o degrau 2 falhou (fail-open: o valor foi gravado mesmo assim). */
  error_code?: string;
}

const SEM_CONFERENCIA = (estado: string): ConferenciaDeCampos => ({ recusados: [], estado });

/**
 * Uma recusa do turno (#2730): a MESMA forma da `CampoRecusado` para quem
 * consome (`campo` + `mensagem` vai para o prompt em `tools/leads.ts`), com o
 * motivo do PRÓPRIO domínio — o union da #2234 (`cliente_nao_disse` /
 * `cliente_disse_o_contrario`) é do degrau 2 e não muda por causa disto.
 */
export interface RecusaDePadraoNoTurno {
  campo: string;
  motivo: MotivoDoPadrao;
  /** A frase que o MODELO recebe — nunca o texto do cliente. */
  mensagem: string;
}

export type RecusaDoTurno = CampoRecusado | RecusaDePadraoNoTurno;

/**
 * A frase do ERRO DE ENSINO de um campo fora do padrão: a do CAMPO (o que o
 * dono escreveu) mais a ordem que o modelo precisa — PERGUNTAR DE NOVO em vez
 * de gravar torto. É para o modelo ler, como todo texto de conferência da casa;
 * o que a PESSOA vê na tela vem de `mensagemDaRecusa`, sem esta costura.
 */
function mensagemDeErroDePadrao(recusa: RecusaDePadrao): string {
  const ordem =
    recusa.motivo === "padrao_invalido"
      ? "O PADRÃO do campo está inválido na configuração do funil: não dá para conferir nem para gravar. Não tente preenchê-lo — avise a pessoa e siga com os outros campos."
      : "O valor não confere com o PADRÃO do campo. Não grave assim: pergunte de novo à pessoa, citando a instrução acima, e só grave o que ela responder.";
  // O rótulo entra NA FRASE porque o modelo lê vários campos por vez: sem o
  // nome do campo, duas recusas seguidas viram duas instruções soltas.
  return `Campo «${recusa.rotulo}»: ${mensagemDaRecusa(recusa)} — ${ordem}`;
}

/** As chaves que sobram depois das recusas de padrão, na ordem original. */
function restantesSem(campos: Record<string, unknown>, recusados: readonly RecusaDePadrao[]) {
  const fora = new Set(recusados.map((r) => r.campo));
  return Object.fromEntries(Object.entries(campos).filter(([chave]) => !fora.has(chave)));
}

/** A recusa de padrão na forma do turno: `campo` + `mensagem`, já traduzida. */
function paraTurno(recusa: RecusaDePadrao): RecusaDePadraoNoTurno {
  return { campo: recusa.campo, motivo: recusa.motivo, mensagem: mensagemDeErroDePadrao(recusa) };
}

/**
 * Confere os `custom_fields` da chamada, se a origem for o agente de IA.
 * Nunca lança: falha aberto, com o campo gravado como hoje.
 *
 * Antes de TUDO (depois só da origem), roda o DEGRAU 0 — o padrão do campo
 * (#2730). Ele é determinístico e INDEPENDENTE do interruptor da conferência
 * (#2234, que nasce desligada): se o `padrao` dependesse do Jev, toda
 * organização que nunca ligou aquilo gravaria torto, que é o estado padrão do
 * produto. Ler o funil antes do degrau 2 custa a mesma linha que o rótulo já
 * custava — e quando a tarefa está desligada é a única leitura a mais.
 */
export async function conferirCamposPersonalizados(
  ctx: McpContext,
  alvo: AlvoDaConferencia,
  campos: Record<string, unknown> | undefined,
  deps: DependenciasDoPonto = {},
): Promise<ConferenciaDeCampos> {
  if (campos === undefined || Object.keys(campos).length === 0) return SEM_CONFERENCIA("nao_conferida");
  if (!origemEhAgenteDeIa(ctx)) return SEM_CONFERENCIA("nao_conferida");

  let config;
  try {
    const { data } = await ctx.supabase
      .from("organizations")
      .select("settings")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    config = lerConfigDoJev((data as { settings?: unknown } | null)?.settings ?? null);
  } catch {
    config = lerConfigDoJev(null);
  }

  // ── DEGRAU 0 (#2730): o padrão, com ou sem conferência ───────────────────
  const funil = await funilDaConferencia(ctx, alvo);
  const recusadosDePadrao = recusasDePadrao(funil.defs, campos, testaComPrazo);
  const restantes = restantesSem(campos, recusadosDePadrao);
  if (recusadosDePadrao.length > 0 && Object.keys(restantes).length === 0) {
    // Nada sobrou para perguntar: nem conversa, nem Jev. O motivo de gravar
    // zero é o FORMATO, e ele é do próprio produto.
    return { custom_fields: {}, recusados: recusadosDePadrao.map(paraTurno), estado: "fora_do_padrao" };
  }

  if (estadoEfetivoDaTarefa(config, TAREFA_DA_CONFERENCIA_DE_CAMPO) === "desligada") {
    return recusadosDePadrao.length > 0
      ? {
          custom_fields: restantes,
          recusados: recusadosDePadrao.map(paraTurno),
          estado: "desligada",
        }
      : SEM_CONFERENCIA("desligada");
  }

  const { conversationId, mensagens } = await mensagensPendentesDoTurno(ctx);
  const lista: CampoPersonalizado[] = Object.entries(restantes).map(([chave, valor]) => ({
    chave,
    nome: funil.rotulos.get(chave) ?? chave,
    valor,
  }));

  const r = await conferirCamposDoNegocio(
    ctx.supabase,
    {
      organizationId: ctx.organizationId,
      conversationId,
      contactId: ctx.contatoDoTurno ?? null,
      agentId: (ctx.actor as { agent_id?: string | null }).agent_id ?? null,
      campos: lista,
      mensagens,
      config,
    },
    deps,
  );

  const gravaveis = new Set(r.gravaveis);
  const finais = Object.fromEntries(Object.entries(restantes).filter(([chave]) => gravaveis.has(chave)));
  return {
    custom_fields: finais,
    recusados: [...recusadosDePadrao.map(paraTurno), ...r.recusados],
    estado: r.estado,
    ...(r.error_code === undefined ? {} : { error_code: r.error_code }),
  };
}
