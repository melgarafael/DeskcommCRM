/**
 * Integração de dados → lista de bancos externos conectados.
 *
 * A LISTA é de qualquer autenticado (D2): saber que a empresa tem uma fonte de
 * dados não é segredo, e é aqui que o atendente descobre de onde o agente tira a
 * resposta. CRIAR/editar/apagar é `admin`; o `canWrite` abaixo esconde os botões,
 * e a rota da API é quem de fato barra.
 *
 * A leitura sai da `_safe` view pela sessão (`createClient`), sem service role:
 * a RLS da tabela base se aplica à view `security_invoker`, então nem aqui há
 * como vazar a conexão de outra organização.
 */
import { redirect } from "next/navigation";

import { ListaDeConexoes } from "./_components/ListaDeConexoes";
import type { ConexaoExternaRow } from "@/hooks/external-db/useConexoesExternas";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Dados externos" };
export const dynamic = "force-dynamic";

const COLUNAS_SEGURAS =
  "id, organization_id, label, host, port, database_name, username, ssl_mode, enabled, last_tested_at, last_test_ok, last_test_error, created_by, created_at, updated_at";

export default async function IntegracaoDeDadosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const idioma = user.idioma;
  const supabase = await createClient();
  const { data } = await supabase
    .from("external_db_connections_safe")
    .select(COLUNAS_SEGURAS)
    .eq("organization_id", activeOrg.orgId)
    .order("label", { ascending: true });

  const conexoes = (data ?? []) as unknown as ConexaoExternaRow[];
  const canWrite =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Dados externos", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Conecte um banco de dados de outro sistema — o seu segundo CRM, um ERP, uma planilha em PostgreSQL — e o agente passa a consultá-lo em tempo real. A conexão é sempre somente leitura: nada que o agente faz altera o banco de origem.",
            idioma,
          )}
        </p>
      </header>
      <ListaDeConexoes initialData={conexoes} canWrite={canWrite} />
    </div>
  );
}
