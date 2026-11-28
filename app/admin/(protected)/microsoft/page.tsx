import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { origemLocalDosCabecalhos } from "@/lib/agenda/google/config";
import { enderecoDeRetornoDaMicrosoft } from "@/lib/agenda/microsoft/config";
import { loadAuthUser } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { FormularioDaMicrosoft } from "./_form";

export const metadata = { title: "Agenda do Outlook da instalação" };
export const dynamic = "force-dynamic";

/**
 * Onde quem administra a INSTALAÇÃO cadastra o aplicativo da Microsoft. Irmã de
 * `/admin/google`. O segredo não volta: a tela só sabe se existe.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const origemLocal = origemLocalDosCabecalhos(await headers());

  const { data } = await createAdminClient()
    .from("platform_microsoft_oauth")
    .select("client_id, client_secret_encrypted, tenant")
    .eq("id", 1)
    .maybeSingle();
  const linha = data as {
    client_id: string | null;
    client_secret_encrypted: string | null;
    tenant: string | null;
  } | null;

  return (
    <FormularioDaMicrosoft
      clientIdSalvo={linha?.client_id ?? null}
      diretorioSalvo={linha?.tenant ?? null}
      temSegredoSalvo={Boolean(linha?.client_secret_encrypted)}
      enderecoDeRetorno={enderecoDeRetornoDaMicrosoft(origemLocal ?? undefined)}
    />
  );
}
