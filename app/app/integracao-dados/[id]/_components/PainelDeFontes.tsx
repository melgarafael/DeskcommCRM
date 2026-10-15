"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useCatalogoCompleto } from "@/hooks/external-db/useCatalogoCompleto";
import { catalogoExternoQueryKey } from "@/hooks/external-db/useCatalogoExterno";
import { conexoesExternasQueryKey } from "@/hooks/external-db/useConexoesExternas";
import { fontesQueryKey, salvarFontes, useFontesDaConexao } from "@/hooks/external-db/useFontesDaConexao";
import { useT } from "@/hooks/i18n/useT";
import { MAX_DESCRICAO, type Fonte } from "@/lib/external-db/fontes";
import {
  alternarColuna,
  alternarTabela,
  contarLiberadas,
  definirDescricao,
  desmarcarVisiveis,
  filtrarCatalogo,
  fontesNaoEncontradas,
  indiceDaFonte,
  listaValida,
  marcarVisiveis,
  rascunhoMudou,
  tabelaSemColunaDoCliente,
  usarColunasMarcadas,
  usarTodasAsColunas,
  type TabelaDoCatalogo,
} from "@/lib/external-db/painel-de-fontes";
import type { ModoDeFontes } from "@/lib/external-db/types";
import { CaretDown, CaretRight, CircleNotch } from "@/lib/ui/icons";

interface Props {
  connectionId: string;
  /** Só o administrador edita; os demais só leem. */
  canWrite: boolean;
  /** Coluna que identifica o cliente nas conversas (#2280), ou null. */
  colunaDoCliente: string | null;
  /** Abre já expandido (conexão nova ou lista vazia). */
  abertoInicial: boolean;
}

type Rascunho = { modo: ModoDeFontes; fontes: Fonte[] };

function textoDeContagem(t: (s: string) => string, n: number): string {
  return n === 1 ? t("1 tabela liberada") : `${n} ${t("tabelas liberadas")}`;
}

function ResumoDoCabecalho({ guardado, carregando, erro }: { guardado: Rascunho | null; carregando: boolean; erro: boolean }) {
  const t = useT();
  if (carregando) return null;
  if (erro || !guardado) return <Badge variant="error">{t("Não foi possível ler a lista")}</Badge>;
  if (guardado.modo === "all") return <Badge variant="warning">{t("Tudo liberado")}</Badge>;
  if (guardado.fontes.length === 0) return <Badge variant="warning">{t("Nada liberado")}</Badge>;
  return <Badge variant="success">{textoDeContagem(t, guardado.fontes.length)}</Badge>;
}

function ListaSomenteLeitura({ guardado }: { guardado: Rascunho | null }) {
  const t = useT();
  if (!guardado) return null;
  if (guardado.modo === "all") {
    return <p className="text-sm">{t("Tudo liberado: o assistente enxerga tudo que o usuário do banco enxerga.")}</p>;
  }
  if (guardado.fontes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Nenhuma tabela liberada ainda. Só quem administra a organização pode escolher.")}
      </p>
    );
  }
  return (
    <ul className="space-y-1 text-sm">
      {guardado.fontes.map((f) => (
        <li key={`${f.schema}.${f.tabela}`}>
          <span className="font-medium">
            {f.schema}.{f.tabela}
          </span>
          {f.descricao ? <span className="text-muted-foreground"> — {f.descricao}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DetalheDaFonte({
  fonte,
  tabela,
  colunaDoCliente,
  aplicar,
}: {
  fonte: Fonte;
  tabela: TabelaDoCatalogo;
  colunaDoCliente: string | null;
  aplicar: (f: (lista: Fonte[]) => Fonte[]) => void;
}) {
  const t = useT();
  const todas = tabela.colunas.map((c) => c.nome);
  const todasEFuturas = fonte.colunas === null;
  const marcadas = new Set(fonte.colunas ?? todas);
  const nomeDoGrupo = `colunas-${tabela.schema}.${tabela.nome}`;
  return (
    <div className="space-y-3 border-t bg-muted/30 px-3 py-3 text-sm">
      <label className="block space-y-1">
        <span className="text-xs font-medium">{t("Descrição para o assistente (opcional)")}</span>
        <Input
          value={fonte.descricao}
          maxLength={MAX_DESCRICAO}
          placeholder={t("Ex.: pedidos dos clientes, com status e valor")}
          onChange={(e) => aplicar((l) => definirDescricao(l, tabela.schema, tabela.nome, e.target.value))}
        />
        <span className="text-xs text-muted-foreground">
          {fonte.descricao.length}/{MAX_DESCRICAO}
        </span>
      </label>

      {colunaDoCliente !== null && tabelaSemColunaDoCliente(tabela, colunaDoCliente) && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          {t("Esta tabela não tem a coluna que identifica o cliente:")} <code>{colunaDoCliente}</code>.{" "}
          {t("Nas conversas, o assistente não consegue consultá-la.")}
        </p>
      )}

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium">{t("Colunas que o assistente pode ler")}</legend>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={nomeDoGrupo}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            checked={!todasEFuturas}
            onChange={() => aplicar((l) => usarColunasMarcadas(l, tabela, colunaDoCliente))}
          />
          <span>{t("Só as colunas marcadas (recomendado)")}</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={nomeDoGrupo}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
            checked={todasEFuturas}
            onChange={() => aplicar((l) => usarTodasAsColunas(l, tabela.schema, tabela.nome))}
          />
          <span>{t("Todas, inclusive as que forem criadas depois")}</span>
        </label>
        {todasEFuturas ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            {t("Uma coluna nova (por exemplo, uma senha) passaria a ser lida sem ninguém marcar.")}
          </p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {todas.map((coluna) => {
              const ehDoCliente = coluna === colunaDoCliente;
              const marcada = marcadas.has(coluna);
              return (
                <li key={coluna}>
                  <label className="flex items-center gap-2" title={ehDoCliente ? t("Coluna que identifica o cliente: precisa ficar liberada") : undefined}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                      checked={marcada}
                      disabled={ehDoCliente || (marcada && marcadas.size <= 1)}
                      onChange={() => aplicar((l) => alternarColuna(l, tabela, coluna, colunaDoCliente))}
                      aria-label={coluna}
                    />
                    <span className="truncate font-mono text-xs">{coluna}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
    </div>
  );
}

export function PainelDeFontes({ connectionId, canWrite, colunaDoCliente, abertoInicial }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const salvas = useFontesDaConexao(connectionId);
  const [aberto, setAberto] = useState(abertoInicial);
  const catalogo = useCatalogoCompleto(connectionId, { enabled: canWrite && aberto });
  const [alteracoes, setAlteracoes] = useState<Rascunho | null>(null);
  const [busca, setBusca] = useState("");
  const [soViews, setSoViews] = useState(false);
  const [expandida, setExpandida] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const guardado: Rascunho | null = salvas.data
    ? { modo: salvas.data.source_mode, fontes: salvas.data.sources }
    : null;
  const atual = alteracoes ?? guardado;
  const tabelas = useMemo<TabelaDoCatalogo[]>(() => catalogo.data ?? [], [catalogo.data]);
  const visiveis = useMemo(() => filtrarCatalogo(tabelas, { busca, soViews }), [tabelas, busca, soViews]);
  const porSchema = useMemo(() => {
    const mapa = new Map<string, typeof visiveis>();
    for (const tabela of visiveis) {
      const lista = mapa.get(tabela.schema);
      if (lista) lista.push(tabela);
      else mapa.set(tabela.schema, [tabela]);
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visiveis]);

  const mudou = guardado !== null && atual !== null && rascunhoMudou(guardado, atual);
  const podeSalvar = canWrite && mudou && atual !== null && listaValida(atual.fontes) && !salvando;

  function editar(proximo: Partial<Rascunho>) {
    if (!atual) return;
    setAlteracoes({ ...atual, ...proximo });
  }

  function aplicar(f: (lista: Fonte[]) => Fonte[]) {
    if (!atual) return;
    editar({ fontes: f(atual.fontes) });
  }

  async function salvar() {
    if (!atual) return;
    setSalvando(true);
    try {
      const resposta = await salvarFontes(connectionId, { source_mode: atual.modo, sources: atual.fontes });
      qc.setQueryData(fontesQueryKey(connectionId), resposta);
      setAlteracoes(null);
      toast.success(t("Lista salva. O assistente já usa a nova lista."));
      await Promise.all([
        qc.invalidateQueries({ queryKey: conexoesExternasQueryKey }),
        qc.invalidateQueries({ queryKey: catalogoExternoQueryKey(connectionId) }),
      ]);
    } catch (err) {
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  const sumidas = atual && catalogo.isSuccess ? fontesNaoEncontradas(atual.fontes, tabelas) : [];
  const contagem = atual && catalogo.isSuccess ? contarLiberadas(atual.fontes, tabelas) : null;

  return (
    <Card id="fontes" className="overflow-hidden p-0">
      <button
        type="button"
        aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          {aberto ? <CaretDown size={14} aria-hidden /> : <CaretRight size={14} aria-hidden />}
          <span className="font-medium">{t("O que o assistente pode ver")}</span>
        </span>
        <ResumoDoCabecalho guardado={guardado} carregando={salvas.isLoading} erro={salvas.isError} />
      </button>

      {aberto && (
        <div className="space-y-4 border-t p-4">
          {!canWrite && (
            <>
              <p className="text-sm text-muted-foreground">{t("Só quem administra a organização altera esta lista.")}</p>
              <ListaSomenteLeitura guardado={guardado} />
            </>
          )}

          {canWrite && salvas.isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleNotch size={16} className="animate-spin" aria-hidden /> {t("Lendo a lista…")}
            </div>
          )}

          {canWrite && atual && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("Marque as tabelas que o assistente pode consultar neste banco. O que não estiver marcado, ele não enxerga.")}
              </p>

              <fieldset className="space-y-2">
                <legend className="sr-only">{t("Modo")}</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name={`modo-${connectionId}`}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    checked={atual.modo === "list"}
                    onChange={() => editar({ modo: "list" })}
                  />
                  <span>{t("Só o que eu marcar (recomendado)")}</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name={`modo-${connectionId}`}
                    className="mt-1 h-4 w-4 shrink-0 accent-primary"
                    checked={atual.modo === "all"}
                    onChange={() => editar({ modo: "all" })}
                  />
                  <span>{t("Tudo que o usuário do banco enxerga")}</span>
                </label>
              </fieldset>

              {atual.modo === "all" && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <p className="font-medium">
                    {t("O assistente enxerga todas as tabelas que o usuário do banco enxerga.")}
                  </p>
                  <p className="mt-1 text-xs">
                    {t("Se houver dados sensíveis (senhas, chaves), crie no banco um usuário de leitura só com o que ele precisa, ou volte para \"Só o que eu marcar\".")}
                  </p>
                </div>
              )}

              {atual.modo === "list" && guardado !== null && guardado.modo === "list" && guardado.fontes.length === 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  {t("Falta escolher o que o assistente pode ler. Até lá, ele não enxerga nada deste banco.")}
                </div>
              )}

              {atual.modo === "list" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="h-8 w-64"
                      value={busca}
                      placeholder={t("Buscar tabela ou view")}
                      aria-label={t("Buscar tabela ou view")}
                      onChange={(e) => setBusca(e.target.value)}
                    />
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded-md border-border accent-primary"
                        checked={soViews}
                        onChange={(e) => setSoViews(e.target.checked)}
                      />
                      {t("Só views")}
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={visiveis.length === 0}
                      onClick={() => {
                        const r = marcarVisiveis(atual.fontes, visiveis, colunaDoCliente);
                        editar({ fontes: r.lista });
                        if (r.cortadas > 0) {
                          toast.info(t("Algumas tabelas não foram marcadas (limite de 200 fontes, ou tabela sem colunas)."));
                        }
                      }}
                    >
                      {t("Marcar todas as visíveis")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={visiveis.length === 0}
                      onClick={() => editar({ fontes: desmarcarVisiveis(atual.fontes, visiveis) })}
                    >
                      {t("Desmarcar as visíveis")}
                    </Button>
                    {contagem && (
                      <span className="ml-auto text-sm text-muted-foreground">
                        {contagem.liberadas} / {contagem.total} {t("liberadas")}
                      </span>
                    )}
                  </div>

                  {catalogo.isLoading && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CircleNotch size={16} className="animate-spin" aria-hidden /> {t("Lendo o catálogo…")}
                    </div>
                  )}

                  {catalogo.isError && (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-destructive">
                      <span>{t("Não foi possível ler o catálogo do banco agora. Confira a conexão e tente de novo.")}</span>
                      <Button type="button" variant="outline" size="sm" onClick={() => catalogo.refetch()}>
                        {t("Tentar de novo")}
                      </Button>
                    </div>
                  )}

                  {catalogo.isSuccess && tabelas.length === 0 && (
                    <p className="text-sm text-muted-foreground">{t("Este banco não tem tabelas visíveis.")}</p>
                  )}

                  <div className="max-h-[420px] space-y-3 overflow-y-auto">
                    {porSchema.map(([schema, lista]) => (
                      <div key={schema}>
                        <p className="px-1 py-1 text-xs font-semibold uppercase text-muted-foreground">{schema}</p>
                        <ul className="space-y-1">
                          {lista.map((tabela) => {
                            const nomeCompleto = `${tabela.schema}.${tabela.nome}`;
                            const idx = indiceDaFonte(atual.fontes, tabela.schema, tabela.nome);
                            const fonte = idx >= 0 ? atual.fontes[idx] : undefined;
                            return (
                              <li key={nomeCompleto} className="rounded-md border">
                                <div className="flex items-center gap-2 px-2 py-1.5">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 shrink-0 rounded-md border-border accent-primary"
                                    checked={fonte !== undefined}
                                    onChange={() => aplicar((l) => alternarTabela(l, tabela, colunaDoCliente))}
                                    aria-label={`${t("Liberar")} ${nomeCompleto}`}
                                  />
                                  <span className="min-w-0 flex-1 truncate text-sm">{tabela.nome}</span>
                                  {tabela.tipo === "view" && <Badge variant="neutral">{t("view")}</Badge>}
                                  {fonte !== undefined && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      aria-expanded={expandida === nomeCompleto}
                                      onClick={() => setExpandida(expandida === nomeCompleto ? null : nomeCompleto)}
                                    >
                                      {t("Detalhes")}
                                    </Button>
                                  )}
                                </div>
                                {fonte !== undefined && expandida === nomeCompleto && (
                                  <DetalheDaFonte
                                    fonte={fonte}
                                    tabela={tabela}
                                    colunaDoCliente={colunaDoCliente}
                                    aplicar={aplicar}
                                  />
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>

                  {sumidas.length > 0 && (
                    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                      <p className="text-sm font-medium">{t("Marcadas, mas não encontradas no banco")}</p>
                      <ul className="space-y-1">
                        {sumidas.map((f) => (
                          <li key={`${f.schema}.${f.tabela}`} className="flex items-center justify-between gap-2 text-sm">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">
                                {f.schema}.{f.tabela}
                              </span>
                              <Badge variant="warning">{t("não encontrada no banco")}</Badge>
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                editar({
                                  fontes: atual.fontes.filter((x) => !(x.schema === f.schema && x.tabela === f.tabela)),
                                })
                              }
                            >
                              {t("Remover da lista")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <span className="text-xs text-muted-foreground">{mudou ? t("Alterações não salvas") : ""}</span>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={!mudou || salvando} onClick={() => setAlteracoes(null)}>
                    {t("Descartar alterações")}
                  </Button>
                  <Button type="button" size="sm" disabled={!podeSalvar} onClick={salvar}>
                    {salvando ? t("Salvando…") : t("Salvar")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
