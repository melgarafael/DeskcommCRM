import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { traduzir } from "@/lib/i18n/dicionario";

import { FormularioDeCadastro } from "./_form";

export const metadata = { title: "Cadastro na instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação decide se aceita cadastro aberto.
 *
 * ── O defeito que ela fecha ─────────────────────────────────────────────────
 *
 * `/signup` sempre foi aberto e não havia como fechá-lo pelo produto. Quem
 * hospeda a própria instalação e vende tenant precisava bloquear a rota no
 * proxy reverso — fora do produto, e sem saber o que é um convite. Medido numa
 * instalação real em 2026-09-10: a regra de nginx que fazia isso barrava junto
 * o `/signup?invite=…`, exatamente quem deveria passar.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO. Num revendedor que hospeda várias empresas, deixar o
 * admin de um tenant fechar o cadastro impediria QUALQUER outra empresa de
 * entrar. Mesmo argumento de `/admin/marca` e `/admin/google`, e esta tela é
 * irmã das duas.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/google`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Cadastro", usuario.idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Quem pode criar uma conta nesta instalação.", usuario.idioma)}
        </p>
      </div>
      <FormularioDeCadastro modoInicial={await modoDeCadastro()} />
    </div>
  );
}
