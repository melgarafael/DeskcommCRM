import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { getAmigoConfig } from "@/lib/amigo/store";
import { AmigoClient } from "./_client";
import type { Tab } from "./_types";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Amigo" };
export default async function AmigoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requireRole("agent", { resource: "amigo_operation" });
  if (!auth.ok) redirect("/app/inbox");
  // Módulo opcional (ADR-0002): sem instalar, a tela não existe — o mesmo 404 das rotas.
  if (!(await moduloLigado(createAdminClient(), "amigo"))) notFound();
  const params = await searchParams;
  const tabs: Tab[] = ["config", "agenda", "pacientes", "catalogos"];
  const tab = tabs.find((value) => value === params.aba);
  const contact = z.uuid().safeParse(params.contact_id);
  const config = await getAmigoConfig(auth.org.orgId);
  return (
    <AmigoClient
      initialConfig={config}
      canConfigure={roleAtLeast(auth.org.role, "admin")}
      canManage={roleAtLeast(auth.org.role, "manager")}
      initialTab={tab ?? (contact.success ? "pacientes" : "config")}
      initialContactId={contact.success ? contact.data : undefined}
    />
  );
}
