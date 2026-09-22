"use client";

import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { EmptyFilterResults } from "@/components/empty";
import { NexusPageHeader } from "@/components/nexus-ui/layout/NexusPageHeader";
import { useT } from "@/hooks/i18n/useT";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import { randomId } from "@/lib/random-id";

type Situacao = "aberto" | "parcial" | "pago" | "vencido" | "cancelado";

interface Recebivel {
  id: string;
  order_id: string | null;
  invoice_id: string | null;
  contact_id: string | null;
  parcela_n: number;
  total_parcelas: number;
  valor_original_cents: number;
  vencimento: string;
  status: string;
  forma_pagamento: string | null;
  situacao: Situacao;
  pago_cents: number;
  saldo_cents: number;
  dias_atraso: number;
  contato_nome: string | null;
  contato_cidade: string | null;
  pedido_numero: number | null;
}

interface Pagamento {
  id: string;
  valor_cents: number;
  pago_em: string;
  forma_pagamento: string | null;
  conta: string | null;
  observacao: string | null;
}

const VARIANTE_SITUACAO: Record<Situacao, "success" | "warning" | "error" | "info"> = {
  pago: "success",
  parcial: "info",
  aberto: "warning",
  vencido: "error",
  cancelado: "warning",
};

function dataIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function hojeIso(): string {
  return dataIso(new Date());
}
function maisDias(n: number): string {
  return dataIso(new Date(Date.now() + n * 86400000));
}

export function FinanceiroClient({ podeRegistrar }: { podeRegistrar: boolean }) {
  const t = useT();
  const [aba, setAba] = React.useState("recebiveis");
  const [linhas, setLinhas] = React.useState<Recebivel[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [pagina, setPagina] = React.useState(1);
  const [busca, setBusca] = React.useState("");
  const [buscaAplicada, setBuscaAplicada] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [de, setDe] = React.useState("");
  const [ate, setAte] = React.useState("");
  const [kpis, setKpis] = React.useState<Record<string, number> | null>(null);
  const [divergencias, setDivergencias] = React.useState<
    { tipo: string; [k: string]: unknown }[] | null
  >(null);
  const [expandido, setExpandido] = React.useState<string | null>(null);

  const carregar = React.useCallback(
    async (pag: number, filtros: { busca: string; status: string; de: string; ate: string }) => {
      try {
        const qs = new URLSearchParams({ page: String(pag), limit: "50" });
        if (filtros.busca.trim()) qs.set("busca", filtros.busca.trim());
        if (filtros.status) qs.set("status", filtros.status);
        if (filtros.de) qs.set("de", filtros.de);
        if (filtros.ate) qs.set("ate", filtros.ate);
        const corpo = await apiClient.get<{
          data: Recebivel[];
          meta?: { page?: number; limit?: number; total?: number };
        }>(`/api/v1/financeiro/recebiveis?${qs}`);
        setLinhas(corpo.data ?? []);
        setTotal(corpo.meta?.total ?? 0);
      } catch (e) {
        showApiError(e);
        setLinhas([]);
      }
    },
    [],
  );

  const carregarKpis = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: Record<string, number> }>(
        "/api/v1/financeiro/dashboard",
      );
      setKpis(corpo.data ?? null);
    } catch {
      setKpis(null);
    }
  }, []);

  const carregarConciliacao = React.useCallback(async () => {
    try {
      const corpo = await apiClient.get<{ data: { tipo: string; [k: string]: unknown }[] }>(
        "/api/v1/financeiro/conciliacao",
      );
      setDivergencias(corpo.data ?? []);
    } catch (e) {
      showApiError(e);
      setDivergencias([]);
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar(1, { busca: "", status: "", de: "", ate: "" });
    void carregarKpis();
  }, [carregar, carregarKpis]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (aba === "conciliacao" && divergencias === null) void carregarConciliacao();
  }, [aba, divergencias, carregarConciliacao]);

  function aplicarFiltros() {
    setPagina(1);
    void carregar(1, { busca, status, de, ate });
  }

  function filtroRapido(qual: "hoje" | "vencidos" | "7d" | "30d") {
    const h = hojeIso();
    if (qual === "hoje") {
      setDe(h);
      setAte(h);
      setStatus("");
    } else if (qual === "vencidos") {
      setDe("");
      setAte("");
      setStatus("vencido");
    } else {
      setDe(h);
      setAte(maisDias(qual === "7d" ? 7 : 30));
      setStatus("");
    }
    setPagina(1);
    const f = {
      busca,
      status: qual === "vencidos" ? "vencido" : "",
      de: qual === "vencidos" ? "" : h,
      ate: qual === "vencidos" ? "" : qual === "hoje" ? h : maisDias(qual === "7d" ? 7 : 30),
    };
    void carregar(1, f);
  }

  const totalPaginas = Math.max(1, Math.ceil(total / 50));

  function mudarPagina(p: number) {
    setPagina(p);
    void carregar(p, { busca: buscaAplicada, status, de, ate });
  }

  return (
    <div className="space-y-6 p-6">
      <NexusPageHeader
        title={t("Financeiro")}
        subtitle={t("Contas a receber, recebimentos e conciliação.")}
      />

      {kpis === null ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">{t("A receber")}</p>
            <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
              {comoMoeda(kpis.a_receber_cents ?? 0, "BRL")}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">{t("Vencido")}</p>
            <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
              {comoMoeda(kpis.vencido_cents ?? 0, "BRL")}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">{t("Vence hoje / 7 dias")}</p>
            <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
              {comoMoeda(kpis.vence_hoje_cents ?? 0, "BRL")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              7d: {comoMoeda(kpis.vence_7d_cents ?? 0, "BRL")}
            </p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">{t("Recebido (período)")}</p>
            <p className="mt-1 text-2xl font-semibold text-text tabular-nums">
              {comoMoeda(kpis.recebido_periodo_cents ?? 0, "BRL")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {t("Vendas")}: {comoMoeda(kpis.vendas_periodo_cents ?? 0, "BRL")}
            </p>
          </Card>
        </div>
      )}

      <Tabs value={aba} onValueChange={setAba}>
        <TabsList>
          <TabsTrigger value="recebiveis">{t("Contas a receber")}</TabsTrigger>
          <TabsTrigger value="conciliacao">{t("Conciliação")}</TabsTrigger>
        </TabsList>

        <TabsContent value="recebiveis" className="mt-4 space-y-3">
          <Card className="space-y-3 p-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <div className="space-y-1.5">
                <Label htmlFor="fin-busca">{t("Buscar")}</Label>
                <Input
                  id="fin-busca"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder={t("cliente…")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fin-status">{t("Status")}</Label>
                <Select
                  value={status || "__todos"}
                  onValueChange={(v) => setStatus(v === "__todos" ? "" : v)}
                >
                  <SelectTrigger id="fin-status" className="h-10 w-full">
                    <SelectValue placeholder={t("Todos")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__todos">{t("Todos")}</SelectItem>
                    <SelectItem value="aberto">{t("Em aberto")}</SelectItem>
                    <SelectItem value="parcial">{t("Parcial")}</SelectItem>
                    <SelectItem value="pago">{t("Pago")}</SelectItem>
                    <SelectItem value="vencido">{t("Vencido")}</SelectItem>
                    <SelectItem value="cancelado">{t("Cancelado")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fin-de">{t("Vence de")}</Label>
                <Input id="fin-de" type="date" value={de} onChange={(e) => setDe(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fin-ate">{t("Vence até")}</Label>
                <Input
                  id="fin-ate"
                  type="date"
                  value={ate}
                  onChange={(e) => setAte(e.target.value)}
                />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  onClick={() => {
                    setBuscaAplicada(busca);
                    aplicarFiltros();
                  }}
                >
                  {t("Filtrar")}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["hoje", t("Hoje")],
                  ["vencidos", t("Vencidos")],
                  ["7d", t("Próximos 7 dias")],
                  ["30d", t("Próximos 30 dias")],
                ] as const
              ).map(([k, rotulo]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => filtroRapido(k)}
                  className="rounded-full border px-2.5 py-1 text-xs font-medium hover:border-accent"
                >
                  {rotulo}
                </button>
              ))}
            </div>
          </Card>

          {linhas === null ? (
            <div className="space-y-2" aria-live="polite">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : linhas.length === 0 ? (
            <EmptyFilterResults
              primary={{
                label: t("Limpar filtros"),
                onClick: () => {
                  setBusca("");
                  setBuscaAplicada("");
                  setStatus("");
                  setDe("");
                  setAte("");
                  setPagina(1);
                  void carregar(1, { busca: "", status: "", de: "", ate: "" });
                },
              }}
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2 font-medium">{t("Vencimento")}</th>
                      <th className="px-3 py-2 font-medium">{t("Cliente")}</th>
                      <th className="px-3 py-2 font-medium">{t("Parcela")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Valor")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Saldo")}</th>
                      <th className="px-3 py-2 font-medium">{t("Status")}</th>
                      <th className="px-3 py-2">
                        <span className="sr-only">{t("Ações")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {linhas.map((l) => (
                      <React.Fragment key={l.id}>
                        <tr className="border-b align-top last:border-0 hover:bg-muted/50">
                          <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                            {new Date(`${l.vencimento}T12:00:00Z`).toLocaleDateString()}
                            {l.dias_atraso > 0 && (
                              <span className="block text-xs text-error-fg">+{l.dias_atraso}d</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className="font-medium">{l.contato_nome ?? "—"}</span>
                            {l.contato_cidade && (
                              <span className="block text-xs text-muted-foreground">
                                {l.contato_cidade}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                            {l.parcela_n}/{l.total_parcelas}
                            {l.pedido_numero != null && (
                              <span className="block text-xs text-muted-foreground">
                                #{l.pedido_numero}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                            {comoMoeda(l.valor_original_cents, "BRL")}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                            {comoMoeda(l.saldo_cents, "BRL")}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={VARIANTE_SITUACAO[l.situacao]}>{l.situacao}</Badge>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setExpandido(expandido === l.id ? null : l.id)}
                            >
                              {expandido === l.id ? t("Fechar") : t("Detalhe")}
                            </Button>
                          </td>
                        </tr>
                        {expandido === l.id && (
                          <tr className="border-b bg-muted/30">
                            <td colSpan={7} className="px-3 py-3">
                              <DetalheRecebivel
                                id={l.id}
                                podeRegistrar={podeRegistrar}
                                aoMudar={() => {
                                  void carregar(pagina, { busca: buscaAplicada, status, de, ate });
                                  void carregarKpis();
                                }}
                              />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPaginas > 1 && (
                <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pagina <= 1}
                    onClick={() => mudarPagina(pagina - 1)}
                  >
                    {t("Anterior")}
                  </Button>
                  <span className="tabular-nums">
                    {t("Página")} {pagina} {t("de")} {totalPaginas} · {total}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pagina >= totalPaginas}
                    onClick={() => mudarPagina(pagina + 1)}
                  >
                    {t("Próxima")}
                  </Button>
                </div>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="conciliacao" className="mt-4">
          {divergencias === null ? (
            <Skeleton className="h-24 w-full" />
          ) : divergencias.length === 0 ? (
            <Card className="p-8 text-center">
              <p className="font-medium">{t("Tudo conciliado")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("Nenhuma divergência entre pedido, NF e financeiro.")}
              </p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {divergencias.map((d, i) => (
                <li key={i}>
                  <Card className="flex flex-wrap items-center gap-2 p-3 text-sm">
                    <Badge variant="warning">{String(d.tipo).replaceAll("_", " ")}</Badge>
                    <span className="text-muted-foreground tabular-nums">
                      {typeof d.total_cents === "number" ? comoMoeda(d.total_cents, "BRL") : ""}
                      {typeof d.valor_cents === "number" ? comoMoeda(d.valor_cents, "BRL") : ""}
                    </span>
                    {(typeof d.order_id === "string" || typeof d.receivable_id === "string") && (
                      <span className="ml-auto flex gap-2">
                        {typeof d.order_id === "string" && (
                          <Button size="sm" variant="outline" asChild>
                            <Link href={`/app/pedidos/${d.order_id}`}>{t("Ver pedido")}</Link>
                          </Button>
                        )}
                      </span>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DetalheRecebivel({
  id,
  podeRegistrar,
  aoMudar,
}: {
  id: string;
  podeRegistrar: boolean;
  aoMudar: () => void;
}) {
  const t = useT();
  const [dados, setDados] = React.useState<{
    pagamentos: Pagamento[];
    pedido: { id: string; numero: number } | null;
    nota: { id: string; numero: number | null } | null;
    situacao: Situacao;
    saldo_cents: number;
  } | null>(null);
  const [valor, setValor] = React.useState("");
  const [pagando, setPagando] = React.useState(false);
  const [chave] = React.useState(() => randomId());

  React.useEffect(() => {
    let vivo = true;
    apiClient
      .get<{ data: NonNullable<typeof dados> }>(`/api/v1/financeiro/recebiveis/${id}`)
      .then((r) => vivo && setDados(r.data))
      .catch(() => vivo && setDados(null));
    return () => {
      vivo = false;
    };
  }, [id]);

  async function pagar() {
    const cents = Math.round((Number(valor.replace(/\./g, "").replace(",", ".")) || 0) * 100);
    if (!cents || cents <= 0) {
      toast.error(t("Valor inválido. Escreva assim: 5.000,00"));
      return;
    }
    setPagando(true);
    try {
      await apiClient.post(
        `/api/v1/financeiro/recebiveis/${id}/pagamentos`,
        { valor_cents: cents },
        { idempotencyKey: chave },
      );
      toast.success(t("Recebimento registrado"));
      setValor("");
      const r = await apiClient.get<{ data: NonNullable<typeof dados> }>(
        `/api/v1/financeiro/recebiveis/${id}`,
      );
      setDados(r.data);
      aoMudar();
    } catch (e) {
      showApiError(e);
    } finally {
      setPagando(false);
    }
  }

  async function estornar(pagamentoId: string) {
    if (!window.confirm(t("Estornar este recebimento?"))) return;
    try {
      await apiClient.delete(`/api/v1/financeiro/pagamentos/${pagamentoId}`);
      toast.success(t("Estornado"));
      const r = await apiClient.get<{ data: NonNullable<typeof dados> }>(
        `/api/v1/financeiro/recebiveis/${id}`,
      );
      setDados(r.data);
      aoMudar();
    } catch (e) {
      showApiError(e);
    }
  }

  if (!dados) return <Skeleton className="h-16 w-full" />;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div>
        <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("Recebimentos")}
        </p>
        {dados.pagamentos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum recebimento ainda.")}</p>
        ) : (
          <ul className="space-y-1">
            {dados.pagamentos.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <span className="tabular-nums">{comoMoeda(p.valor_cents, "BRL")}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(p.pago_em).toLocaleDateString()}
                </span>
                {podeRegistrar && (
                  <Button size="sm" variant="ghost" onClick={() => void estornar(p.id)}>
                    {t("Estornar")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {dados.pedido && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/app/pedidos/${dados.pedido.id}`}>{t("Ver pedido")}</Link>
            </Button>
          )}
        </div>
      </div>
      {podeRegistrar && dados.situacao !== "pago" && dados.situacao !== "cancelado" && (
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Registrar recebimento")}
          </p>
          <div className="flex gap-2">
            <Input
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="0,00"
              inputMode="decimal"
              aria-label={t("Valor recebido")}
            />
            <Button size="sm" onClick={() => void pagar()} disabled={pagando}>
              {pagando ? t("Salvando…") : t("Receber")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("Saldo")}: {comoMoeda(dados.saldo_cents, "BRL")}
          </p>
        </div>
      )}
    </div>
  );
}
