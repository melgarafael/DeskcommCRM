"use client";

/**
 * OS RANKINGS E A LISTA DE NEGÓCIOS GANHOS, dentro da tela de Faturamento
 * (#4280; recorte por funil e tag e lista de vendas: #4802, item 4).
 *
 * Etiquetas que mais vendem, clientes que mais compram e funis que mais vendem,
 * apresentados como a rota os devolve — nada é recalculado aqui. Componentes do
 * PR #4295 de @webtecnica; o que mudou foi o lugar (decisão do dono, doc 306):
 *
 *   - NÃO há seletor de período: `de`/`ate` chegam da tela de Faturamento. Um
 *     segundo seletor seria dois meses diferentes na mesma página.
 *   - NÃO há cartão de "faturamento do período": o número que vale é o da tela.
 *     Estes blocos somam NEGÓCIOS GANHOS; os números acima somam comandas e
 *     lançamentos. A frase sob o título diz isso, para ninguém tentar bater um
 *     com o outro. A lista de vendas mostra o valor de CADA venda e não soma.
 *
 * O RECORTE (funil e tag) é deste bloco: os seletores oferecem os funis e as
 * tags que aparecem nos negócios ganhos do período (`opcoes` da rota), e clicar
 * numa tag do ranking aplica o recorte por ela.
 *
 * SÓ LEITURA. Período sem negócio ganho NÃO vira tabela de zeros — a rota
 * devolve `sem_dados` e o bloco diz "nenhum negócio ganho no período".
 */
import { useState, type ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useCommercialReport } from "@/hooks/reports/useCommercialReport";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { formatCents } from "@/lib/money";
import {
  normalizarTagDoRelatorio,
  type RespostaDoRelatorioComercial,
} from "@/lib/relatorios/comercial";

// O número nunca quebra nem é cortado: quem encolhe é o nome (`CELULA_DE_NOME`).
// Medido na prova do #4941: a 1280 px com a barra lateral aberta, o valor saía "R$ 300,".
const CELULA_DE_NUMERO = "whitespace-nowrap text-right tabular-nums";
/** `w-full max-w-0` deixa a célula do nome ceder espaço e truncar, em qualquer largura do card. */
const CELULA_DE_NOME = "w-full max-w-0 truncate";
const CLASSE_DO_SELETOR =
  "rounded-md border border-border bg-surface-elevated p-2 text-sm text-text max-md:min-h-11";

export function RankingsDeNegociosGanhos({ de, ate }: { de: string; ate: string }) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [pipelineId, setPipelineId] = useState<string>("");
  const [tag, setTag] = useState<string>("");
  const { data, isLoading, isError, isFetching, isPlaceholderData } = useCommercialReport({
    de,
    ate,
    pipelineId,
    tag,
  });
  const relatorio = data?.data;

  // O FUNIL OU A TAG QUE SUMIU DO PERÍODO (revisão do #4941). Trocar o período
  // no topo pode tirar das `opcoes` o funil escolhido: o `<select>` não tem a
  // opção e mostra "Todos os funis", mas o recorte continuava aplicado — a tela
  // dizia uma coisa e a lista mostrava outra. Zera o que saiu, ajustando o
  // estado no render (o padrão do React para estado derivado de props), e SÓ
  // com a resposta do período atual: a de `keepPreviousData` é do período
  // anterior e zeraria um filtro válido.
  if (relatorio && !isPlaceholderData) {
    const funilSumiu = pipelineId !== "" && !relatorio.opcoes.pipeline_ids.includes(pipelineId);
    const tagSumiu =
      tag !== "" && !relatorio.opcoes.tags.includes(normalizarTagDoRelatorio(tag));
    if (funilSumiu) setPipelineId("");
    if (tagSumiu) setTag("");
  }

  const moldura = (conteudo: ReactNode) => (
    <section data-testid="rankings-de-negocios-ganhos" className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold">{t("Negócios ganhos")}</h2>
        <p className="text-xs text-text-muted">
          {t(
            "Estes blocos somam os negócios marcados como ganhos no período — não as comandas dos números acima.",
          )}
        </p>
      </div>
      {conteudo}
    </section>
  );

  if (isLoading) return moldura(<p className="text-sm text-text-muted">{t("Carregando…")}</p>);

  if (isError || !relatorio) {
    return moldura(<p className="text-sm text-danger">{t("Erro ao carregar o relatório.")}</p>);
  }

  if (relatorio.sem_dados) {
    return moldura(
      <p className="text-sm text-text-muted">{t("Nenhum negócio ganho no período.")}</p>,
    );
  }

  const nomeDoContato = (contactId: string | null) => {
    if (!contactId) return t("Sem contato");
    const contato = relatorio.contatos[contactId] ?? null;
    if (!contato) return t("Contato");
    return rotuloDoContato(
      { display_name: contato.display_name, name: contato.name, phone_number: contato.phone_number },
      t,
    );
  };
  const nomeDoFunil = (id: string | null) =>
    (id ? relatorio.nomes_dos_funis[id] : null) ?? t("Funil sem nome");

  const comRecorte = relatorio.filtro.pipeline_id !== null || relatorio.filtro.tag !== null;
  const avisos = avisosDoRelatorio(relatorio, t);
  const dataDaVenda = new Intl.DateTimeFormat(tagDeIdioma, {
    dateStyle: "short",
    timeZone: relatorio.janela.tz,
  });

  return moldura(
    <>
      <div className="flex flex-wrap items-end gap-3" data-testid="recorte-de-negocios-ganhos">
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Funil")}
          <select
            value={pipelineId}
            data-testid="recorte-funil"
            onChange={(e) => setPipelineId(e.target.value)}
            className={CLASSE_DO_SELETOR}
          >
            <option value="">{t("Todos os funis")}</option>
            {relatorio.opcoes.pipeline_ids.map((id) => (
              <option key={id} value={id}>
                {nomeDoFunil(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          {t("Tag")}
          <select
            value={tag}
            data-testid="recorte-tag"
            onChange={(e) => setTag(e.target.value)}
            className={CLASSE_DO_SELETOR}
          >
            <option value="">{t("Todas as tags")}</option>
            {relatorio.opcoes.tags.map((opcao) => (
              <option key={opcao} value={opcao}>
                {opcao}
              </option>
            ))}
          </select>
        </label>
        {comRecorte && (
          <button
            type="button"
            data-testid="recorte-limpar"
            onClick={() => {
              setPipelineId("");
              setTag("");
            }}
            className="rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-surface-elevated max-md:min-h-11"
          >
            {t("Limpar filtros")}
          </button>
        )}
        {isFetching && <span className="text-xs text-text-muted">{t("Atualizando…")}</span>}
      </div>

      {relatorio.negocios_ganhos === 0 ? (
        <p className="text-sm text-text-muted" data-testid="recorte-vazio">
          {t("Nenhum negócio ganho neste recorte. Troque o funil ou a tag.")}
        </p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("Tags que mais vendem")}</CardTitle>
              </CardHeader>
              <CardContent>
                {relatorio.tags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("Nenhum negócio ganho no período tem tag.")}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Tag")}</TableHead>
                        <TableHead className="text-right">{t("Negócios")}</TableHead>
                        <TableHead className="text-right">{t("Valor")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {relatorio.tags.map((linha) => (
                        <TableRow key={linha.tag}>
                          <TableCell className={CELULA_DE_NOME}>
                            <button
                              type="button"
                              title={t("Ver as vendas desta tag")}
                              onClick={() => setTag(linha.tag)}
                              className="block max-w-full truncate text-left underline-offset-2 hover:underline"
                            >
                              {linha.tag}
                            </button>
                          </TableCell>
                          <TableCell className={CELULA_DE_NUMERO}>{linha.negocios}</TableCell>
                          <TableCell className={CELULA_DE_NUMERO}>
                            {formatCents(linha.centavos, relatorio.moeda)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("Clientes que mais compram")}</CardTitle>
              </CardHeader>
              <CardContent>
                {relatorio.clientes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("Nenhum negócio ganho no período tem contato.")}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("Cliente")}</TableHead>
                        <TableHead className="text-right">{t("Negócios")}</TableHead>
                        <TableHead className="text-right">{t("Valor")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {relatorio.clientes.map((linha) => (
                        <TableRow key={linha.contact_id}>
                          <TableCell className={CELULA_DE_NOME}>
                            {nomeDoContato(linha.contact_id)}
                          </TableCell>
                          <TableCell className={CELULA_DE_NUMERO}>{linha.negocios}</TableCell>
                          <TableCell className={CELULA_DE_NUMERO}>
                            {formatCents(linha.centavos, relatorio.moeda)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("Funis que mais vendem")}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table data-testid="ranking-de-funis">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("Funil")}</TableHead>
                      <TableHead className="text-right">{t("Negócios")}</TableHead>
                      <TableHead className="text-right">{t("Valor")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {relatorio.funis.map((linha) => (
                      <TableRow key={linha.pipeline_id}>
                        <TableCell className={CELULA_DE_NOME}>
                          {nomeDoFunil(linha.pipeline_id)}
                        </TableCell>
                        <TableCell className={CELULA_DE_NUMERO}>{linha.negocios}</TableCell>
                        <TableCell className={CELULA_DE_NUMERO}>
                          {formatCents(linha.centavos, relatorio.moeda)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card data-testid="lista-de-vendas">
            <CardHeader>
              <CardTitle className="text-base">
                {t("Vendas")} ({relatorio.vendas_no_filtro})
              </CardTitle>
              {relatorio.vendas_no_filtro > relatorio.vendas.length && (
                <p className="text-xs text-text-muted">
                  {t("Mostrando as vendas mais recentes:")} {relatorio.vendas.length}{" "}
                  {t("de")} {relatorio.vendas_no_filtro}.
                </p>
              )}
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Data")}</TableHead>
                    <TableHead>{t("Cliente")}</TableHead>
                    <TableHead>{t("Negócio")}</TableHead>
                    <TableHead>{t("Funil")}</TableHead>
                    <TableHead>{t("Tags")}</TableHead>
                    <TableHead className="text-right">{t("Valor")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {relatorio.vendas.map((venda) => (
                    <TableRow key={venda.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {dataDaVenda.format(new Date(venda.ganho_em))}
                      </TableCell>
                      <TableCell className="max-w-[12rem] truncate">
                        {nomeDoContato(venda.contact_id)}
                      </TableCell>
                      <TableCell className="max-w-[14rem] truncate">
                        {venda.titulo ?? "—"}
                      </TableCell>
                      <TableCell className="max-w-[10rem] truncate">
                        {nomeDoFunil(venda.pipeline_id)}
                      </TableCell>
                      <TableCell className="max-w-[12rem] truncate text-text-muted">
                        {venda.tags.join(", ") || "—"}
                      </TableCell>
                      <TableCell className={CELULA_DE_NUMERO}>
                        {venda.centavos === null
                          ? t("sem valor")
                          : formatCents(venda.centavos, relatorio.moeda)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {avisos.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {avisos.map((aviso) => (
            <li key={aviso}>{aviso}</li>
          ))}
        </ul>
      )}
    </>,
  );
}

/** As frases que impedem o número de mentir por omissão — uma por ausência medida. */
function avisosDoRelatorio(
  relatorio: RespostaDoRelatorioComercial,
  t: (texto: string) => string,
): string[] {
  const avisos: string[] = [];
  if (relatorio.truncado) {
    avisos.push(
      t("Os números são um piso: a leitura foi interrompida antes do fim do período."),
    );
  }
  if (relatorio.negocios_sem_valor > 0) {
    avisos.push(
      `${relatorio.negocios_sem_valor} ${t("negócio(s) sem valor preenchido somam zero — valor ausente, não venda de zero.")}`,
    );
  }
  if (relatorio.excluidos.outra_moeda > 0) {
    avisos.push(
      `${relatorio.excluidos.outra_moeda} ${t("negócio(s) em outra moeda ficaram fora: o painel soma na moeda da empresa e não converte.")}`,
    );
  }
  if (relatorio.excluidos.sem_data_de_ganho > 0) {
    avisos.push(
      `${relatorio.excluidos.sem_data_de_ganho} ${t("negócio(s) ganho(s) sem data de fechamento não entram em nenhum recorte de período.")}`,
    );
    if (relatorio.filtro.tag !== null) {
      avisos.push(t("Essa contagem respeita o funil escolhido, mas não a tag."));
    }
  }
  if (relatorio.negocios_sem_contato > 0) {
    avisos.push(
      `${relatorio.negocios_sem_contato} ${t("negócio(s) ganho(s) sem contato não entram no ranking de clientes.")}`,
    );
  }
  return avisos;
}
