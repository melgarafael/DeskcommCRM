import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

import { FormularioDeComportamento, FormularioDeModulos } from "./_form";

export const metadata = { title: "Comportamento da instalação" };
export const dynamic = "force-dynamic";

/**
 * A tela onde o dono da instalação decide COMO ela se comporta, sem SSH.
 *
 * ── O defeito que ela fecha (issue #1034) ───────────────────────────────────
 *
 * As chaves que decidem o comportamento de uma instalação JÁ EM OPERAÇÃO — o
 * kill switch do orçamento de IA, a exigência de assinatura no webhook do
 * canal, o modo do portão de divulgação e a camada semântica de promessa — só
 * existiam no `.env`: quem instalou a VPS era o único que conseguia mudá-las,
 * por SSH. É a decisão de produto escondida atrás de infraestrutura.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO inteira, não uma empresa. Num revendedor que hospeda
 * várias organizações, deixar o admin de um tenant desligar o bloqueio de gasto
 * mudaria o comportamento de TODOS os clientes daquele servidor. Mesmo
 * argumento de `/admin/cadastro`, `/admin/marca` e `/admin/google` — esta tela
 * é irmã das três, e usa o mesmo `traduzir`/`_form` das irmãs.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/cadastro`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  // O valor EFETIVO (linha acima, `.env` como piso): a tela mostra o que está
  // valendo de verdade, e não o que a linha diria se ela existisse.
  const [comportamento, ligados] = await Promise.all([
    carregarComportamentoDaInstalacao(),
    modulosLigados(createAdminClient()),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Comportamento desta instalação", usuario.idioma)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Como esta instalação se comporta em operação. Vale para todas as empresas hospedadas aqui.",
            usuario.idioma,
          )}
        </p>
      </div>
      <FormularioDeComportamento inicial={comportamento} />
      <FormularioDeModulos ligados={ligados} />
    </div>
  );
}
