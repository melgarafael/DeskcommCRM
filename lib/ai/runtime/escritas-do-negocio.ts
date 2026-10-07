import type { McpToolDefinition } from "@/lib/mcp/types";

/** Só escritas com negócio explícito. Leituras e alvos indiretos não entram. */
export function chaveDaEscritaDoNegocio(
  organizationId: string,
  def: Pick<McpToolDefinition, "category" | "name">,
  args: Record<string, unknown>,
): string | null {
  if (def.category !== "write") return null;
  const leadId =
    typeof args.lead_id === "string"
      ? args.lead_id
      : def.name === "crm_manage_tags" &&
          args.target_kind === "lead" &&
          typeof args.target_id === "string"
        ? args.target_id
        : null;
  return leadId ? JSON.stringify([organizationId, leadId]) : null;
}

/** Uma fila por montagem de turno, nunca um lock global ou substituto da trava do banco. */
export function criarFilaDeEscritasDoNegocio() {
  const pendentes = new Map<string, Promise<void>>();
  return async function executar<T>(chave: string | null, operacao: () => Promise<T>): Promise<T> {
    if (chave === null) return operacao();
    const anterior = pendentes.get(chave) ?? Promise.resolve();
    const resultado = anterior.then(operacao);
    // Uma recusa não envenena as próximas chamadas, mas volta intacta a quem chamou.
    const fim = resultado.then(
      () => undefined,
      () => undefined,
    );
    pendentes.set(chave, fim);
    try {
      return await resultado;
    } finally {
      if (pendentes.get(chave) === fim) pendentes.delete(chave);
    }
  };
}
