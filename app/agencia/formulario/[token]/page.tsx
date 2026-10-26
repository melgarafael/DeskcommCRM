import { notFound } from "next/navigation";

import { FormularioPublico } from "@/components/agencia/formulario/FormularioPublico";
import { estadoDoDrive } from "@/lib/agencia/acervo/drive";
import { FRASE_DO_LINK, lerFormularioPorToken } from "@/lib/agencia/formulario/link";
import { respostasVazias } from "@/lib/agencia/formulario/perguntas";
import { marcaDaSaida } from "@/lib/branding/saida";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Formulário de acesso", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * O formulário de acesso que o cliente preenche (docs/agencia/SPEC-cofre-e-formulario.md).
 * Rota PÚBLICA no proxy (`lib/auth/public-paths.ts`): quem chega não tem conta, e
 * o token do link é a credencial, conferida no servidor pelo hash.
 */
export default async function PaginaDoFormulario({ params }: { params: Promise<{ token: string }> }) {
  if (!(await moduloLigado(createAdminClient(), "agencia"))) notFound();
  const { token } = await params;
  const [f, marca, drive] = await Promise.all([lerFormularioPorToken(token), marcaDaSaida(null), estadoDoDrive()]);

  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto w-full max-w-xl space-y-6 rounded-lg border bg-card p-5 sm:p-8">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{marca.nome}</p>
        {!f || f.situacao !== "valido" ? (
          <div className="space-y-2" data-testid="formulario-indisponivel">
            <h1 className="text-xl font-semibold">Formulário de acesso</h1>
            <p className="text-sm text-muted-foreground">{FRASE_DO_LINK[f && f.situacao !== "valido" ? f.situacao : "inexistente"]}</p>
          </div>
        ) : (
          <FormularioPublico
            token={token}
            empresa={f.clienteNome}
            agencia={marca.nome}
            inicial={f.rascunho ?? respostasVazias()}
            aceitaArquivos={drive.conectado}
            expiraEm={f.expiraEm}
          />
        )}
      </div>
    </main>
  );
}
