import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { TarefasClient } from "./_components/TarefasClient";

export const dynamic = "force-dynamic";

/**
 * TAREFAS — "ligar de volta na terça", num lugar que não é a memória de ninguém.
 *
 * Extraído do PR #418, de @clinicacentrodosorrisosc-code, que construiu o
 * módulo inteiro rodando o produto numa operação real. O que muda aqui é o
 * vocabulário: a tela dele somava tarefas com "agendamentos" derivados de
 * `custom_fields.agendamento_*` do lead, e falava consulta/procedimento/
 * compareceu. Compromisso com cliente já é a Agenda (migration 0177), que tem
 * tabela, horário, local e confirmação — e este produto atende clínica,
 * imobiliária, loja e infoproduto com as mesmas telas.
 *
 * ─── Quem pode o quê ───────────────────────────────────────────────────────
 *
 * `viewer` VÊ as tarefas: saber o que o time combinou é informação de operação.
 * Criar e editar é `agent` — e a rota cobra de novo (`requireRole("agent")`).
 * A tela esconder o botão é cortesia, não autorização.
 */
export default async function TarefasPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;

  return <TarefasClient podeEditar={podeEditar} />;
}
