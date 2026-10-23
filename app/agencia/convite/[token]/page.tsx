import { notFound } from "next/navigation";

import { AceiteDoConvite } from "@/components/agencia/AceiteDoConvite";
import { lerConvite } from "@/lib/agencia/aceite";
import { FRASE_DA_SITUACAO, mesmoEmail } from "@/lib/agencia/convite";
import { marcaDaSaida } from "@/lib/branding/saida";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Convite da agência" };
export const dynamic = "force-dynamic";

/**
 * Aceite do convite (docs/agencia/SPEC-equipe.md › Telas). Rota PÚBLICA no
 * proxy (`lib/auth/public-paths.ts`): quem chega aqui ainda não tem conta. O
 * token é a credencial, e tudo é decidido no servidor pelo hash dele.
 */
export default async function PaginaDoConvite({ params }: { params: Promise<{ token: string }> }) {
  if (!(await moduloLigado(createAdminClient(), "agencia"))) notFound();
  const { token } = await params;
  const [convite, marca, sessao] = await Promise.all([
    lerConvite(token),
    marcaDaSaida(null),
    (async () => (await createClient()).auth.getUser())(),
  ]);
  const user = sessao.data.user;

  let estado: "invalido" | "logado_certo" | "logado_errado" | "sem_login" = "sem_login";
  let aviso: string | null = null;
  if (!convite || convite.situacao !== "valido") {
    estado = "invalido";
    aviso = FRASE_DA_SITUACAO[convite && convite.situacao !== "valido" ? convite.situacao : "inexistente"];
  } else if (user) {
    estado = mesmoEmail(user.email ?? "", convite.email) ? "logado_certo" : "logado_errado";
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{marca.nome}</p>
          <h1 className="text-xl font-semibold tracking-tight">
            {convite && estado !== "invalido" ? `Bem-vindo à equipe, ${convite.nome.split(" ")[0]}` : "Convite da agência"}
          </h1>
        </div>
        {estado === "invalido" ? (
          <p className="text-sm text-muted-foreground">{aviso}</p>
        ) : (
          <AceiteDoConvite
            token={token}
            email={convite!.email}
            estado={estado}
            emailDaSessao={user?.email ?? null}
          />
        )}
      </div>
    </main>
  );
}
