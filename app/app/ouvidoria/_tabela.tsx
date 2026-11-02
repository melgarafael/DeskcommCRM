import { format } from "date-fns";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { localeDeData } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { CanalDaOuvidoria, StatusDaOuvidoria } from "@/lib/ouvidoria/registro";
import { MANIFESTACOES_POR_PAGINA, type ManifestacaoNaLista } from "@/lib/ouvidoria/tela";

/**
 * A LISTA DA OUVIDORIA (#3611, fatia 3) — quatro colunas e um link.
 *
 * ─── Por que estas quatro colunas ─────────────────────────────────────────
 *
 * Protocolo, data, status e canal: é o que a issue pede para a lista, e é
 * exatamente o que basta para DECIDIR o que abrir. O texto do relato não está
 * aqui de propósito — ele é o dado sigiloso, e a lista não é o lugar de
 * carregar 25 deles para mostrar 25 números (`lib/ouvidoria/tela.ts`).
 *
 * ─── Por que o filtro é LINK, e não um `<Select>` de cliente ──────────────
 *
 * Porque o filtro muda o que o SERVIDOR lê. Com estado no cliente, a página
 * carregaria a lista inteira (ou a primeira página de todos os status) e
 * filtraria no navegador — o defeito que a tela de produtos já pagou caro
 * (`lib/catalogo/busca-da-tela.ts`). Um link por status é também o que deixa o
 * estado na URL: quem manda o endereço para outra pessoa manda o filtro junto.
 *
 * Esta é uma tela de LEITURA: quem monta a página já barrou o papel
 * (`lib/ouvidoria/acesso.ts`). Esconder o botão não autoriza nada — a action
 * cobra de novo.
 */

const STATUS_ROTULO: Record<StatusDaOuvidoria, string> = {
  recebida: "Recebida",
  em_analise: "Em análise",
  concluida: "Concluída",
};

const STATUS_VARIANTE: Record<StatusDaOuvidoria, "default" | "secondary" | "outline"> = {
  recebida: "secondary",
  em_analise: "outline",
  concluida: "default",
};

const CANAL_ROTULO: Record<CanalDaOuvidoria, string> = {
  whatsapp: "WhatsApp",
  web: "Site",
  email: "E-mail",
  telefone: "Telefone",
  presencial: "Presencial",
  outro: "Outro",
};

/** A data como a pessoa lê. Data inválida não derruba a lista: mostra o cru. */
function dataLegivel(iso: string, idioma: Idioma): string {
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return iso;
  return format(data, "dd/MM/yyyy HH:mm", { locale: localeDeData(idioma) });
}

function enderecoDaLista(status: StatusDaOuvidoria | null, pagina: number): string {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (pagina > 1) qs.set("pagina", String(pagina));
  const s = qs.toString();
  return s ? `/app/ouvidoria?${s}` : "/app/ouvidoria";
}

export function TabelaDeManifestacoes({
  manifestacoes,
  pagina,
  total,
  temMais,
  statusFiltro,
  idioma,
  erro,
}: {
  manifestacoes: ManifestacaoNaLista[];
  pagina: number;
  total: number;
  temMais: boolean;
  statusFiltro: StatusDaOuvidoria | null;
  idioma: Idioma;
  /** `true` quando a leitura falhou — a lista vazia seria uma mentira. */
  erro?: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <Button
          asChild
          size="sm"
          variant={statusFiltro === null ? "default" : "ghost"}
          className="text-xs"
        >
          <Link href={enderecoDaLista(null, 1)}>{t("Todas")}</Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant={statusFiltro === "recebida" ? "default" : "ghost"}
          className="text-xs"
        >
          <Link href={enderecoDaLista("recebida", 1)}>{t("Recebidas")}</Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant={statusFiltro === "em_analise" ? "default" : "ghost"}
          className="text-xs"
        >
          <Link href={enderecoDaLista("em_analise", 1)}>{t("Em análise")}</Link>
        </Button>
        <Button
          asChild
          size="sm"
          variant={statusFiltro === "concluida" ? "default" : "ghost"}
          className="text-xs"
        >
          <Link href={enderecoDaLista("concluida", 1)}>{t("Concluídas")}</Link>
        </Button>

        {!erro && (
          <span className="ml-auto text-xs text-muted-foreground">
            {total} {t(total === 1 ? "manifestação" : "manifestações")}
          </span>
        )}
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Protocolo")}</TableHead>
              <TableHead>{t("Canal")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Recebida em")}</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {erro ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  {t("Não foi possível carregar as manifestações.")}
                </TableCell>
              </TableRow>
            ) : manifestacoes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                  <p className="font-medium">{t("Nenhuma manifestação registrada.")}</p>
                  <p className="text-xs">
                    {t("As manifestações aparecem aqui assim que alguém falar com a empresa.")}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              manifestacoes.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-mono text-xs">{m.protocolo}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {t(CANAL_ROTULO[m.canal] ?? m.canal)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTE[m.status]} className="text-xs">
                      {t(STATUS_ROTULO[m.status] ?? m.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {dataLegivel(m.createdAt, idioma)}
                  </TableCell>
                  <TableCell>
                    <Button asChild size="sm" variant="ghost" className="px-2 text-xs">
                      <Link href={`/app/ouvidoria/${m.id}`}>{t("Ver")}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {!erro && (pagina > 1 || temMais) && (
        <div className="flex items-center justify-between text-sm">
          <Button asChild={pagina > 1} variant="outline" size="sm" disabled={pagina <= 1}>
            {pagina > 1 ? (
              <Link href={enderecoDaLista(statusFiltro, pagina - 1)}>{t("Anterior")}</Link>
            ) : (
              <span>{t("Anterior")}</span>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Página")} {pagina}
            {" · "}
            {MANIFESTACOES_POR_PAGINA} {t("por página")}
          </span>
          <Button asChild={temMais} variant="outline" size="sm" disabled={!temMais}>
            {temMais ? (
              <Link href={enderecoDaLista(statusFiltro, pagina + 1)}>{t("Próxima")}</Link>
            ) : (
              <span>{t("Próxima")}</span>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
