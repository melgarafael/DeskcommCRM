"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  corpoDaEdicao,
  rascunhoDaEdicao,
  sincronizadoDeOrigem,
  type RascunhoDaEdicao,
} from "@/lib/catalogo/edicao-do-produto";
import type { Produto } from "@/lib/schemas/produtos";

/**
 * O FORMULÁRIO DE EDIÇÃO — o que a tela nunca teve.
 *
 * A tela só deixava criar, importar, desativar e mexer nas fotos; para
 * consertar um preço ou uma descrição era preciso reimportar a planilha, e a
 * planilha de propósito não grava nem `descricao` nem `ativo`. O `PATCH`
 * `/api/v1/products/:id` já aceitava mudança parcial desde o começo — faltava
 * quem o chamasse.
 *
 * As duas decisões têm régua própria, em `lib/catalogo/edicao-do-produto.ts`
 * (teste sem DOM): grava só o que mudou, e `origem` externa abre tudo
 * somente leitura com o aviso de que o lugar de editar é a origem — a próxima
 * sincronização sobrescreveria. Fotos seguem livres pelo botão de sempre: a
 * integração não mexe nelas.
 */
export function EdicaoDoProduto({
  produto,
  aoFechar,
  onProdutoAtualizado,
  onSubstituirVideo,
}: {
  produto: Produto;
  aoFechar: () => void;
  onProdutoAtualizado?: (produto: Produto) => void;
  onSubstituirVideo?: (produtoId: string, file: File) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [rascunho, setRascunho] = React.useState<RascunhoDaEdicao>(() => rascunhoDaEdicao(produto));
  const [salvando, setSalvando] = React.useState(false);
  const [videoFilePath, setVideoFilePath] = React.useState<string | null>(produto.video_file_path ?? null);
  const [removendoVideo, setRemovendoVideo] = React.useState(false);

  const somenteLeitura = sincronizadoDeOrigem(produto.origem);
  const desabilitado = somenteLeitura || salvando;

  async function salvar() {
    const { corpo, erro } = corpoDaEdicao(rascunho, produto, t);
    if (erro) {
      toast.error(erro);
      return;
    }
    if (Object.keys(corpo).length === 0) {
      toast.error(t("Nada para alterar."));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/products/${produto.id}`, corpo);
      toast.success(t("Produto atualizado"));
      onProdutoAtualizado?.({ ...produto, ...corpo, video_file_path: videoFilePath });
      aoFechar();
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="border-t bg-muted/30 p-3" data-testid={`edicao-${produto.codigo}`}>
      {somenteLeitura ? (
        <p
          className="mb-3 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg"
          data-testid="aviso-sincronizado"
        >
          {t("Sincronizado de")} {produto.origem}.{" "}
          {t("Edite na origem: o que você mudar aqui é sobrescrito na próxima sincronização.")}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          {t("Código")}
          <input
            value={rascunho.codigo}
            onChange={(e) => setRascunho({ ...rascunho, codigo: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-codigo"
          />
        </label>
        <label className="text-sm">
          {t("Nome")}
          <input
            value={rascunho.nome}
            onChange={(e) => setRascunho({ ...rascunho, nome: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-nome"
          />
        </label>
        <label className="text-sm sm:col-span-2">
          {t("Descrição")}
          <textarea
            value={rascunho.descricao}
            onChange={(e) => setRascunho({ ...rascunho, descricao: e.target.value })}
            rows={3}
            className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
            disabled={desabilitado}
            data-testid="edicao-descricao"
          />
        </label>
        <label className="text-sm">
          {t("Marca")}
          <input
            value={rascunho.marca}
            onChange={(e) => setRascunho({ ...rascunho, marca: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-marca"
          />
        </label>
        <label className="text-sm">
          {t("Categoria")}
          <input
            value={rascunho.categoria}
            onChange={(e) => setRascunho({ ...rascunho, categoria: e.target.value })}
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-categoria"
          />
        </label>
        <label className="text-sm">
          {t("Preço de venda (Por)")}
          <input
            value={rascunho.preco}
            onChange={(e) => setRascunho({ ...rascunho, preco: e.target.value })}
            placeholder="5.499,00"
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-preco"
          />
        </label>
        <label className="text-sm">
          {t("Preço original (De)")} <span className="text-muted-foreground">{t("(opcional)")}</span>
          <input
            value={rascunho.preco_de}
            onChange={(e) => setRascunho({ ...rascunho, preco_de: e.target.value })}
            placeholder="6.999,00"
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-preco-de"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {t("Se preenchido, o preço aparece com desconto riscado ('De R$ X por R$ Y').")}
          </span>
        </label>
        <label className="text-sm">
          {t("Custo")} <span className="text-muted-foreground">{t("(opcional)")}</span>
          <input
            value={rascunho.custo}
            onChange={(e) => setRascunho({ ...rascunho, custo: e.target.value })}
            placeholder="4.100,00"
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-custo"
          />
        </label>
        <label className="text-sm">
          {t("Vídeo demonstrativo")} <span className="text-muted-foreground">{t("(URL externa)")}</span>
          <input
            value={rascunho.video_url}
            onChange={(e) => setRascunho({ ...rascunho, video_url: e.target.value })}
            placeholder="https://..."
            className="mt-1 h-9 w-full rounded-md border px-3"
            disabled={desabilitado}
            data-testid="edicao-video-url"
          />
        </label>
      </div>

      {/* Gestão do Vídeo do WhatsApp */}
      <div className="mt-4 rounded-lg border bg-card/60 p-3.5">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("🎬 Vídeo do Produto para WhatsApp (Upload)")}
        </h4>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("Arquivo enviado como vídeo nativo (inline player) no chat do WhatsApp com compressão automática em HD.")}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          {videoFilePath ? (
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs">
              <span className="font-medium text-emerald-600 dark:text-emerald-400">✓ {t("Vídeo cadastrado")}</span>
              <button
                type="button"
                disabled={removendoVideo}
                onClick={async () => {
                  if (!confirm(t("Deseja remover o vídeo do WhatsApp deste produto?"))) return;
                  setRemovendoVideo(true);
                  try {
                    await apiClient.delete(`/api/v1/products/${produto.id}/video`);
                    setVideoFilePath(null);
                    onProdutoAtualizado?.({ ...produto, video_file_path: null });
                    toast.success(t("Vídeo removido"));
                    router.refresh();
                  } catch (e) {
                    showApiError(e);
                  } finally {
                    setRemovendoVideo(false);
                  }
                }}
                className="text-destructive hover:underline disabled:opacity-50"
              >
                {removendoVideo ? t("Removendo...") : t("Remover vídeo")}
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">{t("Nenhum vídeo carregado ainda.")}</p>
          )}

          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted">
            <span>{videoFilePath ? t("Substituir vídeo") : t("Fazer upload do vídeo")}</span>
            <input
              type="file"
              accept="video/*,.mp4,.mov,.webm"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                e.target.value = "";

                if (onSubstituirVideo) {
                  // 1. Se houver alterações em campos de texto, salva no banco primeiro
                  const { corpo } = corpoDaEdicao(rascunho, produto, t);
                  if (corpo && Object.keys(corpo).length > 0) {
                    try {
                      await apiClient.patch(`/api/v1/products/${produto.id}`, corpo);
                      onProdutoAtualizado?.({ ...produto, ...corpo });
                    } catch {
                      // continua para processamento de vídeo
                    }
                  }
                  // 2. Fecha a edição e aciona a barra de progresso no produto
                  aoFechar();
                  onSubstituirVideo(produto.id, file);
                } else {
                  const toastId = toast.loading(t("Enviando vídeo para o catálogo..."));
                  try {
                    let newPath: string | null = null;
                    const prepRes = await fetch(`/api/v1/products/${produto.id}/video?action=prepare`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                    });

                    if (prepRes.ok) {
                      const prepJson = (await prepRes.json()) as {
                        data?: { uploadUrl?: string; path?: string };
                      };
                      const uploadUrl = prepJson.data?.uploadUrl;
                      const videoPath = prepJson.data?.path;
                      if (uploadUrl && videoPath) {
                        const putRes = await fetch(uploadUrl, {
                          method: "PUT",
                          headers: { "Content-Type": file.type || "video/mp4" },
                          body: file,
                        });
                        if (!putRes.ok) throw new Error(t("Falha ao transmitir vídeo para o storage."));

                        const confirmRes = await fetch(`/api/v1/products/${produto.id}/video?action=confirm`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ video_file_path: videoPath }),
                        });
                        if (!confirmRes.ok) {
                          const errJson = await confirmRes.json().catch(() => null);
                          throw new Error(errJson?.error?.message || t("Erro ao vincular o vídeo."));
                        }
                        const confirmJson = await confirmRes.json();
                        newPath = confirmJson.data?.video_file_path || null;
                      }
                    }

                    if (!newPath) {
                      if (file.size > 25 * 1024 * 1024) {
                        throw new Error(t("Falha ao enviar vídeo diretamente para o storage."));
                      }
                      const form = new FormData();
                      form.append("file", file);
                      const res = await fetch(`/api/v1/products/${produto.id}/video`, { method: "POST", body: form });
                      if (!res.ok) {
                        const json = await res.json().catch(() => null);
                        throw new Error(json?.error?.message || t("Erro no upload do vídeo."));
                      }
                      const json = (await res.json()) as { data?: { video_file_path?: string } };
                      newPath = json?.data?.video_file_path || null;
                    }

                    setVideoFilePath(newPath);
                    onProdutoAtualizado?.({ ...produto, video_file_path: newPath });
                    toast.success(t("Vídeo salvo com sucesso!"), { id: toastId });
                    router.refresh();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : t("Falha ao subir vídeo."), { id: toastId });
                  }
                }
              }}
            />
          </label>
        </div>
      </div>

      {/* Integrações Opcionais (Bling & Meta Catalog) */}
      <details className="mt-4 rounded-lg border bg-card/40 p-3.5 text-sm" data-testid="edicao-integracoes">
        <summary className="cursor-pointer font-medium text-foreground select-none">
          {t("🛒 Integrações & Logística (Opcional - Bling & Meta Catalog)")}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 pt-2 border-t">
          <label className="text-sm">
            {t("Código de Barras (EAN / GTIN)")}
            <input
              value={rascunho.gtin}
              onChange={(e) => setRascunho({ ...rascunho, gtin: e.target.value })}
              placeholder="7891234567890"
              className="mt-1 h-9 w-full rounded-md border px-3"
              disabled={desabilitado}
            />
          </label>
          <label className="text-sm">
            {t("NCM (Fiscal Bling)")}
            <input
              value={rascunho.ncm}
              onChange={(e) => setRascunho({ ...rascunho, ncm: e.target.value })}
              placeholder="8517.13.00"
              className="mt-1 h-9 w-full rounded-md border px-3"
              disabled={desabilitado}
            />
          </label>
          <label className="text-sm">
            {t("Origem Fiscal")}
            <select
              value={rascunho.origem_fiscal}
              onChange={(e) => setRascunho({ ...rascunho, origem_fiscal: e.target.value })}
              className="mt-1 h-9 w-full rounded-md border px-3 bg-background"
              disabled={desabilitado}
            >
              <option value="">{t("Selecione (padrão 0 - Nacional)")}</option>
              <option value="0">0 - Nacional</option>
              <option value="1">1 - Estrangeira (Importação direta)</option>
              <option value="2">2 - Estrangeira (Mercado interno)</option>
            </select>
          </label>
          <label className="text-sm">
            {t("Peso (gramas)")}
            <input
              value={rascunho.peso_gramas}
              onChange={(e) => setRascunho({ ...rascunho, peso_gramas: e.target.value })}
              placeholder="350"
              className="mt-1 h-9 w-full rounded-md border px-3"
              disabled={desabilitado}
            />
          </label>
          <label className="text-sm">
            {t("Dimensões C × L × A (cm)")}
            <div className="mt-1 flex items-center gap-1.5">
              <input
                value={rascunho.comprimento_cm}
                onChange={(e) => setRascunho({ ...rascunho, comprimento_cm: e.target.value })}
                placeholder="Comp."
                className="h-9 w-1/3 rounded-md border px-2 text-center text-xs"
                disabled={desabilitado}
              />
              <span>×</span>
              <input
                value={rascunho.largura_cm}
                onChange={(e) => setRascunho({ ...rascunho, largura_cm: e.target.value })}
                placeholder="Larg."
                className="h-9 w-1/3 rounded-md border px-2 text-center text-xs"
                disabled={desabilitado}
              />
              <span>×</span>
              <input
                value={rascunho.altura_cm}
                onChange={(e) => setRascunho({ ...rascunho, altura_cm: e.target.value })}
                placeholder="Alt."
                className="h-9 w-1/3 rounded-md border px-2 text-center text-xs"
                disabled={desabilitado}
              />
            </div>
          </label>
          <label className="text-sm">
            {t("Condição do Item (Meta)")}
            <select
              value={rascunho.condicao}
              onChange={(e) => setRascunho({ ...rascunho, condicao: e.target.value })}
              className="mt-1 h-9 w-full rounded-md border px-3 bg-background"
              disabled={desabilitado}
            >
              <option value="new">{t("Novo")}</option>
              <option value="refurbished">{t("Recondicionado")}</option>
              <option value="used">{t("Usado")}</option>
            </select>
          </label>
          <label className="text-sm sm:col-span-2 lg:col-span-3">
            {t("Link da Loja Virtual / Checkout (URL)")}
            <input
              value={rascunho.link_loja}
              onChange={(e) => setRascunho({ ...rascunho, link_loja: e.target.value })}
              placeholder="https://minhaloja.com.br/produto/..."
              className="mt-1 h-9 w-full rounded-md border px-3"
              disabled={desabilitado}
            />
          </label>
        </div>
      </details>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={rascunho.controla_estoque}
          onChange={(e) => setRascunho({ ...rascunho, controla_estoque: e.target.checked })}
          disabled={desabilitado}
          data-testid="edicao-controla-estoque"
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
            disabled={desabilitado}
            data-testid="edicao-quantidade"
          />
        </label>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        {somenteLeitura ? null : (
          <Button onClick={() => void salvar()} disabled={salvando} data-testid="salvar-edicao">
            {t(salvando ? "Salvando…" : "Salvar alterações")}
          </Button>
        )}
        <Button variant="ghost" onClick={aoFechar} data-testid="fechar-edicao">
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}
