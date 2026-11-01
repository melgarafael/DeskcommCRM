import type { ComponentType } from "react";

import {
  Bell,
  Brain,
  CalendarCheck,
  EnvelopeSimple,
  FlowArrow,
  Funnel,
  Kanban,
  ListChecks,
  PaperPlaneTilt,
  Play,
  Sparkle,
  Tag,
  UserCircle,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

import { ACTION_LABELS, type ActionType } from "../../../_components/labels";

/**
 * A cara de cada caixa do designer — o MESMO vocabulário visual do construtor
 * de follow-up (`app/app/ai/followups/[id]/_components/nodes/nodeVisuals.ts`):
 * chip de ícone com o par de tokens Sage do tipo e a borda esquerda na cor
 * dele. Onde a caixa é a mesma ideia do follow-up (gatilho, mensagem, tarefa,
 * tag, IA), o ícone e a cor também são os mesmos.
 */
export interface VisualDaCaixa {
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  chipClassName: string;
  borderClassName: string;
  /** Rótulo curto da paleta. O título da caixa é o rótulo completo da ação. */
  paleta: string;
}

const ACCENT = { chipClassName: "bg-accent-soft text-accent", borderClassName: "border-l-accent-500" };
const ACCENT_SOLIDO = { chipClassName: "bg-accent text-accent-foreground", borderClassName: "border-l-accent-700" };
const INFO = { chipClassName: "bg-info-bg text-info-fg", borderClassName: "border-l-info" };
const AVISO = { chipClassName: "bg-warning-bg text-warning-fg", borderClassName: "border-l-warning" };
const SUCESSO = { chipClassName: "bg-success-bg text-success-fg", borderClassName: "border-l-success" };

export const VISUAL_DO_GATILHO: VisualDaCaixa = { icon: Play, paleta: "Gatilho", ...ACCENT };
export const VISUAL_DAS_CONDICOES: VisualDaCaixa = { icon: Funnel, paleta: "Condições", ...AVISO };
/** O passo que hoje só nasce pela API: aparece, mas não está na paleta. */
export const VISUAL_DA_IA: VisualDaCaixa = { icon: Brain, paleta: "A IA decide", ...ACCENT_SOLIDO };

export const VISUAL_DA_ACAO: Record<ActionType, VisualDaCaixa> = {
  create_or_move_lead: { icon: Kanban, paleta: "Criar/mover lead", ...INFO },
  send_whatsapp_message: { icon: PaperPlaneTilt, paleta: "Mensagem no WhatsApp", ...SUCESSO },
  send_email: { icon: EnvelopeSimple, paleta: "Enviar e-mail", ...SUCESSO },
  send_ai_message: { icon: Sparkle, paleta: "Mensagem pela IA", ...ACCENT_SOLIDO },
  add_tag: { icon: Tag, paleta: "Adicionar tag", ...ACCENT },
  assign_owner: { icon: UserCircle, paleta: "Atribuir atendente", ...INFO },
  call_webhook: { icon: WebhooksLogo, paleta: "Avisar outro sistema", ...ACCENT },
  start_message_flow: { icon: FlowArrow, paleta: "Iniciar follow-up", ...SUCESSO },
  create_task: { icon: Bell, paleta: "Tarefa interna", ...AVISO },
  apply_task_plan: { icon: ListChecks, paleta: "Plano de tarefas", ...AVISO },
  // #3727 — a caixa que grava um dado em vez de falar: CalendarCheck porque o
  // dado é a data do COMPARECIMENTO, e INFO porque é escrita no card, não
  // mensagem (mesma família do "Criar/mover lead").
  set_lead_date_field: { icon: CalendarCheck, paleta: "Data do atendimento", ...INFO },
  // #2642 — o único destino que não é o lead: a EQUIPE. UsersThree porque quem
  // recebe é gente da casa (o WhatsApp cadastrado em Avisos), e SUCESSO
  // porque a caixa envia, como as
  // duas vizinhas de mensagem. Entrada exigida pelo Record<ActionType, …> da
  // main (o tipo ganhou `notify_team` neste PR).
  notify_team: { icon: UsersThree, paleta: "Mensagem para a equipe", ...SUCESSO },
};

/** A ordem da paleta: a mesma do seletor "Adicionar ação" do editor de hoje. */
export const ACOES_DA_PALETA = Object.keys(ACTION_LABELS) as ActionType[];

export function visualDaAcao(tipo: string): VisualDaCaixa {
  if (tipo === "ai_decide") return VISUAL_DA_IA;
  return VISUAL_DA_ACAO[tipo as ActionType] ?? { icon: Play, paleta: tipo, ...AVISO };
}
