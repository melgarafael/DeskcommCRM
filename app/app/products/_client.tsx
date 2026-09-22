"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { EmptyFilterResults } from "@/components/empty";
import { FilterBar, FilterPrimary, FilterSearch } from "@/components/filters/FilterBar";
import { PageHeader } from "@/components/layout/PageHeader";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import { precoDeVitrine, precoParaCentavos, type Produto } from "@/lib/schemas/produtos";

import { FotosDoProduto } from "./_fotos";

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface ResumoDaImportacao {
  total_linhas: number;
  criados: number;
  atualizados: number;
  erros: Array<{ linha: number; motivo: string }>;
  colunas_ignoradas: string[];
}

interface Rascunho {
  codigo: string;
  nome: string;
  marca: string;
  categoria: string;
  preco: string;
  custo: string;
  quantidade: string;
  controla_estoque: boolean;
  ncm: string;
  unidade: string;
  destaque: boolean;
  emPromocao: boolean;
  precoPromocional: string;
  promocaoAte: string;
}

const VAZIO: Rascunho = {
  codigo: "",
  nome: "",
  marca: "",
  categoria: "",
  preco: "",
  custo: "",
  quantidade: "0",
  controla_estoque: true,
  ncm: "",
  unidade: "",
  destaque: false,
  emPromocao: false,
  precoPromocional: "",
  promocaoAte: "",
};

function doRascunho(
  r: Rascunho,
  t: (s: string) => string,
): Record<string, unknown> | { erro: string } {
  const preco_cents = precoParaCentavos(r.preco);
  if (preco_cents === null) return { erro: t("Preço inválido. Escreva assim: 5.499,00") };
  const custo_cents = r.custo.trim() === "" ? null : precoParaCentavos(r.custo);
  if (r.custo.trim() !== "" && custo_cents === null) return { erro: t("Custo inválido.") };

  const ncm = r.ncm.replace(/\D/g, "");
  if (ncm !== "" && !/^\d{8}$/.test(ncm)) return { erro: t("NCM tem 8 dígitos (só números).") };

  let promo: Record<string, unknown> = {};
  if (r.emPromocao) {
    const promoCents = precoParaCentavos(r.precoPromocional);
    if (promoCents === null) return { erro: t("Preço promocional inválido.") };
    if (r.promocaoAte.trim() !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(r.promocaoAte.trim())) {
      return { erro: t("Validade da promoção usa AAAA-MM-DD.") };
    }
    promo = {
      preco_promocional_cents: promoCents,
      ...(r.promocaoAte.trim() ? { promocao_ate: r.promocaoAte.trim() } : { promocao_ate: null }),
    };
  } else {
    promo = { preco_promocional_cents: null, promocao_ate: null };
  }

  return {
    codigo: r.codigo.trim(),
    nome: r.nome.trim(),
    ...(r.marca.trim() ? { marca: r.marca.trim() } : {}),
    ...(r.categoria.trim() ? { categoria: r.categoria.trim() } : {}),
    preco_cents,
    custo_cents,
    controla_estoque: r.controla_estoque,
    quantidade: Number(r.quantidade) || 0,
    destaque: r.destaque,
    ...promo,
    ...(ncm !== "" ? { ncm } : {}),
    ...(r.unidade.trim() ? { unidade: r.unidade.trim().toUpperCase().slice(0, 10) } : {}),
  };
}

export function ProdutosClient({
  inicial,
  podeEditar,
  textos,
  /**
   * Embutido nas abas do catálogo: pula o contêiner e o cabeçalho próprios,
   * que a concha das abas já provê. Default mantém o comportamento atual —
   * nenhuma tela existente muda.
   */
  esconderCabecalho,
}: {
  inicial: Produto[];
  podeEditar: boolean;
  textos: Textos;
  esconderCabecalho?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const [busca, setBusca] = React.useState("");
  const [aba, setAba] = React.useState<"todos" | "promocoes" | "destaques">("todos");
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<Rascunho>(VAZIO);
  const [salvando, setSalvando] = React.useState(false);
  const [editando, setEditando] = React.useState<Produto | null>(null);
  const [rascunhoEdicao, setRascunhoEdicao] = React.useState<Rascunho>(VAZIO);
  const [salvandoEdicao, setSalvandoEdicao] = React.useState(false);
  const [importando, setImportando] = React.useState(false);
  const [resumo, setResumo] = React.useState<ResumoDaImportacao | null>(null);
  const arquivoRef = React.useRef<HTMLInputElement>(null);

  const hoje = new Date().toISOString().slice(0, 10);
  const filtrados = React.useMemo(() => {
    const q = busca.trim().toLowerCase();
    let lista = inicial;
    if (aba === "promocoes") lista = lista.filter((p) => precoDeVitrine(p, hoje).emPromocao);
    if (aba === "destaques") lista = lista.filter((p) => p.destaque);
    if (q === "") return lista;
    return lista.filter((p) =>
      [p.nome, p.codigo, p.marca ?? "", p.categoria ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [inicial, busca, aba, hoje]);

  async function salvar() {
    const corpo = doRascunho(rascunho, t);
    if ("erro" in corpo) {
      toast.error(corpo.erro as string);
      return;
    }
    setSalvando(true);
    try {
      await apiClient.post("/api/v1/products", corpo);
      toast.success(t("Produto cadastrado"));
      setRascunho(VAZIO);
      setCriando(false);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  function abrirEdicao(p: Produto) {
    const promoAtiva =
      p.preco_promocional_cents != null &&
      (!p.promocao_ate || new Date().toISOString().slice(0, 10) <= p.promocao_ate);
    setRascunhoEdicao({
      codigo: p.codigo,
      nome: p.nome,
      marca: p.marca ?? "",
      categoria: p.categoria ?? "",
      preco: (p.preco_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
      custo: p.custo_cents == null ? "" : (p.custo_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
      quantidade: String(p.quantidade),
      controla_estoque: p.controla_estoque,
      ncm: p.ncm ?? "",
      unidade: p.unidade ?? "",
      destaque: p.destaque,
      emPromocao: promoAtiva,
      precoPromocional:
        p.preco_promocional_cents == null
          ? ""
          : (p.preco_promocional_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
      promocaoAte: p.promocao_ate ?? "",
    });
    setEditando(p);
  }

  async function salvarEdicao() {
    if (!editando) return;
    const corpo = doRascunho(rascunhoEdicao, t);
    if ("erro" in corpo) {
      toast.error(corpo.erro as string);
      return;
    }
    // Código é identidade do upsert: não muda na edição.
    const { codigo: _codigo, ...patch } = corpo as Record<string, unknown>;
    void _codigo;
    setSalvandoEdicao(true);
    try {
      await apiClient.patch(`/api/v1/products/${editando.id}`, patch);
      toast.success(t("Produto atualizado"));
      setEditando(null);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvandoEdicao(false);
    }
  }

  async function importar(arquivo: File) {
    setImportando(true);
    setResumo(null);
    try {
      const form = new FormData();
      form.append("file", arquivo);
      const res = await fetch("/api/v1/products/import", { method: "POST", body: form });
      const json = (await res.json()) as
        | { data: ResumoDaImportacao }
        | { error?: { message?: string } };
      if (!res.ok || !("data" in json)) {
        const msg = "error" in json ? json.error?.message : undefined;
        toast.error(msg ?? t("Não consegui ler essa planilha."));
        return;
      }
      // O resumo fica NA TELA, não num toast que some em 4 segundos: quem
      // importou 300 produtos precisa ler quais linhas foram recusadas e por quê.
      setResumo(json.data);
      router.refresh();
    } catch {
      toast.error(t("Não consegui enviar o arquivo."));
    } finally {
      setImportando(false);
      if (arquivoRef.current) arquivoRef.current.value = "";
    }
  }

  async function alternarAtivo(p: Produto) {
    try {
      await apiClient.patch(`/api/v1/products/${p.id}`, { ativo: !p.ativo });
      toast.success(t(p.ativo ? "Produto desativado" : "Produto reativado"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  async function alternarDestaque(p: Produto) {
    try {
      await apiClient.patch(`/api/v1/products/${p.id}`, { destaque: !p.destaque });
      toast.success(t(p.destaque ? "Destaque removido" : "Produto em destaque"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  const cabecalho = esconderCabecalho ? null : (
    <PageHeader
      title={textos.titulo}
      subtitle={textos.subtitulo}
      actions={
        podeEditar ? (
          <>
            <Button variant="outline" disabled={importando} onClick={() => arquivoRef.current?.click()} data-testid="importar-planilha">
              {t(importando ? "Importando…" : "Importar planilha")}
            </Button>
            <Button onClick={() => setCriando((v) => !v)} data-testid="novo-produto">
              {t(criando ? "Cancelar" : "Novo produto")}
            </Button>
          </>
        ) : undefined
      }
    />
  );

  const corpo = (
    <div className="space-y-4">
      <input
        ref={arquivoRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        data-testid="arquivo-planilha"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importar(f);
        }}
      />
      <FilterBar>
        <FilterPrimary>
          <FilterSearch
            id="busca-produto"
            label={t("Buscar")}
            value={busca}
            onChange={setBusca}
            placeholder={t("Buscar por nome, código ou marca")}
            dataTestId="busca-produto"
          />
        </FilterPrimary>
      </FilterBar>

      <div className="flex gap-2" role="tablist" aria-label={t("Abas do catálogo")}>
        <Button
          size="sm"
          variant={aba === "todos" ? "default" : "outline"}
          onClick={() => setAba("todos")}
          role="tab"
          aria-selected={aba === "todos"}
        >
          {t("Produtos")}
        </Button>
        <Button
          size="sm"
          variant={aba === "promocoes" ? "default" : "outline"}
          onClick={() => setAba("promocoes")}
          role="tab"
          aria-selected={aba === "promocoes"}
        >
          {t("Promoções")}
        </Button>
        <Button
          size="sm"
          variant={aba === "destaques" ? "default" : "outline"}
          onClick={() => setAba("destaques")}
          role="tab"
          aria-selected={aba === "destaques"}
        >
          {t("Destaques")}
        </Button>
      </div>

      {podeEditar ? (
        // Rota de API que devolve o arquivo com `content-disposition:
        // attachment` — é download, não navegação de página, e `<Link>` do Next
        // faria navegação de cliente para algo que não é tela.
        <a
          href="/api/v1/products/import"
          download="modelo-catalogo.csv"
          className="mb-4 inline-block text-xs text-muted-foreground underline"
          data-testid="modelo-planilha"
        >
          {t("Baixar planilha modelo")}
        </a>
      ) : null}

      {resumo ? (
        <div className="mb-6 rounded-lg border p-4 text-sm" data-testid="resumo-importacao">
          <p className="font-medium">
            {resumo.criados} {t("novos")} · {resumo.atualizados} {t("atualizados")} ·{" "}
            {resumo.total_linhas} {t("linhas na planilha")}
          </p>
          {resumo.colunas_ignoradas.length > 0 ? (
            <p className="mt-2 text-muted-foreground">
              {t("Não usei estas colunas:")} {resumo.colunas_ignoradas.join(", ")}.
            </p>
          ) : null}
          {resumo.erros.length > 0 ? (
            <div className="mt-3">
              <p className="font-medium">{t("Linhas que não entraram:")}</p>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {resumo.erros.slice(0, 20).map((e) => (
                  <li key={`${e.linha}-${e.motivo}`}>
                    {t("Linha")} {e.linha}: {e.motivo}
                  </li>
                ))}
              </ul>
              {resumo.erros.length > 20 ? (
                <p className="mt-1 text-muted-foreground">
                  {t("…e mais")} {resumo.erros.length - 20}.
                </p>
              ) : null}
            </div>
          ) : null}
          <button className="mt-3 text-xs underline" onClick={() => setResumo(null)}>
            {t("Fechar")}
          </button>
        </div>
      ) : null}

      {criando && podeEditar ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-produto">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Código")}
              <input
                value={rascunho.codigo}
                onChange={(e) => setRascunho({ ...rascunho, codigo: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="produto-codigo"
              />
            </label>
            <label className="text-sm">
              {t("Nome")}
              <input
                value={rascunho.nome}
                onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="produto-nome"
              />
            </label>
            <label className="text-sm">
              {t("Marca")}
              <input
                value={rascunho.marca}
                onChange={(e) => setRascunho({ ...rascunho, marca: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Categoria")}
              <input
                value={rascunho.categoria}
                onChange={(e) => setRascunho({ ...rascunho, categoria: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Preço de venda")}
              <input
                value={rascunho.preco}
                onChange={(e) => setRascunho({ ...rascunho, preco: e.target.value })}
                placeholder="5.499,00"
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="produto-preco"
              />
            </label>
            <label className="text-sm">
              NCM <span className="text-muted-foreground">{t("(opcional — exigido na NF-e)")}</span>
              <input
                value={rascunho.ncm}
                onChange={(e) => setRascunho({ ...rascunho, ncm: e.target.value })}
                placeholder="28289011"
                className="mt-1 h-9 w-full rounded-lg border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Unidade")}
              <input
                value={rascunho.unidade}
                onChange={(e) => setRascunho({ ...rascunho, unidade: e.target.value })}
                placeholder="UN"
                className="mt-1 h-9 w-full rounded-lg border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Custo")} <span className="text-muted-foreground">{t("(opcional)")}</span>
              <input
                value={rascunho.custo}
                onChange={(e) => setRascunho({ ...rascunho, custo: e.target.value })}
                placeholder="4.100,00"
                className="mt-1 h-9 w-full rounded-lg border px-3"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("Serve para o atendente saber até onde pode negociar. Não aparece para o cliente.")}
              </span>
            </label>
          </div>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rascunho.controla_estoque}
              onChange={(e) => setRascunho({ ...rascunho, controla_estoque: e.target.checked })}
              data-testid="produto-controla-estoque"
            />
            {t("Controlar estoque deste produto")}
          </label>
          {rascunho.controla_estoque ? (
            <label className="mt-2 block text-sm">
              {t("Quantidade")}
              <input
                value={rascunho.quantidade}
                onChange={(e) => setRascunho({ ...rascunho, quantidade: e.target.value })}
                className="mt-1 h-9 w-32 rounded-lg border px-3"
              />
            </label>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                "Sem controle de estoque, este produto sempre aparece como disponível para o atendente — é o certo para item sob encomenda ou fracionado.",
              )}
            </p>
          )}

          <div className="mt-4">
            <Button onClick={salvar} disabled={salvando} data-testid="salvar-produto">
              {t(salvando ? "Salvando…" : "Salvar produto")}
            </Button>
          </div>
        </div>
      ) : null}

      {filtrados.length === 0 ? (
        busca.trim() ? (
          <EmptyFilterResults primary={{ label: t("Limpar filtros"), onClick: () => setBusca("") }} />
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center" data-testid="produtos-vazio">
            <p className="font-medium">{textos.vazio}</p>
            <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
          </div>
        )
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-produtos">
          {filtrados.map((p) => {
            const vitrine = precoDeVitrine(p, hoje);
            return (
            <li key={p.id} className="flex items-center gap-4 p-3" data-testid={`produto-${p.codigo}`}>
              <FotosDoProduto productId={p.id} podeEditar={podeEditar} />
              <div className="min-w-0 flex-1">
                <p className={`truncate font-medium ${p.ativo ? "" : "text-muted-foreground line-through"}`}>
                  {p.destaque && <span aria-label={t("Destaque")}>★ </span>}
                  {p.nome}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.codigo}
                  {p.marca ? ` · ${p.marca}` : ""}
                  {p.controla_estoque
                    ? ` · ${p.quantidade} ${t("em estoque")}`
                    : ` · ${t("sem controle de estoque")}`}
                  {vitrine.emPromocao && (
                    <span className="ml-1 inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-800">
                      {t("Promoção")}
                      {p.promocao_ate ? ` até ${p.promocao_ate.split("-").reverse().join("/")}` : ""}
                    </span>
                  )}
                </p>
              </div>
              <span className="shrink-0 tabular-nums font-medium">
                {vitrine.emPromocao && (
                  <span className="mr-2 text-sm font-normal text-muted-foreground line-through">
                    {comoMoeda(p.preco_cents, p.moeda)}
                  </span>
                )}
                {comoMoeda(vitrine.cents, p.moeda)}
              </span>
              {podeEditar ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => abrirEdicao(p)} data-testid={`editar-${p.codigo}`}>
                    {t("Editar")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void alternarDestaque(p)}
                    data-testid={`destaque-${p.codigo}`}
                  >
                    {t(p.destaque ? "Tirar destaque" : "Destacar")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void alternarAtivo(p)}
                    data-testid={`alternar-${p.codigo}`}
                  >
                    {t(p.ativo ? "Desativar" : "Reativar")}
                  </Button>
                </>
              ) : null}
            </li>
            );
          })}
        </ul>
      )}

      {editando && podeEditar ? (
        <div className="rounded-lg border p-4" data-testid="form-editar-produto">
          <p className="mb-3 font-medium">
            {t("Editar")} · {editando.codigo} — {editando.nome}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Nome")}
              <input
                value={rascunhoEdicao.nome}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, nome: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="editar-nome"
              />
            </label>
            <label className="text-sm">
              {t("Preço de venda (R$)")}
              <input
                value={rascunhoEdicao.preco}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, preco: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="editar-preco"
              />
            </label>
            <label className="text-sm">
              {t("Marca")}
              <input
                value={rascunhoEdicao.marca}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, marca: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="editar-marca"
              />
            </label>
            <label className="text-sm">
              {t("Categoria")}
              <input
                value={rascunhoEdicao.categoria}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, categoria: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="editar-categoria"
              />
            </label>
            <label className="text-sm">
              {t("Custo (R$)")}
              <input
                value={rascunhoEdicao.custo}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, custo: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                placeholder="4.100,00"
                data-testid="editar-custo"
              />
            </label>
            <label className="text-sm">
              {t("Unidade")}
              <input
                value={rascunhoEdicao.unidade}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, unidade: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="editar-unidade"
              />
            </label>
            <label className="text-sm">
              {t("NCM (8 dígitos)")}
              <input
                value={rascunhoEdicao.ncm}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, ncm: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border px-3"
                data-testid="editar-ncm"
              />
            </label>
            <label className="text-sm">
              {t("Quantidade em estoque")}
              <input
                value={rascunhoEdicao.quantidade}
                onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, quantidade: e.target.value })}
                className="mt-1 h-9 w-32 rounded-lg border px-3"
                data-testid="editar-quantidade"
              />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rascunhoEdicao.destaque}
              onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, destaque: e.target.checked })}
            />
            {t("Destaque (aparece na aba Destaques)")}
          </label>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rascunhoEdicao.emPromocao}
              onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, emPromocao: e.target.checked })}
            />
            {t("Em promoção")}
          </label>
          {rascunhoEdicao.emPromocao && (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                {t("Preço promocional (R$)")}
                <input
                  value={rascunhoEdicao.precoPromocional}
                  onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, precoPromocional: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border px-3"
                  data-testid="editar-preco-promocional"
                />
              </label>
              <label className="text-sm">
                {t("Válida até (vazio = sem fim)")}
                <input
                  type="date"
                  value={rascunhoEdicao.promocaoAte}
                  onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, promocaoAte: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border bg-background px-3"
                  data-testid="editar-promocao-ate"
                />
              </label>
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rascunhoEdicao.controla_estoque}
              onChange={(e) => setRascunhoEdicao({ ...rascunhoEdicao, controla_estoque: e.target.checked })}
            />
            {t("Controlar estoque deste produto")}
          </label>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => void salvarEdicao()} disabled={salvandoEdicao} data-testid="salvar-edicao">
              {t(salvandoEdicao ? "Salvando…" : "Salvar alterações")}
            </Button>
            <Button variant="outline" onClick={() => setEditando(null)}>
              {t("Cancelar")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (esconderCabecalho) {
    return <div data-testid="tela-produtos">{corpo}</div>;
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6" data-testid="tela-produtos">
      {cabecalho}
      {corpo}
    </div>
  );
}
