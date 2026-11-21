import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { MODULO_SERVICOS } from "@/lib/catalogo/servicos-supabase";
import { traduzir } from "@/lib/i18n/dicionario";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { ServicosClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Serviços" };

/**
 * O CATÁLOGO DE SERVIÇOS — módulo opcional `catalogo_servicos` (doc 212, #3480).
 *
 * Sem o módulo instalado a tela não existe (404), como as rotas dela e como as
 * telas irmãs de módulo (lista de espera, ouvidoria).
 *
 * Quem pode o quê é o mesmo do catálogo de produtos: `viewer` vê, `manager`
 * cadastra e altera — serviço é preço. A rota cobra de novo; esconder o botão é
 * cortesia, não autorização.
 */
export default async function ServicosPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  if (!(await moduloLigado(createAdminClient(), MODULO_SERVICOS))) notFound();

  const t = (texto: string) => traduzir(texto, user.idioma);
  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[org.role] >= ROLE_RANK.manager;
  // A moeda é da organização, como no POST: o corpo não decide unidade.
  const moeda = await moedaDaOrganizacao(await createClient(), org.orgId);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{t("Serviços")}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t("O que você vende que não é produto de prateleira: hora marcada, projeto ou plano recorrente. O atendente de IA responde com estes preços, prazos e sinais.")}
        </p>
      </header>
      <ServicosClient podeEditar={podeEditar} moeda={moeda} />
    </div>
  );
}
