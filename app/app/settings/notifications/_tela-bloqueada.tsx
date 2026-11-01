import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { supportWriteError } from "@/lib/impersonate/support";
import { conteudoNaTelaBloqueada } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";

import { EscolhaDaTelaBloqueada } from "./_tela-bloqueada-escolha";

/**
 * A seção da EMPRESA: o que os avisos do celular mostram com a tela bloqueada.
 * Todo membro vê o valor em vigor; só admin (fora de acompanhamento somente
 * leitura) muda — o mesmo critério de `definirConteudoNaTelaBloqueada`, que
 * cobra de novo.
 */
export async function ConteudoNaTelaBloqueada() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  // Falha de leitura não vira "está no padrão": a tela diz que não leu.
  if (error) {
    return (
      <Card className="p-4 text-sm" data-testid="tela-bloqueada-erro">
        {traduzir("Não consegui ler esta configuração agora.", user.idioma)}
      </Card>
    );
  }

  return (
    <EscolhaDaTelaBloqueada
      valorInicial={conteudoNaTelaBloqueada(data?.settings)}
      podeEditar={activeOrg.role === "admin" && supportWriteError(user.support) === null}
    />
  );
}
