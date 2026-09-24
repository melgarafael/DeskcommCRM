"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { MAXIMO_DE_FOTOS } from "@/lib/catalogo/fotos";
import { formatCents } from "@/lib/money";
import { precoParaCentavos, type Produto } from "@/lib/schemas/produtos";

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
};

function doRascunho(
  r: Rascunho,
  t: (s: string) => string,
): Record<string, unknown> | { erro: string } {
  const preco_cents = precoParaCentavos(r.preco);
  if (preco_cents === null) return { erro: t("Preço inválido. Escreva assim: 5.499,00") };
  const custo_cents = r.custo.trim() === "" ? null : precoParaCentavos(r.custo);
  if (r.custo.trim() !== "" && custo_cents === null) return { erro: t("Custo inválido.") };

  return {
    codigo: r.codigo.trim(),
    nome: r.nome.trim(),
    ...(r.marca.trim() ? { marca: r.marca.trim() } : {}),
    ...(r.categoria.trim() ? { categoria: r.categoria.trim() } : {}),
    preco_cents,
    custo_cents,
    controla_estoque: r.controla_estoque,
    quantidade: Number(r.quantidade) || 0,
  };
}

/**
 * As fotos de UM produto: pôr, tirar e trocar a ordem. A primeira é a capa, e é
 * na ordem daqui que o atendente de IA as manda ao cliente.
 *
 * Toda mudança vai ao servidor e volta pelo `router.refresh()`: as URLs são
 * assinadas pela página, e a lista que vale é a do banco.
 */
function FotosDoProduto({ produto, urls }: { produto: Produto; urls: Record<string, string> }) {
  const t = useT();
  const router = useRouter();
  const [ocupado, setOcupado] = React.useState(false);
  const entradaRef = React.useRef<HTMLInputElement>(null);
  const fotos = produto.fotos ?? [];

  async function subir(arquivo: File) {
    setOcupado(true);
    try {
      const form = new FormData();
      form.append("file", arquivo);
      const res = await fetch(`/api/v1/products/${produto.id}/fotos`, { method: "POST", body: form });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(json?.error?.message ?? t("Não consegui enviar a foto."));
        return;
      }
      toast.success(t("Foto adicionada"));
      router.refresh();
    } catch {
      toast.error(t("Não consegui enviar a foto."));
    } finally {
      setOcupado(false);
      if (entradaRef.current) entradaRef.current.value = "";
    }
  }

  async function gravarOrdem(nova: string[], aviso: string) {
    setOcupado(true);
    try {
      await apiClient.put(`/api/v1/products/${produto.id}/fotos`, { fotos: nova });
      toast.success(aviso);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  function mover(i: number, delta: -1 | 1) {
    const nova = [...fotos];
    [nova[i], nova[i + delta]] = [nova[i + delta]!, nova[i]!];
    void gravarOrdem(nova, t("Ordem das fotos salva"));
  }

  return (
    <div className="border-t bg-muted/30 p-3" data-testid={`fotos-${produto.codigo}`}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("A primeira foto é a capa. O atendente de IA manda as fotos nesta ordem quando apresenta o produto.")}
      </p>
      <ul className="flex flex-wrap gap-3">
        {fotos.map((caminho, i) => (
          <li key={caminho} className="w-28" data-testid="foto-do-produto">
            {urls[caminho] ? (
              // URL assinada e curta, de outro host: `next/image` exigiria allowlist no build.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={urls[caminho]}
                alt={`${produto.nome} — ${t("foto")} ${i + 1}`}
                className="h-28 w-28 rounded-md border object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-md border text-xs text-muted-foreground">
                {t("Sem prévia")}
              </div>
            )}
            <div className="mt-1 flex justify-between">
              <Button
                variant="ghost"
                size="sm"
                disabled={ocupado || i === 0}
                onClick={() => mover(i, -1)}
                aria-label={t("Mover a foto para a esquerda")}
              >
                ←
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={ocupado}
                onClick={() => void gravarOrdem(fotos.filter((c) => c !== caminho), t("Foto removida"))}
                aria-label={t("Remover a foto")}
                data-testid="remover-foto"
              >
                ✕
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={ocupado || i === fotos.length - 1}
                onClick={() => mover(i, 1)}
                aria-label={t("Mover a foto para a direita")}
              >
                →
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <input
        ref={entradaRef}
        type="file"
        accept="image/jpeg,image/png"
        className="hidden"
        data-testid="arquivo-foto"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subir(f);
        }}
      />
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={ocupado || fotos.length >= MAXIMO_DE_FOTOS}
          onClick={() => entradaRef.current?.click()}
          data-testid="adicionar-foto"
        >
          {t(ocupado ? "Salvando…" : "Adicionar foto")}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("JPG ou PNG, até 5 MB. No máximo 5 fotos.")}
        </span>
      </div>
    </div>
  );
}

export function ProdutosClient({
  inicial,
  urlsDasFotos,
  podeEditar,
  textos,
}: {
  inicial: Produto[];
  urlsDasFotos: Record<string, string>;
  podeEditar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [busca, setBusca] = React.useState("");
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<Rascunho>(VAZIO);
  const [salvando, setSalvando] = React.useState(false);
  const [importando, setImportando] = React.useState(false);
  const [resumo, setResumo] = React.useState<ResumoDaImportacao | null>(null);
  const arquivoRef = React.useRef<HTMLInputElement>(null);
  const [fotosAbertas, setFotosAbertas] = React.useState<string | null>(null);

  const filtrados = React.useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (q === "") return inicial;
    return inicial.filter((p) =>
      [p.nome, p.codigo, p.marca ?? "", p.categoria ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [inicial, busca]);

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

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-produtos">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      <div className="mb-4 flex items-center gap-3">
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar por nome, código ou marca")}
          className="h-9 w-full max-w-sm rounded-md border px-3 text-sm"
          data-testid="busca-produto"
        />
        {podeEditar ? (
          <>
            <Button onClick={() => setCriando((v) => !v)} data-testid="novo-produto">
              {t(criando ? "Cancelar" : "Novo produto")}
            </Button>
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
            <Button
              variant="outline"
              disabled={importando}
              onClick={() => arquivoRef.current?.click()}
              data-testid="importar-planilha"
            >
              {t(importando ? "Importando…" : "Importar planilha")}
            </Button>
          </>
        ) : null}
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
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-codigo"
              />
            </label>
            <label className="text-sm">
              {t("Nome")}
              <input
                value={rascunho.nome}
                onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-nome"
              />
            </label>
            <label className="text-sm">
              {t("Marca")}
              <input
                value={rascunho.marca}
                onChange={(e) => setRascunho({ ...rascunho, marca: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Categoria")}
              <input
                value={rascunho.categoria}
                onChange={(e) => setRascunho({ ...rascunho, categoria: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
              />
            </label>
            <label className="text-sm">
              {t("Preço de venda")}
              <input
                value={rascunho.preco}
                onChange={(e) => setRascunho({ ...rascunho, preco: e.target.value })}
                placeholder="5.499,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-preco"
              />
            </label>
            <label className="text-sm">
              {t("Custo")} <span className="text-muted-foreground">{t("(opcional)")}</span>
              <input
                value={rascunho.custo}
                onChange={(e) => setRascunho({ ...rascunho, custo: e.target.value })}
                placeholder="4.100,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
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
                className="mt-1 h-9 w-32 rounded-md border px-3"
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
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="produtos-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-produtos">
          {filtrados.map((p) => {
            const capa = p.fotos?.[0] ? urlsDasFotos[p.fotos[0]] : undefined;
            return (
            <li key={p.id} data-testid={`produto-${p.codigo}`}>
            <div className="flex items-center gap-4 p-3">
              {capa ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={capa} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className={`truncate font-medium ${p.ativo ? "" : "text-muted-foreground line-through"}`}>
                  {p.nome}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.codigo}
                  {p.marca ? ` · ${p.marca}` : ""}
                  {p.controla_estoque
                    ? ` · ${p.quantidade} ${t("em estoque")}`
                    : ` · ${t("sem controle de estoque")}`}
                </p>
              </div>
              <span className="shrink-0 tabular-nums font-medium">
                {formatCents(p.preco_cents, p.moeda)}
              </span>
              {podeEditar ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFotosAbertas((v) => (v === p.id ? null : p.id))}
                    aria-expanded={fotosAbertas === p.id}
                    data-testid={`abrir-fotos-${p.codigo}`}
                  >
                    {t("Fotos")} ({p.fotos?.length ?? 0})
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
            </div>
            {podeEditar && fotosAbertas === p.id ? (
              <FotosDoProduto produto={p} urls={urlsDasFotos} />
            ) : null}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
