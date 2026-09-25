import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { CredentialRow } from "@/hooks/ai/useCredentials";
import { traduzir } from "@/lib/i18n/dicionario";
import { contarUsoQueBloqueia, type VersaoVinculada } from "@/lib/ai/credenciais/uso";
import { lerConfigDoJev } from "@/lib/ai/decisao/config";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { PONTOS_DO_JEV } from "@/lib/ai/pontos/registro";
import { lerAmbiente } from "@/lib/instalacao/ambiente";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { CredentialsList } from "./_components/CredentialsList";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

export default async function CredentialsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  const credentials = (data ?? []) as unknown as CredentialRow[];
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  // Mesma regra do DELETE — e a mesma da FK `ON DELETE RESTRICT`: TODA versão
  // que aponta para a credencial trava a exclusão, não só a publicada. O número
  // que a tela mostra é o que explica o bloqueio (ver `lib/ai/credenciais/uso.ts`).
  let usageMap: Record<string, number> = {};
  if (credentials.length > 0) {
    const { data: linked } = await supabase
      .from("ai_agent_versions")
      .select("id, credential_id, version_number, status")
      .eq("organization_id", activeOrg.orgId)
      .in("credential_id", credentials.map((c) => c.id));
    usageMap = contarUsoQueBloqueia((linked ?? []) as unknown as VersaoVinculada[]);
  }

  // "Usada em" e o aviso de exclusão da chave do Jev saem da LISTA VIVA, no
  // cliente (`CredentialsList`): calculados aqui, sobre a foto das linhas, uma
  // chave recém-trocada (ainda sem `validated_at`) perdia a linha e só a
  // recuperava recarregando a página, embora a lista já a mostrasse validada.
  // Daqui saem só o que o cliente não tem: o interruptor e a IA principal.
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const jevLigado = lerConfigDoJev(orgRow?.settings).ligado;
  // A mesma pergunta que o worker faz: sem a chave do Jev, há IA principal para medir?
  const jev = jevLigado
    ? {
        tarefas: PONTOS_DO_JEV.map((p) => p.rotulo),
        temIaPrincipal:
          (await resolverModeloDoPonto("sentiment_classify", activeOrg.orgId, DEFAULT_CLASSIFIER_MODEL, {
            naFaltaUsarOPadraoDaOrganizacao: true,
          })) !== null,
      }
    : null;

  // A chave do `.env` também é "IA principal" — sem ela na conta, a lista
  // acusaria falta de IA a quem atende com a chave que veio na instalação.
  const ambiente = lerAmbiente();
  const instalacaoTemIa =
    ambiente.gateway || Object.values(ambiente.chavesDeProvedor).some(Boolean);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Chaves de acesso à IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {/* Os provedores saem da lista única: escritos à mão, a frase citava
              três quando já eram cinco. */}
          {traduzir(
            "A conta de inteligência artificial é sua: você contrata direto com {provedores} e cola a chave aqui. A chave fica guardada criptografada e nunca mais aparece na tela depois de salva — nem para você. O Jev (TypeSafe) não conversa com o cliente: a chave dele serve só para decisões rápidas.",
            idioma,
          ).replace(
            "{provedores}",
            new Intl.ListFormat(tagDeIdioma(idioma), { type: "disjunction" }).format(
              PROVEDORES.map((p) => p.rotulo),
            ),
          )}
        </p>
      </header>
      <CredentialsList
        initialData={credentials}
        canWrite={canWrite}
        usageMap={usageMap}
        jev={jev}
        instalacaoTemIa={instalacaoTemIa}
      />
    </div>
  );
}
