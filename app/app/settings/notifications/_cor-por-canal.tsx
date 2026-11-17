import { Card } from "@/components/ui/card";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { supportWriteError } from "@/lib/impersonate/support";
import { corPorCanalLigada } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";

import { EscolhaDaCorPorCanal } from "./_cor-por-canal-escolha";

/**
 * A seção da EMPRESA: a cor por canal no aviso de mensagem nova (#4094).
 *
 * Leitura pela sessão (RLS), como `ConteudoNaTelaBloqueada`: todo membro vê o
 * valor em vigor; só admin, fora de acompanhamento somente leitura, muda — e a
 * server action cobra de novo, porque tela nenhuma é autorização.
 */
export async function CorPorCanalNoAviso() {
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
      <Card className="p-4 text-sm" data-testid="cor-por-canal-erro">
        {traduzir("Não consegui ler esta configuração agora.", user.idioma)}
      </Card>
    );
  }

  return (
    <EscolhaDaCorPorCanal
      valorInicial={corPorCanalLigada(data?.settings)}
      podeEditar={activeOrg.role === "admin" && supportWriteError(user.support) === null}
    />
  );
}
