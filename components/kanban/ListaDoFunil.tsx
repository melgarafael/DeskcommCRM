"use client";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useLeadsPaginados } from "@/hooks/kanban/useLeadsPaginados";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { formatValorDoNegocio } from "@/lib/money";
import type { Pipeline, Stage } from "@/lib/kanban/types";

import { LeadDossier } from "./LeadDossier";

interface Props {
  pipelineId: string;
  /**
   * O funil inteiro. É de `settings.fields` que saem os `fieldDefs` que a ficha
   * do negócio usa — a MESMA ficha do quadro e do calendário.
   */
  pipeline: Pipeline;
  /** As etapas do quadro: é delas que sai o nome da etapa de cada linha. */
  stages: Stage[];
}

/**
 * A VISÃO LISTA DO FUNIL (#3172, fatia 1) — a terceira aba, ao lado do Quadro e
 * do Calendário. Uma linha por negócio, paginada NO BANCO.
 *
 * ─── Por que ela existe ────────────────────────────────────────────────────
 *
 * Com 100+ cards numa coluna o quadro vira uma pilha: não dá para ver de
 * relance quem está parado há dias. Uma linha por negócio cabe dez vezes mais
 * na tela — e, principalmente, a leitura é a DA PÁGINA: a rota pede `per_page`
 * linhas com `range`, e o índice `idx_crm_leads_org_pipeline_position_id`
 * (migration 0739) é o que faz o banco parar na página em vez de avaliar o
 * funil inteiro. O quadro, esse sim, lê o funil inteiro de uma vez (e cada
 * linha passa por `fn_can_view_lead`); num funil migrado com milhares de
 * negócios isso levou 19 s, até estourar o `statement_timeout` do papel
 * `authenticated`. Sem o índice, o `range` cortaria só o que VOLTA: o custo
 * continuaria sendo o do funil.
 *
 * ─── As colunas desta fatia, e o que ficou FORA ────────────────────────────
 *
 * Negócio, etapa, valor e última atividade — as básicas, mais o clique que abre
 * a MESMA ficha do quadro (`LeadDossier`): a lista é outro ângulo do mesmo
 * funil, não outro produto, e quem já sabe abrir um negócio no quadro não
 * aprende nada novo aqui. Ficaram fora, por serem as fatias 2 e 3 da issue:
 * filtros combináveis e ordenação pelo cabeçalho, escolha de colunas, seleção
 * em lote e visões salvas. A ordem é a do quadro (`position_in_stage`, a ordem
 * que a rota aplica), a mesma que o operador vê nas colunas.
 *
 * ⚠️ A BARRA DE FILTROS DA PÁGINA NÃO ALCANÇA ESTA ABA, e é deliberado: ela
 * filtra em memória a lista que o quadro já leu, e aqui não existe essa lista —
 * os filtros vão para a CONSULTA na fatia 2. Filtrar em memória uma página
 * faria a lista mentir com convicção ("nenhum negócio com esta etiqueta"), que
 * é pior do que não filtrar.
 */
export function ListaDoFunil({ pipelineId, pipeline: funil, stages }: Props) {
  const t = useT();
  const tag = useTagDeIdioma();
  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );

  const [pagina, setPagina] = useState(1);
  const [dossieId, setDossieId] = useState<string | null>(null);
  const { data, isLoading, error } = useLeadsPaginados(pipelineId, pagina);

  const leads = data?.leads ?? [];
  const leadDoDossie = leads.find((l) => l.id === dossieId) ?? null;

  const campoDefs = useMemo(
    () => camposPorEscopo(camposDoFunil(funil.settings), "negocio"),
    [funil.settings],
  );

  /**
   * A data da última atividade, no idioma de quem está lendo. `Intl` e não
   * date-fns: é uma data curta de tabela, sem nome de dia — o `tag` do idioma
   * já resolve, e é a mesma régua de `useTagDeIdioma`.
   */
  const diaCurto = useMemo(
    () => new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", year: "numeric" }),
    [tag],
  );

  const nomeDaEtapa = (stageId: string) => stages.find((s) => s.id === stageId)?.name ?? "—";

  return (
    <div className="flex flex-1 flex-col gap-3" data-testid="lista-do-funil">
      {error ? (
        // Erro do banco NÃO vira "nenhum negócio": dizer que o funil está vazio
        // quando não se sabe ler é a resposta que o operador acredita.
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          {t("Não consegui carregar os negócios desta lista.")}
        </div>
      ) : isLoading && leads.length === 0 ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando…")}
        </div>
      ) : leads.length === 0 ? (
        <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          {t("Nenhum negócio nesta página.")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="p-3 font-medium">
                  {t("Negócio")}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {t("Etapa")}
                </th>
                <th scope="col" className="p-3 text-right font-medium">
                  {t("Valor")}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {t("Última atividade")}
                </th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr
                  key={l.id}
                  className="border-t transition-colors hover:bg-muted/40"
                  data-testid={`lista-negocio-${l.id}`}
                >
                  <td className="p-3">
                    {/* O clique abre a MESMA ficha do quadro. É um botão, e não
                        a linha inteira: quem navega por teclado precisa de um
                        alvo focável por negócio. */}
                    <button
                      type="button"
                      onClick={() => setDossieId(l.id)}
                      className="text-left font-medium underline-offset-2 hover:underline"
                    >
                      {l.title}
                    </button>
                  </td>
                  <td className="p-3 text-muted-foreground">{nomeDaEtapa(l.stage_id)}</td>
                  <td className="p-3 text-right tabular-nums">
                    {l.value_cents === null || l.value_cents === undefined
                      ? "—"
                      : formatValorDoNegocio(l.value_cents, l.currency ?? "BRL", {
                          semCentavos: true,
                        })}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {l.last_activity_at
                      ? diaCurto.format(new Date(l.last_activity_at))
                      : t("Sem atividade")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!error && (pagina > 1 || (data?.hasMore ?? false)) && (
        <div className="flex items-center justify-between text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={pagina <= 1 || isLoading}
            onClick={() => setPagina((p) => Math.max(1, p - 1))}
          >
            {t("Anterior")}
          </Button>
          {/* A página ATUAL, e só ela: o "de {total}" prometia um total exato,
              que a rota parou de contar (a contagem varria o funil inteiro —
              ver o cabeçalho da rota). Chave de dicionário com placeholder,
              literal, nunca template: chave montada em runtime não existe em
              dicionário nenhum e sairia em português para quem lê espanhol. */}
          <span className="text-xs text-muted-foreground">
            {t("página {atual}").replace("{atual}", String(pagina))}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!(data?.hasMore ?? false) || isLoading}
            onClick={() => setPagina((p) => p + 1)}
          >
            {t("Próxima")}
          </Button>
        </div>
      )}

      {leadDoDossie && (
        <LeadDossier
          open
          onOpenChange={(aberto) => {
            if (!aberto) setDossieId(null);
          }}
          lead={leadDoDossie}
          pipelineId={pipelineId}
          fieldDefs={campoDefs}
          stageName={nomeDaEtapa(leadDoDossie.stage_id)}
          ownerNames={ownerNames}
        />
      )}
    </div>
  );
}
