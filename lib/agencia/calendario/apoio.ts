/**
 * O que o modal da reunião precisa para preencher as listas: a equipe ativa e os
 * clientes que a pessoa alcança, com o contato do responsável — que vira o
 * primeiro convidado da reunião nova (SPEC-calendario › Telas).
 */
import { createAdminClient } from "@/lib/supabase/admin";

import type { QuemOlhaAgenda } from "./regras";

export interface ClienteDaAgenda {
  id: string;
  nome: string;
  responsavelNome: string;
  whatsapp: string;
  email: string;
}

export interface ApoioDaAgenda {
  membros: Array<{ id: string; nome: string }>;
  clientes: ClienteDaAgenda[];
}

export async function apoioDaAgenda(quem: QuemOlhaAgenda): Promise<ApoioDaAgenda> {
  const db = createAdminClient();
  let clientes = db
    .from("agencia_clientes")
    .select("id, nome, responsavel_nome, whatsapp, email")
    .not("situacao", "in", "(encerrado,perdido)")
    .order("nome");
  if (!quem.alcance.todos) clientes = clientes.in("id", [...quem.alcance.ids, "00000000-0000-0000-0000-000000000000"]);
  const [membros, lista] = await Promise.all([
    db.from("agencia_membros").select("id, nome").eq("situacao", "ativo").order("nome"),
    clientes,
  ]);
  return {
    membros: (membros.data ?? []) as Array<{ id: string; nome: string }>,
    clientes: ((lista.data ?? []) as Array<{
      id: string;
      nome: string;
      responsavel_nome: string | null;
      whatsapp: string | null;
      email: string | null;
    }>).map((c) => ({
      id: c.id,
      nome: c.nome,
      responsavelNome: c.responsavel_nome ?? "",
      whatsapp: c.whatsapp ?? "",
      email: c.email ?? "",
    })),
  };
}
