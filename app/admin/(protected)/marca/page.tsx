import { notFound } from "next/navigation";

import { loadAuthUser } from "@/lib/auth/server";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDaInstalacao, camadaDoAmbiente, resolverMarca } from "@/lib/branding/resolve";
import { env } from "@/lib/env";

import { FormularioDaMarca } from "./_form";

export const metadata = { title: "Marca da instalação" };
export const dynamic = "force-dynamic";

/**
 * Formata o instante do alarme AQUI, no servidor, e manda a string pronta.
 *
 * Formatar no cliente pareceria mais simples e traria um defeito conhecido: o
 * HTML servido usa o fuso do contêiner e a hidratação usa o do navegador, então
 * a mesma linha renderiza diferente dos dois lados. Fuso fixo porque a coluna é
 * da INSTALAÇÃO — não há organização resolvida nesta tela de onde tirar um.
 */
function instanteLegivel(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString("pt-PT", {
    timeZone: "Africa/Maputo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

/**
 * A tela onde o dono da instalação troca a marca do produto.
 *
 * ── Por que `/admin`, e não `/app/settings` ───────────────────────────────────
 *
 * O que se edita aqui é a marca da INSTALAÇÃO — a que pinta o login, o e-mail de
 * recuperação e a tela de erro, superfícies anteriores a qualquer organização.
 * Num revendedor que hospeda várias empresas, dar isso ao admin de um tenant
 * seria dar a um cliente o controle da fachada dos outros. O papel é o
 * transversal, e o lugar dele no produto é o admin de plataforma. A marca POR
 * organização é outra coisa e é a fase seguinte.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ────────────────────────────
 *
 * Mesma escolha de `app/app/settings/atualizacao/page.tsx`: para quem não
 * administra a instalação, esta tela simplesmente não faz parte do produto — a
 * existência dela não é assunto dele.
 *
 * O layout de `(protected)` já roda `requirePlatformAdmin()`, então este gate é
 * redundante HOJE. Ele fica porque a garantia precisa ser local: um layout pode
 * ser movido, e a única regra que não depende de vizinho é a que a própria
 * página aplica.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();

  const linha = await marcaDaInstalacao();
  // A MESMA pilha do `app/layout.tsx` — banco acima, arquivo de instalação
  // embaixo. Montar outra aqui faria a tela relatar uma precedência que o
  // produto não usa, que é a pior mentira possível numa tela de diagnóstico.
  const marca = resolverMarca(
    [camadaDaInstalacao(linha), camadaDoAmbiente(env)],
    REGUA_DO_PRODUTO,
  );

  // O que apareceria SEM o arquivo subido — a MESMA pilha com `logo_path`
  // zerado, e não uma leitura solta de `APP_LOGO_URL`. É assim que a prévia
  // responde "e se eu remover?" sem que a tela invente uma segunda regra de
  // precedência: quem herda pode ser a URL colada no banco ou a do arquivo de
  // instalação, e só o resolvedor sabe qual das duas.
  const semOArquivo = resolverMarca(
    [camadaDaInstalacao(linha ? { ...linha, logo_path: null } : null), camadaDoAmbiente(env)],
    REGUA_DO_PRODUTO,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Marca</h1>
        <p className="mt-1 text-sm text-text-muted">
          O nome e a cor que este sistema mostra para todo mundo que usa esta instalação.
        </p>
      </div>

      <FormularioDaMarca
        gravada={{
          app_name: linha?.app_name ?? null,
          logo_url: linha?.logo_url ?? null,
          logo_path: linha?.logo_path ?? null,
          accent_hex: linha?.accent_hex ?? null,
          // `true` é o default da coluna: sem linha ainda, é o valor que o
          // `upsert` gravaria de qualquer forma.
          show_powered_by: linha?.show_powered_by ?? true,
        }}
        nomeEmVigor={marca.name}
        logoEmVigor={marca.logoUrl}
        logoDoAmbiente={semOArquivo.logoUrl}
        origens={marca.origens}
        // `seeded_from_env` ligado significa que a linha é cópia do arquivo de
        // instalação, não escolha de alguém nesta tela. Sem linha, também não é.
        definidoNestaTela={linha !== null && !linha.seeded_from_env}
        fallbackEm={instanteLegivel(linha?.fallback_at ?? null)}
        fallbackMotivo={linha?.fallback_reason ?? null}
      />
    </div>
  );
}
