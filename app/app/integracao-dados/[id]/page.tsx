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
 *
 * O painel "O que o assistente pode ver" mora aqui, sem porta nova. Ele abre já
 * expandido quando a conexão acabou de nascer (`?fontes=1`) ou quando o modo é
 * `list` e nada foi marcado — conexão nova enxerga NADA, e a primeira impressão
 * não pode ser um assistente mudo sem explicação.
 */
import { notFound, redirect } from "next/navigation";

import { ExploradorDeDados } from "./_components/ExploradorDeDados";
import { PainelDeFontes } from "./_components/PainelDeFontes";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ConexaoExternaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fontes?: string }>;
}) {
  const { id } = await params;
  const { fontes } = await searchParams;
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;

  const supabase = await createClient();
  const { data } = await supabase
    .from("external_db_connections_safe")
    .select("id, label, host, port, database_name, username, ssl_mode, enabled, source_mode, sources_count, customer_key_column")
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
    source_mode: "all" | "list";
    sources_count: number;
    customer_key_column: string | null;
  };

  const canWrite =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const abertoInicial = fontes === "1" || (conexao.source_mode === "list" && conexao.sources_count === 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
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

      <PainelDeFontes
        connectionId={conexao.id}
        canWrite={canWrite}
        colunaDoCliente={conexao.customer_key_column}
        abertoInicial={abertoInicial}
      />

      <div className="flex min-h-[520px] flex-1 flex-col">
        <ExploradorDeDados connectionId={conexao.id} />
      </div>
    </div>
  );
}
