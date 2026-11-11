"use client";

/**
 * O PAINEL COMERCIAL DA #4280 — os três números, e nada além.
 *
 * ─── O que esta tela é ──────────────────────────────────────────────────────
 *
 * Faturamento do período, tags que mais vendem e clientes que mais compram —
 * as três perguntas escritas no corpo da issue, apresentadas como a rota as
 * devolve. Nada é recalculado aqui: se a tela somasse de novo, existiriam dois
 * números com o mesmo nome, e o dia em que discordassem ninguém saberia qual
 * está certo.
 *
 * ─── SÓ LEITURA, e isso é visível ───────────────────────────────────────────
 *
 * Não há botão que mude dado: o único controle interativo é o PERÍODO (atalhos
 * e duas datas), que refaz a leitura. Nenhum "novo negócio", nenhum "editar",
 * nenhum "exportar". quem registra a venda é o Kanban — esta tela responde
 * depois.
 *
 * ─── Estado vazio honesto ───────────────────────────────────────────────────
 *
 * Período sem negócio ganho NÃO vira gráfico de zeros: a rota devolve zero
 * explícito e `sem_dados`, e a tela diz "não houve negócio ganho no período".
 * Zero desenhado como barra seria lido como "vendemos nada" — que é diferente
 * de "ninguém fechou nada neste recorte".
 */
import { useState } from "react";

import { EmptyState } from "@/components/empty";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ChartBar } from "@/lib/ui/icons";

const CELULA_DE_NUMERO = "text-right tabular-nums";

type Atalho = "mes" | "30" | "90";

/** Dia civil de hoje, no fuso do navegador — só para os atalhos de período. */
function diaISO(instante: Date): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${instante.getFullYear()}-${dois(instante.getMonth() + 1)}-${dois(instante.getDate())}`;
}

function periodoDoAtalho(atalho: Atalho): { de: string; ate: string } | null {
  if (atalho === "mes") return null; // o servidor responde o mês da ORGANIZAÇÃO
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - (atalho === "30" ? 29 : 89));
  return { de: diaISO(inicio), ate: diaISO(hoje) };
}

export function DashboardComercial() {
  const t = useT();
  const [periodo, setPeriodo] = useState<{ de: string; ate: string } | null>(null);
  const { data, isLoading, isError } = useCommercialReport(periodo);
  const relatorio = data?.data;

  const atalhoAtivo: Atalho | "outro" = periodo === null ? "mes" : "outro";
  const de = periodo?.de ?? relatorio?.janela.de ?? "";
  const ate = periodo?.ate ?? relatorio?.janela.ate ?? "";

  const seletor = (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={atalhoAtivo}
        onValueChange={(valor) => {
          if (valor === "outro") return; // as datas abaixo já são o "outro"
          setPeriodo(periodoDoAtalho(valor as Atalho));
        }}
      >
        <SelectTrigger className="w-44" aria-label={t("Período")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="mes">{t("Este mês")}</SelectItem>
          <SelectItem value="30">{t("Últimos 30 dias")}</SelectItem>
          <SelectItem value="90">{t("Últimos 90 dias")}</SelectItem>
          <SelectItem value="outro">{t("Período personalizado")}</SelectItem>
        </SelectContent>
      </Select>
      <label className="flex items-center gap-1 text-sm text-muted-foreground">
        {t("De")}
        <Input
          type="date"
          className="w-40"
          value={de}
          max={ate || undefined}
          onChange={(e) => {
            if (e.target.value) setPeriodo({ de: e.target.value, ate: ate || e.target.value });
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-sm text-muted-foreground">
        {t("Até")}
        <Input
          type="date"
          className="w-40"
          value={ate}
          min={de || undefined}
          onChange={(e) => {
            if (e.target.value) setPeriodo({ de: de || e.target.value, ate: e.target.value });
          }}
        />
      </label>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        {seletor}
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      </div>
    );
  }

  if (isError || !relatorio) {
    return (
      <div className="flex flex-col gap-6">
        {seletor}
        <p className="text-sm text-destructive">{t("Erro ao carregar o relatório.")}</p>
      </div>
    );
  }

  if (relatorio.sem_dados) {
    return (
      <div className="flex flex-col gap-6">
        {seletor}
        <EmptyState
          icon={ChartBar}
          headline={t("Nenhum negócio ganho no período.")}
          subcopy={t(
            "Esta tela soma o que já foi ganho: quando um negócio for marcado como ganho no Kanban, o faturamento e os rankings aparecem aqui.",
          )}
        />
      </div>
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

  return (
    <div className="flex flex-col gap-6">
      {seletor}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Faturamento do período")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-8">
          <p className="text-3xl font-semibold tabular-nums">
            {formatCents(relatorio.faturamento_centavos, relatorio.moeda)}
          </p>
          <p className="text-sm text-muted-foreground">
            {relatorio.negocios_ganhos} {t("Negócios ganhos")} · {relatorio.moeda}
          </p>
        </CardContent>
      </Card>

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
    </div>
  );
}
