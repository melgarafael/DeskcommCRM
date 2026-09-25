/**
 * Integração de dados → explorador de uma conexão.
 *
 * A conexão é lida pela SESSÃO (`createClient`), então a RLS decide: id de outra
 * organização simplesmente não existe aqui, e a página vira 404 — sem revelar
 * que o id existe.
 *
 * A árvore de tabelas e os dados chegam pelo cliente, via a API, porque a
 * introspecção é AO VIVO e o catálogo pode levar alguns segundos; travar o
 * primeiro render do servidor nisso seguraria a navegação inteira.
 */
import { notFound, redirect } from "next/navigation";

import { ExploradorDeDados } from "./_components/ExploradorDeDados";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ConexaoExternaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;

  const supabase = await createClient();
  const { data } = await supabase
    .from("external_db_connections_safe")
    .select("id, label, host, port, database_name, username, ssl_mode, enabled")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();

  if (!data) notFound();

  const conexao = data as unknown as {
    id: string;
    label: string;
    host: string;
    port: number;
    database_name: string;
    username: string;
    ssl_mode: string;
    enabled: boolean;
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{conexao.label}</h1>
        <p className="text-sm text-muted-foreground">
          {conexao.host}:{conexao.port}/{conexao.database_name} · {conexao.username} ·{" "}
          {traduzir("somente leitura", idioma)}
        </p>
      </header>

      {!conexao.enabled && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {traduzir("Esta conexão está desativada. Ative-a na lista para consultar os dados.", idioma)}
        </div>
      )}

      <ExploradorDeDados connectionId={conexao.id} />
    </div>
  );
}
