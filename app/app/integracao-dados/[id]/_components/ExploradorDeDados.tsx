"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCatalogoExterno, type TabelaExterna } from "@/hooks/external-db/useCatalogoExterno";
import { useDadosExternos } from "@/hooks/external-db/useDadosExternos";
import { useT } from "@/hooks/i18n/useT";
import { CaretDown, CaretLeft, CaretRight, CaretUp, CircleNotch } from "@/lib/ui/icons";

const TAMANHOS = [25, 50, 100, 200];
const LIMITE_PADRAO = 50;

interface Props {
  connectionId: string;
}

function celula(valor: unknown): string {
  if (valor === null || valor === undefined) return "—";
  if (typeof valor === "object") {
    try {
      return JSON.stringify(valor);
    } catch {
      return "[objeto]";
    }
  }
  return String(valor);
}

export function ExploradorDeDados({ connectionId }: Props) {
  const t = useT();
  const catalogo = useCatalogoExterno(connectionId);

  const [selecionada, setSelecionada] = useState<TabelaExterna | null>(null);
  const [limite, setLimite] = useState(LIMITE_PADRAO);
  const [offset, setOffset] = useState(0);
  const [ordem, setOrdem] = useState<{ coluna: string; desc: boolean } | null>(null);

  const porSchema = useMemo(() => {
    const mapa = new Map<string, TabelaExterna[]>();
    for (const tabela of catalogo.data ?? []) {
      const lista = mapa.get(tabela.schema);
      if (lista) lista.push(tabela);
      else mapa.set(tabela.schema, [tabela]);
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalogo.data]);

  const dados = useDadosExternos(
    {
      connectionId,
      schema: selecionada?.schema ?? "",
      tabela: selecionada?.nome ?? "",
      limit: limite,
      offset,
      ...(ordem ? { orderBy: ordem.coluna, orderDesc: ordem.desc } : {}),
    },
    { enabled: selecionada !== null },
  );

  function selecionar(tabela: TabelaExterna) {
    setSelecionada(tabela);
    setOffset(0);
    setOrdem(null);
  }

  function ordenarPor(coluna: string) {
    setOffset(0);
    setOrdem((atual) =>
      atual?.coluna === coluna ? { coluna, desc: !atual.desc } : { coluna, desc: false },
    );
  }

  const linhas = dados.data?.linhas ?? [];
  const colunas = dados.data?.colunas ?? [];

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      {/* ─── Árvore de tabelas ─── */}
      <aside className="flex min-h-0 flex-col rounded-md border">
        <div className="border-b px-3 py-2 text-sm font-medium">{t("Tabelas")}</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {catalogo.isLoading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <CircleNotch size={16} className="animate-spin" aria-hidden /> {t("Lendo o catálogo…")}
            </div>
          )}
          {catalogo.isError && (
            <p className="p-3 text-sm text-destructive">{t("Não foi possível ler o catálogo.")}</p>
          )}
          {catalogo.isSuccess && porSchema.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">{t("Este banco não tem tabelas visíveis.")}</p>
          )}
          {porSchema.map(([schema, tabelas]) => (
            <div key={schema} className="mb-3">
              <p className="px-2 py-1 text-xs font-semibold uppercase text-muted-foreground">{schema}</p>
              <ul className="space-y-0.5">
                {tabelas.map((tabela) => {
                  const ativa =
                    selecionada?.schema === tabela.schema && selecionada?.nome === tabela.nome;
                  return (
                    <li key={`${tabela.schema}.${tabela.nome}`}>
                      <button
                        type="button"
                        onClick={() => selecionar(tabela)}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent-soft ${
                          ativa ? "bg-accent-soft font-medium" : ""
                        }`}
                      >
                        <span className="truncate">{tabela.nome}</span>
                        {tabela.tipo === "view" && <Badge variant="neutral">{t("view")}</Badge>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      {/* ─── Grade de dados ─── */}
      <section className="flex min-h-0 flex-col rounded-md border">
        {!selecionada && (
          <div className="flex flex-1 items-center justify-center p-10 text-center text-sm text-muted-foreground">
            {t("Escolha uma tabela à esquerda para ver os dados.")}
          </div>
        )}

        {selecionada && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">
                  {selecionada.schema}.{selecionada.nome}
                </span>
                <span className="text-muted-foreground">
                  ~{selecionada.estimativaLinhas.toLocaleString()} {t("linhas (estimativa)")}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={String(limite)}
                  onValueChange={(v) => {
                    setLimite(Number(v));
                    setOffset(0);
                  }}
                >
                  <SelectTrigger className="h-8 w-[110px]" aria-label={t("Linhas por página")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TAMANHOS.map((tam) => (
                      <SelectItem key={tam} value={String(tam)}>
                        {tam} / {t("pág.")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limite))}
                  aria-label={t("Página anterior")}
                >
                  <CaretLeft size={14} aria-hidden />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  disabled={linhas.length < limite}
                  onClick={() => setOffset(offset + limite)}
                  aria-label={t("Próxima página")}
                >
                  <CaretRight size={14} aria-hidden />
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {dados.isLoading && (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                  <CircleNotch size={16} className="animate-spin" aria-hidden /> {t("Carregando dados…")}
                </div>
              )}

              {dados.isError && !dados.isLoading && (
                <p className="p-6 text-sm text-destructive">
                  {t("Não foi possível consultar esta tabela agora.")}
                </p>
              )}

              {!dados.isLoading && !dados.isError && linhas.length === 0 && (
                <p className="p-6 text-sm text-muted-foreground">{t("Nenhuma linha retornada.")}</p>
              )}

              {linhas.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      {colunas.map((coluna) => {
                        const ehPk = selecionada.chavePrimaria.includes(coluna);
                        const ordenadaAqui = ordem?.coluna === coluna;
                        return (
                          <TableHead key={coluna} className="whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => ordenarPor(coluna)}
                              className="inline-flex items-center gap-1 hover:underline"
                              title={ehPk ? t("Chave primária") : undefined}
                            >
                              {ehPk && (
                                <span className="rounded bg-surface-elevated px-1 text-[10px] font-semibold text-text-muted">
                                  PK
                                </span>
                              )}
                              {coluna}
                              {ordenadaAqui &&
                                (ordem?.desc ? (
                                  <CaretDown size={12} aria-hidden />
                                ) : (
                                  <CaretUp size={12} aria-hidden />
                                ))}
                            </button>
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {linhas.map((linha, i) => (
                      <TableRow key={i}>
                        {colunas.map((coluna) => (
                          <TableCell key={coluna} className="max-w-[320px] truncate font-mono text-xs">
                            {celula(linha[coluna])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            <div className="border-t px-3 py-2 text-xs text-muted-foreground">
              {linhas.length > 0
                ? `${offset + 1}–${offset + linhas.length}`
                : t("nada a mostrar")}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
