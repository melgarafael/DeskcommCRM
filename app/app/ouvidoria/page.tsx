import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { listarManifestacoesDaOuvidoria } from "@/app/actions/ouvidoria/listar-manifestacoes";
import { traduzir } from "@/lib/i18n/dicionario";
import { acessoDaOuvidoria } from "@/lib/ouvidoria/acesso";
import { statusPedido } from "@/lib/ouvidoria/tela";

import { TabelaDeManifestacoes } from "./_tabela";

/**
 * A TELA DA OUVIDORIA (#3611, fatia 3) — a lista de manifestações.
 *
 * ─── Quem entra ────────────────────────────────────────────────────────────
 *
 * `acessoDaOuvidoria()` — a mesma barreira da leitura da fatia 1. Abaixo de
 * `admin`, em sessão de acompanhamento ou sem organização, a página REDIRECIONA
 * em vez de renderizar uma lista vazia: lista vazia diria "a empresa não tem
 * manifestação", que é uma frase diferente de "você não pode ver". É a diferença
 * entre um zero honesto e um zero que mente.
 *
 * ─── Por que a página chama a ACTION, e não o banco ────────────────────────
 *
 * Porque a régua de papel precisa ser uma só. A action
 * (`app/actions/ouvidoria/listar-manifestacoes.ts`) barra e lê; a página só
 * traduz o resultado em tela. Assim o teste que fixa "papel sem permissão não vê
 * a lista" mede a regra, e não uma segunda cópia dela escrita aqui.
 *
 * ─── O filtro vem da URL ───────────────────────────────────────────────────
 *
 * `?status=` e `?pagina=`. Os dois são normalizados antes de virar consulta
 * (`lib/ouvidoria/tela.ts`): status desconhecido cai em "todas", página inválida
 * cai em 1, e o tamanho da página não é parâmetro.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ouvidoria" };

export default async function OuvidoriaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const acesso = await acessoDaOuvidoria();
  if (!acesso.ok) redirect(acesso.error === "unauthenticated" ? "/login" : "/app");

  const t = (texto: string) => traduzir(texto, acesso.user.idioma);
  const parametros = await searchParams;
  const status = statusPedido(parametros.status);

  const resultado = await listarManifestacoesDaOuvidoria({
    status: parametros.status ?? null,
    pagina: parametros.pagina ?? null,
  });

  return (
    <main className="flex h-full flex-col gap-6 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Ouvidoria")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Manifestações recebidas pela empresa. Só quem a organização autoriza lê o relato.")}
        </p>
      </header>

      {resultado.ok ? (
        <TabelaDeManifestacoes
          manifestacoes={resultado.pagina.manifestacoes}
          pagina={resultado.pagina.pagina}
          total={resultado.pagina.total}
          temMais={resultado.pagina.temMais}
          statusFiltro={status}
          idioma={acesso.user.idioma}
        />
      ) : (
        <TabelaDeManifestacoes
          manifestacoes={[]}
          pagina={1}
          total={0}
          temMais={false}
          statusFiltro={status}
          idioma={acesso.user.idioma}
          erro
        />
      )}
    </main>
  );
}
