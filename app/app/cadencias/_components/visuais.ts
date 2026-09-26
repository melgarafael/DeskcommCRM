import type { ComponentType } from "react";

import type { CondicaoDoRamo, Passo, TipoDePasso } from "@/lib/cadencias/tipos";
import {
  CheckSquare,
  EnvelopeSimple,
  GitBranch,
  Hourglass,
  WhatsappLogo,
} from "@/lib/ui/icons";

export interface VisualDoPasso {
  rotulo: string;
  descricao: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  /** Faixa do cabeçalho do card — a cor é o que diferencia o tipo de relance. */
  cabecalho: string;
  chip: string;
}

export const VISUAL_DO_PASSO: Record<TipoDePasso, VisualDoPasso> = {
  email: {
    rotulo: "Enviar e-mail",
    descricao: "Um e-mail da caixa do vendedor, com variáveis do lead.",
    icon: EnvelopeSimple,
    cabecalho: "bg-info-bg text-info-fg border-b-info/30",
    chip: "bg-info-bg text-info-fg",
  },
  espera: {
    rotulo: "Aguardar",
    descricao: "Espera alguns dias úteis antes do próximo passo.",
    icon: Hourglass,
    cabecalho: "bg-surface-elevated text-text border-b-border",
    chip: "bg-surface-elevated text-text-muted",
  },
  ramo: {
    rotulo: "Ramificação se/então",
    descricao: "Divide o caminho conforme o lead abriu, clicou ou respondeu.",
    icon: GitBranch,
    cabecalho: "bg-accent-soft text-accent border-b-accent/30",
    chip: "bg-accent-soft text-accent",
  },
  whatsapp: {
    rotulo: "Enviar WhatsApp",
    descricao: "Mensagem automática no WhatsApp, se o lead tiver telefone.",
    icon: WhatsappLogo,
    cabecalho: "bg-success-bg text-success-fg border-b-success/30",
    chip: "bg-success-bg text-success-fg",
  },
  tarefa: {
    rotulo: "Criar tarefa",
    descricao: "Uma tarefa para o dono do lead, com prazo.",
    icon: CheckSquare,
    cabecalho: "bg-warning-bg text-warning-fg border-b-warning/30",
    chip: "bg-warning-bg text-warning-fg",
  },
};

export const ORDEM_DOS_TIPOS: TipoDePasso[] = ["email", "espera", "ramo", "whatsapp", "tarefa"];

type T = (texto: string) => string;

export function plural(n: number, um: string, varios: string): string {
  return n === 1 ? um : varios;
}

export function descreverCondicao(c: CondicaoDoRamo, t: T): string {
  const prazo = `${t("em até")} ${c.dentroDeDias} ${t(plural(c.dentroDeDias, "dia útil", "dias úteis"))}`;
  switch (c.tipo) {
    case "abriu":
      return `${t("Abriu o e-mail anterior")} ${c.vezes}+ ${t(plural(c.vezes, "vez", "vezes"))} ${prazo}`;
    case "clicou":
      return `${t("Clicou em um link do e-mail anterior")} ${prazo}`;
    case "respondeu":
      return `${t("Respondeu o e-mail")} ${prazo}`;
  }
}

/** A linha de resumo que aparece dentro do card. */
export function resumirPasso(p: Passo, t: T): string {
  switch (p.tipo) {
    case "email":
      if (p.mesmaConversa) return `${t("Resposta na mesma conversa")}${p.assunto ? ` · ${p.assunto}` : ""}`;
      return p.assunto.trim() || t("Sem assunto");
    case "espera":
      return `${p.diasUteis} ${t(plural(p.diasUteis, "dia útil", "dias úteis"))}`;
    case "ramo":
      return descreverCondicao(p.condicao, t);
    case "whatsapp":
      return p.mensagem.trim() || t("Mensagem ainda não escrita");
    case "tarefa":
      return p.titulo.trim() || t("Tarefa sem título");
  }
}
