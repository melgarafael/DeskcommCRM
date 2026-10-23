import Link from "next/link";

import { FuncoesCliente, type FuncaoEditavel } from "@/components/agencia/FuncoesCliente";
import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Funções · Agência" };
export const dynamic = "force-dynamic";

/** Funções da equipe e o que cada uma pode fazer (SPEC-equipe › Permissões). */
export default async function PaginaDeFuncoes() {
  await requirePermissaoNaPagina("equipe.gerenciar");
  const { data } = await createAdminClient()
    .from("agencia_funcoes")
    .select("id, nome, cor, permissoes, ativa")
    .order("ordem");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <Link href="/agencia/equipe" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Equipe
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Funções e permissões</h1>
        <p className="text-sm text-muted-foreground">
          Cada membro tem a soma das permissões das funções dele. Função desativada deixa de valer, mas não some do histórico.
        </p>
      </div>
      <FuncoesCliente funcoes={(data ?? []) as FuncaoEditavel[]} />
    </div>
  );
}
