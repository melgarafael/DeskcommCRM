"use client";

import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

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
import { cn } from "@/lib/utils";
import { CaretDown, CaretLeft, CaretRight, CaretUp, CircleNotch } from "@/lib/ui/icons";

const TAMANHOS = [25, 50, 100, 200];
const LIMITE_PADRAO = 50;

/**
 * Tamanhos PADRÃO da grade. A visão inicial é compacta e uniforme — todas as
 * colunas com a mesma largura e todas as linhas com uma só linha de texto
 * (truncada). O conteúdo grande se lê ALARGANDO a coluna ou AUMENTANDO a altura
 * da linha, arrastando a borda correspondente.
 */
const LARGURA_MINIMA = 80;
const LARGURA_MAXIMA = 1200;
const LARGURA_PADRAO = 200;
const ALTURA_MINIMA = 28;
const ALTURA_MAXIMA = 600;
/** Altura natural de uma linha compacta, usada quando não dá para medir o DOM. */
const ALTURA_PADRAO = 32;
/** Quanto o teclado move a alça de redimensionamento por seta (acessibilidade). */
const PASSO_TECLADO = 24;

type Medidas = Record<string, number>;

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

function limitar(valor: number, minimo: number, maximo: number): number {
  return Math.min(maximo, Math.max(minimo, valor));
}

/** Lê um mapa de medidas do `localStorage`, descartando entradas corrompidas. */
function lerMedidas(chave: string | null): Medidas {
  if (!chave) return {};
  try {
    const bruto = window.localStorage.getItem(chave);
    if (!bruto) return {};
    const dado = JSON.parse(bruto) as Record<string, unknown>;
    const limpo: Medidas = {};
    for (const [k, v] of Object.entries(dado)) {
      if (typeof v === "number" && Number.isFinite(v)) limpo[k] = v;
    }
    return limpo;
  } catch {
    return {};
  }
}

export function ExploradorDeDados({ connectionId }: Props) {
  const t = useT();
  const catalogo = useCatalogoExterno(connectionId);

  const [selecionada, setSelecionada] = useState<TabelaExterna | null>(null);
  const [limite, setLimite] = useState(LIMITE_PADRAO);
  const [offset, setOffset] = useState(0);
  const [ordem, setOrdem] = useState<{ coluna: string; desc: boolean } | null>(null);
  const [larguras, setLarguras] = useState<Medidas>({});
  const [alturas, setAlturas] = useState<Medidas>({});

  // Os refs espelham o estado para que o fim do arraste (pointerup) persista o
  // valor mais recente sem depender de um estado que ainda não re-renderizou.
  const largurasRef = useRef<Medidas>({});
  const alturasRef = useRef<Medidas>({});
  const baseTabela = selecionada ? chaveDaTabela(selecionada) : null;
  const chaveLarguras = baseTabela ? `${baseTabela}:larguras` : null;
  const chaveAlturas = baseTabela ? `${baseTabela}:alturas` : null;

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

  function chaveDaTabela(tabela: TabelaExterna): string {
    return `external-db:${connectionId}:${tabela.schema}.${tabela.nome}`;
  }

  function selecionar(tabela: TabelaExterna) {
    setSelecionada(tabela);
    setOffset(0);
    setOrdem(null);
    // Retoma os ajustes salvos da tabela escolhida, se houver; sem ajuste, a
    // grade nasce nos tamanhos padrão. Feito aqui (e não num efeito) para não
    // renderizar duas vezes ao trocar de tabela.
    const base = chaveDaTabela(tabela);
    const largurasSalvas = lerMedidas(`${base}:larguras`);
    const alturasSalvas = lerMedidas(`${base}:alturas`);
    largurasRef.current = largurasSalvas;
    alturasRef.current = alturasSalvas;
    setLarguras(largurasSalvas);
    setAlturas(alturasSalvas);
  }

  function ordenarPor(coluna: string) {
    setOffset(0);
    setOrdem((atual) =>
      atual?.coluna === coluna ? { coluna, desc: !atual.desc } : { coluna, desc: false },
    );
  }

  const linhas = dados.data?.linhas ?? [];
  const colunas = dados.data?.colunas ?? [];

  function aplicarLarguras(proximas: Medidas) {
    largurasRef.current = proximas;
    setLarguras(proximas);
  }

  function aplicarAlturas(proximas: Medidas) {
    alturasRef.current = proximas;
    setAlturas(proximas);
  }

  function persistir(chave: string | null, medida: Medidas) {
    if (!chave) return;
    try {
      window.localStorage.setItem(chave, JSON.stringify(medida));
    } catch {
      // Sem persistência o ajuste continua valendo nesta sessão.
    }
  }

  function larguraDe(coluna: string): number {
    return larguras[coluna] ?? LARGURA_PADRAO;
  }

  /**
   * PK como lista, sempre. A introspecção já garante `string[]`, mas o cliente
   * não pode confiar no contrato de um dado externo — uma resposta antiga em
   * cache ou um servidor em rollout pode trazer o literal `"{id}"`, e `.map`
   * nele derrubava a tela inteira.
   */
  function colunasPk(): string[] {
    const pk = selecionada?.chavePrimaria;
    return Array.isArray(pk) ? pk : [];
  }

  /** Chave estável da linha (pela PK quando existe; pelo índice quando não). */
  function chaveDaLinha(linha: Record<string, unknown>, indice: number): string {
    const pk = colunasPk();
    if (pk.length === 0) return `#${indice}`;
    return pk.map((coluna) => celula(linha[coluna])).join("|");
  }

  function alturaAtual(elemento: HTMLElement, chave: string): number {
    const salva = alturasRef.current[chave];
    if (salva !== undefined) return salva;
    const medida = elemento.closest("tr")?.getBoundingClientRect().height;
    return medida && medida > 0 ? medida : ALTURA_PADRAO;
  }

  function redimensionarColunaTeclado(evento: ReactKeyboardEvent<HTMLElement>, coluna: string) {
    const passo =
      evento.key === "ArrowLeft" ? -PASSO_TECLADO : evento.key === "ArrowRight" ? PASSO_TECLADO : 0;
    if (passo === 0) return;
    evento.preventDefault();
    const proxima = limitar(larguraDe(coluna) + passo, LARGURA_MINIMA, LARGURA_MAXIMA);
    aplicarLarguras({ ...largurasRef.current, [coluna]: proxima });
    persistir(chaveLarguras, largurasRef.current);
  }

  function redimensionarLinhaTeclado(
    evento: ReactKeyboardEvent<HTMLElement>,
    chave: string,
  ) {
    const passo =
      evento.key === "ArrowUp" ? -PASSO_TECLADO : evento.key === "ArrowDown" ? PASSO_TECLADO : 0;
    if (passo === 0) return;
    evento.preventDefault();
    const proxima = limitar(
      alturaAtual(evento.currentTarget, chave) + passo,
      ALTURA_MINIMA,
      ALTURA_MAXIMA,
    );
    aplicarAlturas({ ...alturasRef.current, [chave]: proxima });
    persistir(chaveAlturas, alturasRef.current);
  }

  function iniciarRedimensionamentoColuna(
    evento: ReactPointerEvent<HTMLElement>,
    coluna: string,
  ) {
    if (evento.button !== 0) return;
    evento.preventDefault();
    evento.stopPropagation();
    const inicioX = evento.clientX;
    const larguraInicial = larguraDe(coluna);
    evento.currentTarget.setPointerCapture?.(evento.pointerId);

    const aoMover = (movimento: PointerEvent) => {
      const proxima = limitar(
        larguraInicial + (movimento.clientX - inicioX),
        LARGURA_MINIMA,
        LARGURA_MAXIMA,
      );
      aplicarLarguras({ ...largurasRef.current, [coluna]: proxima });
    };
    const aoSoltar = () => {
      window.removeEventListener("pointermove", aoMover);
      window.removeEventListener("pointerup", aoSoltar);
      persistir(chaveLarguras, largurasRef.current);
    };
    window.addEventListener("pointermove", aoMover);
    window.addEventListener("pointerup", aoSoltar);
  }

  function iniciarRedimensionamentoLinha(
    evento: ReactPointerEvent<HTMLElement>,
    chave: string,
  ) {
    if (evento.button !== 0) return;
    evento.preventDefault();
    evento.stopPropagation();
    const inicioY = evento.clientY;
    const alturaInicial = alturaAtual(evento.currentTarget, chave);
    evento.currentTarget.setPointerCapture?.(evento.pointerId);

    const aoMover = (movimento: PointerEvent) => {
      const proxima = limitar(
        alturaInicial + (movimento.clientY - inicioY),
        ALTURA_MINIMA,
        ALTURA_MAXIMA,
      );
      aplicarAlturas({ ...alturasRef.current, [chave]: proxima });
    };
    const aoSoltar = () => {
      window.removeEventListener("pointermove", aoMover);
      window.removeEventListener("pointerup", aoSoltar);
      persistir(chaveAlturas, alturasRef.current);
    };
    window.addEventListener("pointermove", aoMover);
    window.addEventListener("pointerup", aoSoltar);
  }

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
                        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent-soft ${
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
                <Table className="table-fixed">
                  <colgroup>
                    {colunas.map((coluna) => (
                      <col key={coluna} style={{ width: `${larguraDe(coluna)}px` }} />
                    ))}
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      {colunas.map((coluna) => {
                        const ehPk = colunasPk().includes(coluna);
                        const ordenadaAqui = ordem?.coluna === coluna;
                        return (
                          <TableHead
                            key={coluna}
                            className="relative whitespace-nowrap pr-4"
                            style={{ width: `${larguraDe(coluna)}px` }}
                          >
                            <button
                              type="button"
                              onClick={() => ordenarPor(coluna)}
                              className="inline-flex max-w-full items-center gap-1 hover:underline"
                              title={ehPk ? t("Chave primária") : undefined}
                            >
                              {ehPk && (
                                <span className="rounded-md bg-surface-elevated px-1 text-[10px] font-semibold text-text-muted">
                                  PK
                                </span>
                              )}
                              <span className="min-w-0 truncate">{coluna}</span>
                              {ordenadaAqui &&
                                (ordem?.desc ? (
                                  <CaretDown size={12} aria-hidden />
                                ) : (
                                  <CaretUp size={12} aria-hidden />
                                ))}
                            </button>
                            <span
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={t("Ajustar largura da coluna")}
                              title={t("Arraste para ajustar a largura")}
                              tabIndex={0}
                              onPointerDown={(evento) =>
                                iniciarRedimensionamentoColuna(evento, coluna)
                              }
                              onKeyDown={(evento) => redimensionarColunaTeclado(evento, coluna)}
                              className="group absolute inset-y-0 right-0 flex w-2 cursor-col-resize touch-none select-none items-stretch justify-center focus-visible:outline-hidden"
                            >
                              <span
                                aria-hidden
                                className="w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary"
                              />
                            </span>
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {linhas.map((linha, i) => {
                      const chaveLinha = chaveDaLinha(linha, i);
                      const altura = alturas[chaveLinha];
                      return (
                        <TableRow key={chaveLinha}>
                          {colunas.map((coluna) => (
                            <TableCell
                              key={coluna}
                              className="relative p-0 align-top font-mono text-xs"
                            >
                              <div
                                className={cn(
                                  "px-2 py-2",
                                  altura === undefined
                                    ? "truncate"
                                    : "overflow-hidden whitespace-pre-wrap break-words",
                                )}
                                style={altura === undefined ? undefined : { height: altura }}
                                title={celula(linha[coluna])}
                              >
                                {celula(linha[coluna])}
                              </div>
                              <span
                                role="separator"
                                aria-orientation="horizontal"
                                aria-label={t("Ajustar altura da linha")}
                                title={t("Arraste para ajustar a altura")}
                                tabIndex={0}
                                onPointerDown={(evento) =>
                                  iniciarRedimensionamentoLinha(evento, chaveLinha)
                                }
                                onKeyDown={(evento) =>
                                  redimensionarLinhaTeclado(evento, chaveLinha)
                                }
                                className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize touch-none select-none hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-hidden"
                              />
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
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
