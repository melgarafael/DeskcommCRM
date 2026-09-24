import type { ComponentType } from "react";

import { Play, Clock, GitBranch, Brain, ChatCircle, ArrowsClockwise, PaperPlaneTilt, Flag } from "@/lib/ui/icons";
import type { FlowNode, NodeType } from "@/lib/followup/graph-schema";
import { RESULTADOS_DO_FIM } from "@/lib/followup/vocabulario";

/**
 * Visual identity per node type — shared by the palette (Task 6.2 increment 2)
 * and the custom node cards (increment 3). Each type gets a DISTINCT icon +
 * Sage token pairing (never a bare default React Flow box): trigger=accent
 * (start), wait=info (calm/waiting), condition=warning (branch), ai_classify=
 * solid accent (the "smart" step), action=success (send/go), end=error
 * (terminal — reads as "stop", not literally an error).
 */
export interface NodeVisual {
  type: NodeType;
  paletteLabel: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  /** Icon chip background + text. */
  chipClassName: string;
  /** Left accent border on the node card. */
  borderClassName: string;
  defaultLabel: string;
  defaultConfig: () => FlowNode["config"];
}

type RegraDeCondicao = Extract<FlowNode, { type: "condition" }>["config"]["checks"][number];

/**
 * A regra com que o nó de condição nasce, e a que o "+ Condição" acrescenta.
 *
 * Era `passos ≥ 0` — válida no schema e VERDADEIRA PARA TODO LEAD (o contador
 * nasce em zero e só soma). No modo uma-saída-por-regra ela desviava todo mundo
 * e tornava "Nenhuma delas" inalcançável; num OU, fixava o nó em "Sim". E o card
 * a mostrava com cara de regra pronta.
 *
 * Agora nasce INCOMPLETA de propósito: o schema aceita (o rascunho salva), o
 * motor nunca a satisfaz e o publish a recusa até alguém escolher a etapa. Etapa
 * porque é a pergunta mais comum de um funil — e a que o seletor responde sem
 * digitar nada.
 */
export function regraEmBranco(): RegraDeCondicao {
  return { field: "lead_stage", op: "eq", value: "" };
}

/**
 * Nó de mensagem novo: IA, salvo o gatilho de retorno — ali o padrão é texto
 * fixo, porque a saudação de quem voltou não pede o LLM (e duas vozes
 * nasceriam se o default fosse `ai_message` + o turno inbound).
 */
export function configPadraoDaAcao(triggerKind?: string): FlowNode["config"] {
  if (triggerKind === "inbound_after_silence") {
    return { mode: "text", body: "Configure esta mensagem." };
  }
  return { mode: "ai_message", prompt_hint: "Configure esta etapa." };
}

export const NODE_VISUALS: Record<NodeType, NodeVisual> = {
  trigger: {
    type: "trigger",
    paletteLabel: "Gatilho",
    icon: Play,
    chipClassName: "bg-accent-soft text-accent",
    borderClassName: "border-l-accent-500",
    defaultLabel: "Início do fluxo",
    defaultConfig: () => ({}),
  },
  wait: {
    type: "wait",
    paletteLabel: "Aguardar",
    icon: Clock,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Aguardar",
    defaultConfig: () => ({ mode: "fixed", duration_ms: 300_000 }),
  },
  condition: {
    type: "condition",
    paletteLabel: "Condição",
    icon: GitBranch,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Verificar condição",
    defaultConfig: () => ({ combinator: "and", checks: [regraEmBranco()] }),
  },
  ai_classify: {
    type: "ai_classify",
    paletteLabel: "Classificar (IA)",
    icon: Brain,
    chipClassName: "bg-accent text-accent-foreground",
    borderClassName: "border-l-accent-700",
    defaultLabel: "Classificar resposta",
    defaultConfig: () => ({
      // Em português, e dizendo o CRITÉRIO: estes nomes são a definição inteira
      // que o modelo recebe para classificar a resposta (`followup-flow-classify`),
      // e aparecem crus na saída do card, na aresta e no dossiê. "hot"/"cold"
      // pedia ao dono da loja que adivinhasse o critério — e ao modelo também.
      // Fora do dicionário de propósito: são DADO do usuário, e uma chave faria
      // o card traduzir o que o motor compara ao pé da letra.
      classes: ["Interessado", "Sem interesse"],
      grace_timeout_ms: 900_000,
      target: "last_reply",
    }),
  },
  match_reply: {
    type: "match_reply",
    paletteLabel: "Resposta (texto)",
    icon: ChatCircle,
    chipClassName: "bg-info-bg text-info-fg",
    borderClassName: "border-l-info",
    defaultLabel: "Casar resposta",
    defaultConfig: () => ({
      branches: [{ id: "br_sim", label: "Sim", op: "contains", pattern: "sim" }],
      grace_timeout_ms: 900_000,
    }),
  },
  repeat: {
    type: "repeat",
    paletteLabel: "Repetir",
    icon: ArrowsClockwise,
    chipClassName: "bg-warning-bg text-warning-fg",
    borderClassName: "border-l-warning",
    defaultLabel: "Repetir pela resposta",
    defaultConfig: () => ({ max_count: 12 }),
  },
  action: {
    type: "action",
    paletteLabel: "Ação",
    icon: PaperPlaneTilt,
    chipClassName: "bg-success-bg text-success-fg",
    borderClassName: "border-l-success",
    defaultLabel: "Enviar mensagem",
    defaultConfig: () => configPadraoDaAcao(),
  },
  end: {
    type: "end",
    paletteLabel: "Fim",
    icon: Flag,
    chipClassName: "bg-error-bg text-error-fg",
    borderClassName: "border-l-error",
    defaultLabel: "Fim do fluxo",
    defaultConfig: () => ({ outcome: "exhausted" }),
  },
};

export const NODE_VISUAL_LIST = Object.values(NODE_VISUALS);

type ConfigOf<T extends NodeType> = Extract<FlowNode, { type: T }>["config"];

/** "15 min", com espaço — o mesmo formato do card de espera, que dizia "5 min" enquanto este dizia "15min". */
function minutos(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * One-line summary of a node's config — shown as the card subtitle. Takes the
 * RF node's own `type`/`data.config` pair (not a reconstructed `FlowNode`)
 * because the node components only ever see React Flow's generic shape.
 */
export function describeNodeConfig(
  type: NodeType,
  config: FlowNode["config"],
  // `t` OBRIGATÓRIO. Era opcional com padrão identidade, e foi assim que dois
  // cards que chegaram por outra branch (repetir e casar resposta) ficaram sem
  // tradução nenhuma sem o typecheck notar: em português o padrão devolve o
  // mesmo texto, então o esquecimento só aparecia para quem usa espanhol.
  t: (texto: string) => string,
): string {
  switch (type) {
    case "trigger":
      return t("Início do fluxo");
    case "wait": {
      const c = config as ConfigOf<"wait">;
      return c.mode === "fixed"
        ? minutos(c.duration_ms)
        : `${Math.round(c.min_ms / 60_000)}–${minutos(c.max_ms)} ${t("(adaptativo)")}`;
    }
    case "condition": {
      const c = config as ConfigOf<"condition">;
      // No modo uma-saída-por-regra o combinador NÃO é consultado (a regra não
      // vota, ela roteia). Continuar anunciando "E"/"OU" ali seria o card
      // afirmando uma coisa que o motor ignora — e o usuário acredita no card.
      if (c.branching === "per_check")
        return `${c.checks.length} ${c.checks.length === 1 ? t("regra · uma saída por regra") : t("regras · uma saída por regra")}`;
      return `${c.checks.length} ${c.checks.length === 1 ? t("condição") : t("condições")} · ${c.combinator === "and" ? t("E") : t("OU")}`;
    }
    // "grace" é o nome do CAMPO, não palavra nenhuma para quem tem uma loja — e o
    // formulário do mesmo nó já perguntava "Esperar a resposta por (minutos)".
    // O card dizia o número com dois nomes na mesma tela.
    case "ai_classify": {
      const c = config as ConfigOf<"ai_classify">;
      return `${c.classes.length} ${c.classes.length === 1 ? t("classe · espera") : t("classes · espera")} ${minutos(c.grace_timeout_ms)}`;
    }
    case "match_reply": {
      const c = config as ConfigOf<"match_reply">;
      return `${c.branches.length} ${c.branches.length === 1 ? t("regra · espera") : t("regras · espera")} ${minutos(c.grace_timeout_ms)}${
        c.save_to
          ? ` · ${t("grava resposta")}${c.if_exists === "skip" ? ` · ${t("pula se já existir")}` : c.if_exists === "confirm" ? ` · ${t("confirma se já existir")}` : ""}`
          : ""
      }`;
    }
    case "repeat": {
      const c = config as ConfigOf<"repeat">;
      return `${t("até")} ${c.max_count} ${c.max_count === 1 ? t("volta") : t("voltas")}`;
    }
    case "action": {
      const c = config as ConfigOf<"action">;
      if (c.mode === "ai_message") return c.prompt_hint;
      if (c.mode === "text") return c.body;
      return t("Template fixo");
    }
    case "end": {
      const c = config as ConfigOf<"end">;
      return t(RESULTADOS_DO_FIM[c.outcome]);
    }
    default: {
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}
