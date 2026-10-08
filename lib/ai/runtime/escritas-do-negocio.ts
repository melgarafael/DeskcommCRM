import type { McpToolDefinition } from "@/lib/mcp/types";
import { EPHEMERAL_TOKEN_TTL_SEC } from "@/lib/ai/runtime/prazo-do-token-mcp";

/** O retorno não espera além da janela padrão da credencial do turno. */
export const PRAZO_ESCRITA_NEGOCIO_MS = EPHEMERAL_TOKEN_TTL_SEC * 1000;

export class EscritaDoNegocioSemDesfechoError extends Error {
  constructor() {
    super("lead_write_outcome_unknown");
  }
}

// Só operações que excederam o prazo. Outra montagem/turno deste processo
// também recusa a chave até TODOS esses handlers completos assentarem.
const semDesfecho = new Map<string, Set<Promise<void>>>();

function conservarPendencia(chave: string, fim: Promise<void>) {
  const pendencias = semDesfecho.get(chave) ?? new Set<Promise<void>>();
  pendencias.add(fim);
  semDesfecho.set(chave, pendencias);
  void fim.then(() => {
    pendencias.delete(fim);
    if (semDesfecho.get(chave) === pendencias && pendencias.size === 0) {
      semDesfecho.delete(chave);
    }
  });
}

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

/** Ordem local ao turno; efeito sem desfecho impede nova escrita no mesmo processo. */
export function criarFilaDeEscritasDoNegocio() {
  type Fila = {
    fim: Promise<void>;
    bloqueada: boolean;
    recusa: Promise<never>;
    recusar: (erro: Error) => void;
  };
  const pendentes = new Map<string, Fila>();
  return async function executar<T>(chave: string | null, operacao: () => Promise<T>): Promise<T> {
    if (chave === null) return operacao();
    if (semDesfecho.has(chave)) throw new EscritaDoNegocioSemDesfechoError();
    let fila = pendentes.get(chave);
    if (!fila) {
      let recusar!: (erro: Error) => void;
      const recusa = new Promise<never>((_, reject) => { recusar = reject; });
      fila = { fim: Promise.resolve(), bloqueada: false, recusa, recusar };
      pendentes.set(chave, fila);
    }
    const estado = fila;
    if (estado.bloqueada) throw new EscritaDoNegocioSemDesfechoError();
    const resultado = estado.fim.then(() => {
      // A espera não é permissão para agir após o prazo ou uma pendência de outro turno.
      if (estado.bloqueada || semDesfecho.has(chave)) {
        throw new EscritaDoNegocioSemDesfechoError();
      }
      return operacao();
    });
    // Uma recusa não envenena as próximas chamadas, mas volta intacta a quem chamou.
    const fim = resultado.then(
      () => undefined,
      () => undefined,
    );
    estado.fim = fim;
    // Limpar só quando o handler assenta de verdade, nunca quando o race expira.
    void fim.then(() => {
      if (estado.fim === fim && !estado.bloqueada) pendentes.delete(chave);
    });
    const prazo = setTimeout(() => {
      estado.bloqueada = true;
      conservarPendencia(chave, estado.fim);
      estado.recusar(new EscritaDoNegocioSemDesfechoError());
    }, PRAZO_ESCRITA_NEGOCIO_MS);
    try {
      return await Promise.race([resultado, estado.recusa]);
    } finally {
      clearTimeout(prazo);
    }
  };
}
