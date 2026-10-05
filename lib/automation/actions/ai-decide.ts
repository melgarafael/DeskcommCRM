/**
 * Ação `ai_decide` — o passo de decisão por IA das automações (#1970).
 *
 * Todas as irmãs executam UMA ação fixa declarada no schema. Esta lê o
 * contexto da regra, pergunta ao agente qual das opções montadas pelo operador
 * vale aqui, e dispara a AÇÃO-ALVO da opção escolhida — pelo registro de
 * executores que o motor já usa (`getAction`), sem caminho novo para executar
 * nada: o que a IA escolhe é uma das ações fixas que existiam antes desta.
 *
 * ─── O que ela NÃO faz ──────────────────────────────────────────────────────
 *
 *  - Não executa nada sem escolha válida. Resposta vazia, prosa sem JSON, JSON
 *    sem `escolha` e `escolha` fora do conjunto viram `failed` com o motivo no
 *    run — nunca um default, nunca o primeiro item. Escolher no lugar da IA é
 *    transformar decisão em adivinhação silenciosa.
 *  - Não gasta token sem registro. O schema exige `custo_de_token: true`
 *    (literal, não booleano opiniável) e esta ação confere de novo aqui: sem o
 *    registro explícito, `skipped` com motivo, e o modelo nem é consultado.
 *  - Não decide sozinha quem recebe. O `postponeUntil` das ações-alvo (janela
 *    do número, cap diário, espaçamento) roda ANTES da chamada de modelo: se
 *    QUALQUER opção adiaria, o evento inteiro adia — a mesma régua
 *    all-or-nothing do motor, e a segunda razão de não gastar token à toa.
 *
 * Anti-laço (#1528): quem olha é o motor, e `acoesQueFechamLaco` enxerga
 * DENTRO de `config.opcoes` — opção que regrava o lead no gatilho que regrava
 * lead recusa a regra na porta e recusa a execução no motor.
 */
import { getAction, registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import type { OpcaoDeDecisao } from "@/lib/automation/decider";
import { decidirAcao } from "@/lib/agent-engine/agent/decisao-de-acao";
import { logger } from "@/lib/logger";

const TIPO = "ai_decide";

interface OpcaoCrua {
  id?: unknown;
  rotulo?: unknown;
  acao?: { type?: unknown; config?: unknown } | null;
}

/**
 * As opções como gravadas, validadas na mão.
 *
 * O schema já recusou na porta; aqui é defesa em profundidade (a regra pode
 * chegar por SQL ou import) E a passagem para o tipo que o decidor espera.
 * `null` = config ilegível: o execute recusa, nunca improvisa opção.
 */
function lerOpcoes(config: Record<string, unknown>): OpcaoDeDecisao[] | null {
  const brutas = config.opcoes;
  if (!Array.isArray(brutas) || brutas.length < 2) return null;
  const opcoes: OpcaoDeDecisao[] = [];
  for (const item of brutas as OpcaoCrua[]) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const rotulo = typeof item?.rotulo === "string" ? item.rotulo.trim() : "";
    const tipo = typeof item?.acao?.type === "string" ? item.acao.type : "";
    if (!id || !rotulo || !tipo) return null;
    const configDaAcao =
      item.acao?.config && typeof item.acao.config === "object"
        ? (item.acao.config as Record<string, unknown>)
        : {};
    opcoes.push({ id, rotulo, acao: { type: tipo, config: configDaAcao } });
  }
  if (new Set(opcoes.map((o) => o.id)).size !== opcoes.length) return null;
  return opcoes;
}

/** Contato do contexto — `leadId` do seam (nunca o id do lead, que não é contato). */
function contatoDoContexto(ctx: ActionCtx): string | null {
  const contato = ctx.context.contact as { id?: unknown } | undefined;
  if (contato && typeof contato.id === "string") return contato.id;
  const lead = ctx.context.lead as { contact_id?: unknown } | undefined;
  return lead && typeof lead.contact_id === "string" ? lead.contact_id : null;
}

/**
 * Pré-checagem do motor: o evento NÃO pode disparar a decisão (nem o modelo)
 * enquanto qualquer opção-alvo estiver fora da janela de envio.
 *
 * Conservadora de propósito: o motor ainda não sabe o que a IA escolheria, e
 * adiar é reversível enquanto enviar fora da janela não é. O custo é esperar
 * quando a escolha certa seria uma ação sem janela — menor que o contrário.
 */
async function postponeUntil(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null> {
  const opcoes = lerOpcoes(config);
  if (!opcoes) return null; // config inválida falha no execute, não adia
  for (const opcao of opcoes) {
    const alvo = getAction(opcao.acao.type);
    if (!alvo?.postponeUntil) continue;
    const ate = await alvo.postponeUntil(ctx, opcao.acao.config ?? {});
    if (ate) return ate;
  }
  return null;
}

async function execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail> {
  // O registro EXPLÍCITO do custo (#1970) — sem ele, nem pergunta à IA.
  if (config.custo_de_token !== true) {
    return { type: TIPO, status: "skipped", detail: { reason: "custo_de_token_nao_registrado" } };
  }
  const instrucao = typeof config.instrucao === "string" ? config.instrucao.trim() : "";
  const opcoes = lerOpcoes(config);
  if (!instrucao || !opcoes) {
    return { type: TIPO, status: "failed", error: "config_invalida", detail: { reason: "config_invalida" } };
  }

  // ─── A decisão ────────────────────────────────────────────────────────────
  // O ÚNICO ponto que gasta token. Erro aqui (pool ausente, orçamento estourado,
  // provedor fora) vai inteiro para o run — mesma disciplina de send_ai_message.
  let decisao: Awaited<ReturnType<typeof decidirAcao>>;
  try {
    decisao = await decidirAcao({
      tenantId: ctx.organizationId,
      leadId: contatoDoContexto(ctx),
      instrucao,
      opcoes,
      contexto: ctx.context,
    });
  } catch (err) {
    const causa = err instanceof Error ? err.message : String(err);
    logger.error("[automation.ai_decide] a IA não conseguiu decidir", {
      organizationId: ctx.organizationId,
      ruleId: ctx.ruleId,
      causa,
    });
    return { type: TIPO, status: "failed", error: causa };
  }

  // Resposta inválida: NADA executa, e o motivo fica no run. Sem default,
  // sem "escolhe a primeira", sem retry implícito — o operador precisa ver que
  // a decisão não aconteceu para corrigir a instrução.
  if (!decisao.ok) {
    return { type: TIPO, status: "failed", error: decisao.motivo, detail: { reason: decisao.motivo } };
  }

  // ─── A ação-alvo ──────────────────────────────────────────────────────────
  const opcao = opcoes.find((o) => o.id === decisao.escolha);
  if (!opcao) {
    // inalcançável pelo decidor (só devolve id das opções) — mas é exatamente o
    // caso em que adivinhar custaria executar a ação de outra opção.
    return { type: TIPO, status: "failed", error: "escolha_fora_do_conjunto", detail: { reason: "escolha_fora_do_conjunto" } };
  }
  const executor = opcao.acao.type === TIPO ? undefined : getAction(opcao.acao.type);
  if (!executor) {
    return {
      type: TIPO,
      status: "failed",
      error: "acao_alvo_desconhecida",
      detail: { reason: "acao_alvo_desconhecida", escolha: opcao.id },
    };
  }

  let resultado: ActionResultDetail;
  try {
    resultado = await executor.execute(ctx, opcao.acao.config ?? {});
  } catch (err) {
    return {
      type: TIPO,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      detail: { escolha: opcao.id, acao_alvo: opcao.acao.type },
    };
  }

  // O resultado é o da ação-alvo (honestidade do agregador: se ela pulou, nada
  // saiu), com a escolha ao lado — sem ela, quem lê a aba Atividade vê "add_tag"
  // e não tem como saber que a IA escolheu aquilo entre as opções da regra.
  return {
    ...resultado,
    type: TIPO,
    detail: { ...(resultado.detail ?? {}), escolha: opcao.id, rotulo: opcao.rotulo, acao_alvo: opcao.acao.type },
  };
}

registerAction({ type: TIPO, postponeUntil, execute });
