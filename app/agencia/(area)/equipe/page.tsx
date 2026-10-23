import Link from "next/link";

import { EquipeCliente, type FuncaoDaLista, type MembroDaLista } from "@/components/agencia/EquipeCliente";
import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Equipe · Agência" };
export const dynamic = "force-dynamic";

/** Desde quando uma falha de WhatsApp ainda marca o membro na lista. */
function inicioDaJanelaDeFalhas(): string {
  return new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
}

/** Membros da equipe (docs/agencia/SPEC-equipe.md › Telas). */
export default async function PaginaDaEquipe() {
  await requirePermissaoNaPagina("equipe.gerenciar");
  const db = createAdminClient();
  const seteDias = inicioDaJanelaDeFalhas();

  const [funcoes, membros, convites, falhas] = await Promise.all([
    db.from("agencia_funcoes").select("id, nome, cor, ativa").order("ordem"),
    db
      .from("agencia_membros")
      .select("id, nome, email, whatsapp, situacao, ve_todos_clientes, recebe_whatsapp, agencia_membros_funcoes(funcao_id)")
      .order("nome"),
    db.from("agencia_convites").select("membro_id, expira_em").is("aceito_em", null).is("revogado_em", null),
    db.from("agencia_envios_whatsapp").select("telefone").eq("situacao", "falhou").gte("criado_em", seteDias),
  ]);

  const expiraPorMembro = new Map(
    ((convites.data ?? []) as Array<{ membro_id: string; expira_em: string }>).map((c) => [c.membro_id, c.expira_em]),
  );
  const telefonesComFalha = new Set(((falhas.data ?? []) as Array<{ telefone: string }>).map((f) => f.telefone));

  const lista: MembroDaLista[] = (
    (membros.data ?? []) as Array<{
      id: string;
      nome: string;
      email: string;
      whatsapp: string;
      situacao: string;
      ve_todos_clientes: boolean;
      recebe_whatsapp: boolean;
      agencia_membros_funcoes: Array<{ funcao_id: string }> | null;
    }>
  ).map((m) => ({
    id: m.id,
    nome: m.nome,
    email: m.email,
    whatsapp: m.whatsapp,
    situacao: m.situacao as MembroDaLista["situacao"],
    veTodosClientes: m.ve_todos_clientes,
    funcoes: (m.agencia_membros_funcoes ?? []).map((f) => f.funcao_id),
    conviteExpiraEm: expiraPorMembro.get(m.id) ?? null,
    whatsappFalhou: m.recebe_whatsapp && telefonesComFalha.has(m.whatsapp),
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Equipe</h1>
          <p className="text-sm text-muted-foreground">Quem trabalha na agência, as funções de cada um e o acesso.</p>
        </div>
        <Link href="/agencia/equipe/funcoes" className="text-sm underline underline-offset-4">
          Funções e permissões
        </Link>
      </div>
      <EquipeCliente membros={lista} funcoes={(funcoes.data ?? []) as FuncaoDaLista[]} />
    </div>
  );
}
