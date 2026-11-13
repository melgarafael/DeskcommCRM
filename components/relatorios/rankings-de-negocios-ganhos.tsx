"use client";

/**
 * OS DOIS RANKINGS DE NEGÓCIOS GANHOS, dentro da tela de Faturamento (#4280).
 *
 * Etiquetas que mais vendem e clientes que mais compram, apresentados como a
 * rota os devolve — nada é recalculado aqui. Componentes do PR #4295 de
 * @webtecnica; o que mudou foi o lugar (decisão do dono, doc 306):
 *
 *   - NÃO há seletor de período: `de`/`ate` chegam da tela de Faturamento. Um
 *     segundo seletor seria dois meses diferentes na mesma página.
 *   - NÃO há cartão de "faturamento do período": o número que vale é o da tela.
 *     Estes rankings somam NEGÓCIOS GANHOS; os números acima somam comandas e
 *     lançamentos. A frase sob o título diz isso, para ninguém tentar bater um
 *     com o outro.
 *
 * SÓ LEITURA: nenhum botão. Período sem negócio ganho NÃO vira tabela de zeros —
 * a rota devolve `sem_dados` e o bloco diz "nenhum negócio ganho no período".
 */
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { useCommercialReport } from "@/hooks/reports/useCommercialReport";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { formatCents } from "@/lib/money";

const CELULA_DE_NUMERO = "text-right tabular-nums";

export function RankingsDeNegociosGanhos({ de, ate }: { de: string; ate: string }) {
  const t = useT();
  const { data, isLoading, isError } = useCommercialReport({ de, ate });
  const relatorio = data?.data;

  const moldura = (conteudo: ReactNode) => (
    <section data-testid="rankings-de-negocios-ganhos" className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold">{t("Negócios ganhos")}</h2>
        <p className="text-xs text-text-muted">
          {t(
            "Estes dois rankings somam os negócios marcados como ganhos no período — não as comandas dos números acima.",
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
  }
  if (relatorio.negocios_sem_contato > 0) {
    avisos.push(
      `${relatorio.negocios_sem_contato} ${t("negócio(s) ganho(s) sem contato não entram no ranking de clientes.")}`,
    );
  }

  const nomeDoContato = (contactId: string) => {
    const contato = relatorio.contatos[contactId] ?? null;
    if (!contato) return t("Contato");
    return rotuloDoContato(
      { display_name: contato.display_name, name: contato.name, phone_number: contato.phone_number },
      t,
    );
  };

  return moldura(
    <>
      <div className="grid gap-6 lg:grid-cols-2">
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
                      <TableCell className="max-w-[16rem] truncate">{linha.tag}</TableCell>
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
                      <TableCell className="max-w-[16rem] truncate">
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
      </div>

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
