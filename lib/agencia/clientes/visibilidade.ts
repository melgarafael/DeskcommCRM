/**
 * Quais clientes uma pessoa da agência vê (docs/agencia/SPEC-clientes.md, C5).
 *
 * O dono e quem tem "vê todos os clientes" ligado veem todos; os demais, só os
 * clientes em que estão na equipe (`agencia_clientes_membros`). A regra é pura;
 * quem chama traz a lista da equipe.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import type { ContextoDaAgencia } from "../acesso";

export type AlcanceDeClientes = { todos: true } | { todos: false; ids: ReadonlySet<string> };

export function alcanceDeClientes(
  ctx: Pick<ContextoDaAgencia, "ehDono" | "membro">,
  idsDaEquipe: readonly string[],
): AlcanceDeClientes {
  if (ctx.ehDono || ctx.membro?.veTodosClientes) return { todos: true };
  return { todos: false, ids: new Set(idsDaEquipe) };
}

export function podeVerCliente(alcance: AlcanceDeClientes, clienteId: string | null): boolean {
  // Tarefa interna (sem cliente) não é filtrada por cliente.
  if (clienteId === null) return true;
  return alcance.todos || alcance.ids.has(clienteId);
}

/** Lê da equipe dos clientes e decide. Servidor só. */
export async function carregarAlcance(ctx: Pick<ContextoDaAgencia, "ehDono" | "membro">): Promise<AlcanceDeClientes> {
  if (ctx.ehDono || ctx.membro?.veTodosClientes || !ctx.membro) {
    return alcanceDeClientes(ctx, []);
  }
  const { data } = await createAdminClient()
    .from("agencia_clientes_membros")
    .select("cliente_id")
    .eq("membro_id", ctx.membro.id);
  return alcanceDeClientes(ctx, ((data ?? []) as Array<{ cliente_id: string }>).map((r) => r.cliente_id));
}
