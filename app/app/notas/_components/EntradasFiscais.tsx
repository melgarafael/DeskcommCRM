"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { EmptyState } from "@/components/empty";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import {
  ROTULO_DA_ENTRADA,
  STATUS_DA_ENTRADA,
  identificacaoDaEntrada,
  type EntradaFiscal,
  type Pagavel,
  type StatusDaEntrada,
} from "@/lib/schemas/fiscal-entrada";
import { DownloadSimple, FileText, MagnifyingGlass, X } from "@/lib/ui/icons";

import type { Textos } from "./textos";

const VARIANTE_STATUS: Record<
  StatusDaEntrada,
  NonNullable<React.ComponentProps<typeof Badge>["variant"]>
> = {
  nova: "info",
  manifestada: "neutral",
  importada: "success",
  ignorada: "warning",
};

const ROTULO_PAGAVEL: Record<string, string> = {
  aberto: "Aberto",
  parcial: "Parcial",
  pago: "Pago",
  cancelado: "Cancelado",
};

const EVENTOS = [
  { codigo: "210210", rotulo: "Ciência" },
  { codigo: "210200", rotulo: "Confirmação" },
  { codigo: "210220", rotulo: "Desconhecimento" },
  { codigo: "210240", rotulo: "Não realizada" },
];

/**
 * Aba "Entradas" — as NF-e que emitiram contra o CNPJ (distribuição DF-e).
 * Buscar na SEFAZ → manifestar (libera o XML) → importar (estoque + contas
 * a pagar). Sem manifestação não há XML, e a linha diz isso em vez de um
 * botão de importar que falharia mudo.
 */
export function EntradasFiscais({
  inicial,
  pagaveisIniciais,
  podeSincronizar,
  podeImportar,
  textos,
}: {
  inicial: EntradaFiscal[];
  pagaveisIniciais: Pagavel[];
  podeSincronizar: boolean;
  podeImportar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const tagIdioma = useTagDeIdioma();
  const [entradas, setEntradas] = React.useState(inicial);
  const [pagaveis, setPagaveis] = React.useState(pagaveisIniciais);
  const [carregando, setCarregando] = React.useState(false);
  const [sincronizando, setSincronizando] = React.useState(false);
  const [filtroStatus, setFiltroStatus] = React.useState("");
  const [busca, setBusca] = React.useState("");
  const [expandida, setExpandida] = React.useState<string | null>(null);
  const [eventoPor, setEventoPor] = React.useState<Record<string, string>>({});
  const [agindo, setAgindo] = React.useState<string | null>(null);

  async function recarregar() {
    setCarregando(true);
    try {
      const qs = filtroStatus ? `?status=${filtroStatus}` : "";
      const [corpoEntradas, corpoPagaveis] = await Promise.all([
        apiClient.get<{ data: EntradaFiscal[] }>(`/api/v1/fiscal-entradas${qs}`),
        apiClient.get<{ data: Pagavel[] }>(`/api/v1/financial-pagaveis`),
      ]);
      setEntradas(corpoEntradas.data ?? []);
      setPagaveis(corpoPagaveis.data ?? []);
    } catch (e) {
      showApiError(e);
    } finally {
      setCarregando(false);
    }
  }

  async function sincronizar() {
    setSincronizando(true);
    try {
      const corpo = await apiClient.post<{
        data: { novas: number; atualizadas: number; aviso: string | null; cstat: string | null };
      }>(`/api/v1/fiscal-entradas`, {});
      const d = corpo.data;
      toast.success(t(`${d.novas} nova(s), ${d.atualizadas} atualizada(s)`));
      if (d.aviso === "AGUARDAR_1H") {
        toast.warning(textos.aguardarSefaz);
      }
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setSincronizando(false);
    }
  }

  async function acao(id: string, caminho: string, corpo: unknown, okMsg: string) {
    setAgindo(id + caminho);
    try {
      await apiClient.post(`/api/v1/fiscal-entradas/${id}/${caminho}`, corpo);
      toast.success(okMsg);
      await recarregar();
    } catch (e) {
      showApiError(e);
    } finally {
      setAgindo(null);
    }
  }

  function baixarXml(e: EntradaFiscal) {
    if (!e.xml) return;
    const blob = new Blob([e.xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nfe-entrada-${e.chave}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const visiveis = entradas.filter((e) => {
    const b = busca.trim().toLowerCase();
    if (!b) return true;
    return (
      e.emitente_nome.toLowerCase().includes(b) ||
      e.emitente_cnpj.includes(b.replace(/\D/g, "")) ||
      e.chave.includes(b.replace(/\D/g, "")) ||
      String(e.numero ?? "").includes(b)
    );
  });

  const pagaveisPorEntrada = React.useMemo(() => {
    const mapa = new Map<string, Pagavel[]>();
    for (const p of pagaveis) {
      if (!p.entrada_id) continue;
      const lista = mapa.get(p.entrada_id) ?? [];
      lista.push(p);
      mapa.set(p.entrada_id, lista);
    }
    return mapa;
  }, [pagaveis]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {podeSincronizar && (
          <Button onClick={sincronizar} disabled={sincronizando}>
            {sincronizando ? t("Buscando…") : textos.buscarSefaz}
          </Button>
        )}
        <div className="flex items-center gap-2">
          <MagnifyingGlass size={16} className="text-muted-foreground" />
          <Input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("emitente, CNPJ, chave…")}
            className="h-9 w-56"
          />
        </div>
        <select
          value={filtroStatus}
          onChange={(e) => {
            setFiltroStatus(e.target.value);
          }}
          onBlur={() => void recarregar()}
          aria-label={textos.status}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{textos.todos}</option>
          {STATUS_DA_ENTRADA.map((s) => (
            <option key={s} value={s}>
              {ROTULO_DA_ENTRADA[s]}
            </option>
          ))}
        </select>
        {(busca.trim() || filtroStatus) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setBusca("");
              setFiltroStatus("");
              void recarregar();
            }}
          >
            <X size={14} /> {textos.limparFiltros}
          </Button>
        )}
      </div>

      {carregando ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : visiveis.length === 0 ? (
        <EmptyState
          icon={FileText}
          headline={textos.nenhumaEntrada}
          subcopy={t("Clique em Buscar na SEFAZ para puxar as notas emitidas contra o CNPJ.")}
          primary={undefined}
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead>{textos.numNota}</TableHead>
                <TableHead>{textos.fornecedor}</TableHead>
                <TableHead>{textos.data}</TableHead>
                <TableHead className="text-right">{textos.valorTotal}</TableHead>
                <TableHead>{textos.status}</TableHead>
                <TableHead>{textos.detalhe}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiveis.map((e) => {
                const aberta = expandida === e.id;
                const temXml = !!e.xml && e.itens_json.length > 0;
                return (
                  <React.Fragment key={e.id}>
                    <TableRow>
                      <TableCell className="font-medium">
                        {identificacaoDaEntrada(e.numero, e.serie)}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-56 truncate" title={e.emitente_nome}>
                          {e.emitente_nome}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {e.emitente_cnpj}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {e.dh_emi ? new Date(e.dh_emi).toLocaleDateString(tagIdioma) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {comoMoeda(e.valor_total_cents, "BRL")}
                      </TableCell>
                      <TableCell>
                        <Badge variant={VARIANTE_STATUS[e.status]}>
                          {ROTULO_DA_ENTRADA[e.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <button
                          type="button"
                          className="underline underline-offset-4"
                          onClick={() => setExpandida(aberta ? null : e.id)}
                        >
                          {aberta ? "−" : "+"}
                        </button>
                      </TableCell>
                    </TableRow>
                    {aberta && (
                      <TableRow className="bg-muted/20 hover:bg-muted/20">
                        <TableCell colSpan={6}>
                          <div className="space-y-3 p-1 text-sm">
                            <p className="text-xs break-all text-muted-foreground">
                              {textos.chaveAcesso}: {e.chave}
                            </p>
                            {e.manifestacao && (
                              <p className="text-xs">
                                {textos.manifestar}: <strong>{e.manifestacao}</strong>
                                {e.manifestada_em
                                  ? ` · ${new Date(e.manifestada_em).toLocaleString(tagIdioma)}`
                                  : ""}
                              </p>
                            )}
                            {temXml ? (
                              <>
                                <div>
                                  <p className="mb-1 font-medium">
                                    {textos.itensLabel} ({e.itens_json.length})
                                  </p>
                                  <ul className="space-y-1 text-xs">
                                    {e.itens_json.map((it, i) => (
                                      <li key={i} className="flex justify-between gap-2">
                                        <span className="truncate">
                                          {it.codigo} · {it.descricao} · {it.quantidade}{" "}
                                          {it.unidade ?? "UN"}
                                        </span>
                                        <span className="tabular-nums">
                                          {comoMoeda(it.total_cents, "BRL")}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                                {e.cobranca_json.length > 0 && (
                                  <div>
                                    <p className="mb-1 font-medium">{textos.duplicatas}</p>
                                    <ul className="space-y-1 text-xs">
                                      {e.cobranca_json.map((d, i) => (
                                        <li key={i} className="flex justify-between gap-2">
                                          <span>
                                            {d.numero || `#${i + 1}`} · {d.vencimento || "—"}
                                          </span>
                                          <span className="tabular-nums">
                                            {comoMoeda(d.valor_cents, "BRL")}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {(pagaveisPorEntrada.get(e.id) ?? []).length > 0 && (
                                  <div>
                                    <p className="mb-1 font-medium">{textos.contasPagar}</p>
                                    <ul className="space-y-1 text-xs">
                                      {(pagaveisPorEntrada.get(e.id) ?? []).map((p) => (
                                        <li
                                          key={p.id}
                                          className="flex items-center justify-between gap-2"
                                        >
                                          <span>
                                            {p.parcela_n}/{p.total_parcelas} · {p.vencimento}
                                          </span>
                                          <div className="flex items-center gap-2">
                                            <span className="tabular-nums">
                                              {comoMoeda(p.valor_original_cents, "BRL")}
                                            </span>
                                            <Badge
                                              variant={p.status === "pago" ? "success" : "neutral"}
                                              className="text-[10px]"
                                            >
                                              {t(ROTULO_PAGAVEL[p.status] ?? p.status)}
                                            </Badge>
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                {textos.semXmlEntrada}
                              </p>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              {e.xml && (
                                <Button size="sm" variant="outline" onClick={() => baixarXml(e)}>
                                  <DownloadSimple size={14} /> {textos.baixarXml}
                                </Button>
                              )}
                              {podeSincronizar &&
                                (e.status === "nova" || e.status === "manifestada") && (
                                  <>
                                    <select
                                      value={eventoPor[e.id] ?? "210210"}
                                      onChange={(ev) =>
                                        setEventoPor((m) => ({ ...m, [e.id]: ev.target.value }))
                                      }
                                      aria-label={textos.manifestar}
                                      className="h-8 rounded-md border bg-background px-2 text-xs"
                                    >
                                      {EVENTOS.map((ev) => (
                                        <option key={ev.codigo} value={ev.codigo}>
                                          {ev.rotulo}
                                        </option>
                                      ))}
                                    </select>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={agindo === e.id + "manifestar"}
                                      onClick={() =>
                                        void acao(
                                          e.id,
                                          "manifestar",
                                          { evento: eventoPor[e.id] ?? "210210" },
                                          textos.manifestadaOk,
                                        )
                                      }
                                    >
                                      {textos.manifestar}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={agindo === e.id + "ignorar"}
                                      onClick={() =>
                                        void acao(e.id, "ignorar", {}, textos.ignoradaOk)
                                      }
                                    >
                                      {textos.ignorarEntrada}
                                    </Button>
                                  </>
                                )}
                              {podeImportar &&
                                temXml &&
                                e.status !== "importada" &&
                                e.status !== "ignorada" && (
                                  <Button
                                    size="sm"
                                    disabled={agindo === e.id + "importar"}
                                    onClick={() =>
                                      void acao(e.id, "importar", {}, textos.importadaOk)
                                    }
                                  >
                                    {textos.importarEntrada}
                                  </Button>
                                )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
