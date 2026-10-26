import Link from "next/link";

import { EditorDeModelosDeContrato } from "@/components/agencia/contratos/EditorDeModelosDeContrato";
import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Modelos de contrato · Agência" };
export const dynamic = "force-dynamic";

/** O editor dos modelos de contrato (docs/agencia/SPEC-contratos.md, K1). */
export default async function PaginaDosModelosDeContrato() {
  await requirePermissaoNaPagina("contratos.gerenciar");
  const { data } = await createAdminClient().from("agencia_contrato_modelos").select("id, nome, corpo, ativo").order("nome");
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-1">
        <Link href="/agencia/contratos" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Contratos
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Modelos de contrato</h1>
        <p className="text-sm text-muted-foreground">
          Cole o texto do contrato que vocês usam e troque os dados do cliente pelos campos. Mudar um modelo não muda contrato já gerado.
        </p>
      </div>
      <EditorDeModelosDeContrato modelos={(data ?? []) as Array<{ id: string; nome: string; corpo: string; ativo: boolean }>} />
    </div>
  );
}
