/**
 * OS DOIS ENDEREÇOS DA PÁGINA DO NEGÓCIO (#4151).
 *
 * ─── Por que o "voltar" carrega a URL inteira do quadro ──────────────────────
 *
 * O filtro do quadro vive na query string (`lib/kanban/filters.ts`, `?visao=`,
 * `?lead=`): é ela que faz o endereço ser compartilhável e sobreviver ao F5. Um
 * "voltar" que apontasse para `/app/pipelines/<id>` puro devolveria o quadro
 * SEM o filtro de quem estava olhando — a pessoa abre o negócio a partir de uma
 * lista filtrada e volta para o funil inteiro, tendo de refazer a busca.
 *
 * Por isso o botão Expandir anexa a URL de origem em `?voltar=`. Não é estado
 * novo: é a própria URL do quadro, carregada junto.
 *
 * ─── E por que o destino é VALIDADO ─────────────────────────────────────────
 *
 * `?voltar=` chega por link colado, e link colado é entrada de terceiro. Só vale
 * caminho que começa com `/app/pipelines/` (mesma origem, mesma tela); qualquer
 * outra coisa — `https://…`, `//outro-host`, `javascript:` — cai no quadro do
 * próprio negócio. Sem isso, a página do negócio vira trampolim de redirect
 * aberto: um endereço do DeskcommCRM apontando para fora tem outra cara.
 *
 * `lead=` sai do `voltar` de propósito: voltar ao quadro com `?lead=` reabriria
 * o painel que a pessoa acabou de expandir.
 */

/** O prefixo da tela do quadro — a ÚNICA origem aceita para o "voltar". */
const PREFIXO_DO_QUADRO = "/app/pipelines/";

/**
 * O endereço da página inteira do negócio, com o quadro de origem guardado.
 *
 * `pathname`/`busca` são os do quadro no momento do clique: quem chama é a
 * página do funil, que já os tem (`usePathname`/`useSearchParams`).
 */
export function hrefDaPaginaDoNegocio(
  leadId: string,
  pathname: string,
  busca: string | URLSearchParams,
): string {
  const params = new URLSearchParams(
    typeof busca === "string" ? busca : busca.toString(),
  );
  params.delete("lead");
  const qs = params.toString();
  const origem = qs ? `${pathname}?${qs}` : pathname;
  return `/app/leads/${encodeURIComponent(leadId)}?voltar=${encodeURIComponent(origem)}`;
}

/**
 * O endereço do "Voltar": a origem quando ela é a tela do quadro, e o quadro
 * DESTE negócio quando não é.
 *
 * O segundo caso cobre o link direto (sem `?voltar=`), o `voltar` adulterado e o
 * quadro de outro funil — voltar para o funil errado é pior que voltar para o
 * certo, mesmo sem filtro.
 */
export function hrefDeVoltar(
  voltar: string | null | undefined,
  pipelineId: string,
): string {
  if (
    voltar &&
    voltar.startsWith(PREFIXO_DO_QUADRO) &&
    !voltar.startsWith("//") &&
    !voltar.includes("..")
  ) {
    return voltar;
  }
  return `/app/pipelines/${pipelineId}`;
}
