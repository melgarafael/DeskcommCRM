import type { NavGroupId, NavMetadata } from "./catalogo";

/** Guidance links are always projected through the same permission-filtered catalog. */
export const JOURNEYS: Record<NavGroupId, { title: string; description: string; steps: string[] }> =
  {
    atendimento: {
      title: "Atenda com tudo à mão.",
      description: "Abra uma conversa, consulte o histórico e acompanhe o próximo contato.",
      steps: ["/app/inbox", "/app/contacts", "/app/agenda", "/app/radar"],
    },
    crm: {
      title: "Uma conversa pode virar uma venda.",
      description: "Organize as oportunidades no funil e registre o que precisa acontecer depois.",
      steps: ["/app/contacts", "/app/kanban", "/app/tasks", "/app/products"],
    },
    ia: {
      title: "Ensine uma vez. Aprimore sempre.",
      description:
        "Descreva o atendimento, adicione conhecimento e revise o agente antes de publicar.",
      steps: ["/app/ai/agents", "/app/ai/knowledge/sources", "/app/ai/inbox", "/app/ai/usage"],
    },
    canais: {
      title: "Cada conversa começa com uma conexão.",
      description: "Escolha o canal, siga a conexão e encontre as mensagens no Inbox.",
      steps: ["/app/connections", "/app/inbox", "/app/ai/agents"],
    },
    analise: {
      title: "Entenda o que pede sua atenção.",
      description: "Acompanhe os resultados e volte à conversa ou ao funil para agir.",
      steps: ["/app/metrics", "/app/activities", "/app/kanban", "/app/inbox"],
    },
    organizacao: {
      title: "Um espaço que funciona do seu jeito.",
      description: "Organize a equipe, ajuste o atendimento e cuide das permissões do seu negócio.",
      steps: [
        "/app/team",
        "/app/settings/atendimento",
        "/app/settings/security",
        "/app/settings/marca",
      ],
    },
  };

export function destinationForPath<T extends Pick<NavMetadata, "href">>(
  pathname: string,
  destinations: readonly T[],
): T | undefined {
  return destinations
    .filter((d) => pathname === d.href || (d.href !== "/app" && pathname.startsWith(d.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
