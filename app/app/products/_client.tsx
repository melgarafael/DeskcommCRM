"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api/client";
import { queryDaTela } from "@/lib/catalogo/busca-da-tela";
import { MAXIMO_DE_FOTOS } from "@/lib/catalogo/fotos";
import { converterImagemParaJpeg } from "@/lib/catalogo/conversor-imagem";
import { formatCents } from "@/lib/money";
import { precoParaCentavos, type Produto } from "@/lib/schemas/produtos";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  FileText,
  Package,
  Storefront,
  Trash,
  VideoCamera,
} from "@/lib/ui/icons";
import { EdicaoDoProduto } from "./_edicao";

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
  descricao: string;
  marca: string;
  categoria: string;
  preco: string;
  preco_de: string;
  custo: string;
  quantidade: string;
  controla_estoque: boolean;
  video_url: string;
  gtin: string;
  ncm: string;
  origem_fiscal: string;
  peso_gramas: string;
  altura_cm: string;
  largura_cm: string;
  comprimento_cm: string;
  condicao: string;
  link_loja: string;
}

const VAZIO: Rascunho = {
  codigo: "",
  nome: "",
  descricao: "",
  marca: "",
  categoria: "",
  preco: "",
  preco_de: "",
  custo: "",
  quantidade: "0",
  controla_estoque: true,
  video_url: "",
  gtin: "",
  ncm: "",
  origem_fiscal: "",
  peso_gramas: "",
  altura_cm: "",
  largura_cm: "",
  comprimento_cm: "",
  condicao: "new",
  link_loja: "",
};

function doRascunho(
  r: Rascunho,
  t: (s: string) => string,
): Record<string, unknown> | { erro: string } {
  const preco_cents = precoParaCentavos(r.preco);
  if (preco_cents === null) return { erro: t("Preço inválido. Escreva assim: 5.499,00") };
  
  const preco_de_cents = r.preco_de.trim() === "" ? null : precoParaCentavos(r.preco_de);
  if (r.preco_de.trim() !== "" && preco_de_cents === null) {
    return { erro: t("Preço original (De) inválido.") };
  }

  const custo_cents = r.custo.trim() === "" ? null : precoParaCentavos(r.custo);
  if (r.custo.trim() !== "" && custo_cents === null) return { erro: t("Custo inválido.") };

  const peso = r.peso_gramas.trim() ? Number(r.peso_gramas) : null;
  const alt = r.altura_cm.trim() ? Number(r.altura_cm) : null;
  const larg = r.largura_cm.trim() ? Number(r.largura_cm) : null;
  const comp = r.comprimento_cm.trim() ? Number(r.comprimento_cm) : null;

  return {
    codigo: r.codigo.trim(),
    nome: r.nome.trim(),
    ...(r.descricao.trim() ? { descricao: r.descricao.trim() } : {}),
    ...(r.marca.trim() ? { marca: r.marca.trim() } : {}),
    ...(r.categoria.trim() ? { categoria: r.categoria.trim() } : {}),
    preco_cents,
    ...(preco_de_cents !== null ? { preco_de_cents } : {}),
    custo_cents,
    controla_estoque: r.controla_estoque,
    quantidade: Number(r.quantidade) || 0,
    ...(r.video_url.trim() ? { video_url: r.video_url.trim() } : {}),
    ...(r.gtin.trim() ? { gtin: r.gtin.trim() } : {}),
    ...(r.ncm.trim() ? { ncm: r.ncm.trim() } : {}),
    ...(r.origem_fiscal.trim() ? { origem_fiscal: r.origem_fiscal.trim() } : {}),
    ...(peso !== null ? { peso_gramas: peso } : {}),
    ...(alt !== null ? { altura_cm: alt } : {}),
    ...(larg !== null ? { largura_cm: larg } : {}),
    ...(comp !== null ? { comprimento_cm: comp } : {}),
    ...(r.condicao.trim() ? { condicao: r.condicao.trim() } : {}),
    ...(r.link_loja.trim() ? { link_loja: r.link_loja.trim() } : {}),
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
    const toastId = toast.loading(t("Convertendo imagem para JPEG e enviando..."));
    try {
      const jpeg = await converterImagemParaJpeg(arquivo);
      const form = new FormData();
      form.append("file", jpeg);
      const res = await fetch(`/api/v1/products/${produto.id}/fotos`, { method: "POST", body: form });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(json?.error?.message ?? t("Não consegui enviar a foto."), { id: toastId });
        return;
      }
      toast.success(t("Foto convertida para JPEG e adicionada!"), { id: toastId });
      router.refresh();
    } catch {
      toast.error(t("Não consegui enviar a foto."), { id: toastId });
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

function VideoDoProduto({
  produto,
  urlDoVideo,
  onRemoverVideo,
  onSubstituirVideo,
}: {
  produto: Produto;
  urlDoVideo?: string;
  onRemoverVideo?: () => Promise<void>;
  onSubstituirVideo?: (arquivo: File) => void;
}) {
  const t = useT();
  const router = useRouter();
  const [ocupado, setOcupado] = React.useState(false);
  const entradaRef = React.useRef<HTMLInputElement>(null);

  function subir(arquivo: File) {
    if (onSubstituirVideo) {
      onSubstituirVideo(arquivo);
    }
    if (entradaRef.current) entradaRef.current.value = "";
  }

  async function remover() {
    if (!confirm(t("Deseja realmente remover o vídeo deste produto?"))) return;
    setOcupado(true);
    try {
      if (onRemoverVideo) {
        await onRemoverVideo();
      } else {
        await apiClient.delete(`/api/v1/products/${produto.id}/video`);
        toast.success(t("Vídeo removido"));
        router.refresh();
      }
    } catch (e) {
      showApiError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="border-t bg-muted/30 p-3" data-testid={`video-${produto.codigo}`}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("Arquivo enviado como vídeo nativo (inline player) no chat do WhatsApp com compressão automática em HD.")}
      </p>

      {urlDoVideo ? (
        <div className="mb-3 max-w-sm">
          <video src={urlDoVideo} controls className="max-h-48 w-full rounded-md border bg-black" />
        </div>
      ) : (
        <div className="mb-3 flex h-20 max-w-sm items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
          {t("Nenhum vídeo carregado para WhatsApp.")}
        </div>
      )}

      <input
        ref={entradaRef}
        type="file"
        accept="video/*,.mp4,.mov,.webm"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void subir(f);
        }}
      />

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={ocupado}
          onClick={() => entradaRef.current?.click()}
        >
          {t(ocupado ? "Processando…" : urlDoVideo ? "Substituir vídeo" : "Enviar vídeo (Upload)")}
        </Button>
        {urlDoVideo ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10"
            disabled={ocupado}
            onClick={() => void remover()}
          >
            {t("Remover vídeo")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Padrão de `urlsDosVideos` com identidade ESTÁVEL. Um `= {}` no parâmetro cria
 * um objeto novo a cada render, e o efeito que copia a prop para o estado
 * renderiza de novo para sempre — a tela travava quem não passava a prop.
 */
const SEM_VIDEOS: Record<string, string> = {};

export function ProdutosClient({
  inicial,
  total,
  pagina,
  porPagina,
  buscaInicial,
  urlsDasFotos,
  urlsDosVideos = SEM_VIDEOS,
  podeEditar,
  textos,
}: {
  /** A página atual, já filtrada no servidor (ver `lib/catalogo/busca-da-tela.ts`). */
  inicial: Produto[];
  /** Quantos produtos casam com a busca no catálogo INTEIRO, não só nesta página. */
  total: number;
  pagina: number;
  porPagina: number;
  buscaInicial: string;
  urlsDasFotos: Record<string, string>;
  urlsDosVideos?: Record<string, string>;
  podeEditar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [busca, setBusca] = React.useState(buscaInicial);
  const [carregando, iniciarNavegacao] = React.useTransition();

  const [buscaDaUrl, setBuscaDaUrl] = React.useState(buscaInicial);
  if (buscaInicial !== buscaDaUrl) {
    setBuscaDaUrl(buscaInicial);
    if (busca.trim() !== buscaInicial) setBusca(buscaInicial);
  }
  const [criando, setCriando] = React.useState(false);
  const [rascunho, setRascunho] = React.useState<Rascunho>(VAZIO);
  const [fotosNovas, setFotosNovas] = React.useState<{ file: File; url: string }[]>([]);
  const [videoNovo, setVideoNovo] = React.useState<{ file: File; url: string } | null>(null);
  const [salvando, setSalvando] = React.useState(false);
  const [produtosLocais, setProdutosLocais] = React.useState<Produto[]>(inicial);
  const [urlsVideosLocais, setUrlsVideosLocais] = React.useState<Record<string, string>>(urlsDosVideos);
  const [processamentos, setProcessamentos] = React.useState<
    Record<string, { percentual: number; etapa: string; finalizado: boolean; erro?: string }>
  >({});
  const [modalImportarAberto, setModalImportarAberto] = React.useState(false);
  const [abaImportar, setAbaImportar] = React.useState<"planilha" | "meta" | "bling">("planilha");
  const [sincronizandoBling, setSincronizandoBling] = React.useState(false);
  const [metaConfig, setMetaConfig] = React.useState<{
    catalog_id: string | null;
    has_token: boolean;
    has_custom_token: boolean;
    feed_url: string | null;
    last_sync_at: string | null;
    products_count: number;
  } | null>(null);
  const [carregandoMetaConfig, setCarregandoMetaConfig] = React.useState(false);
  const [salvandoMetaConfig, setSalvandoMetaConfig] = React.useState(false);
  const [sincronizandoMeta, setSincronizandoMeta] = React.useState(false);
  const [metaCatalogId, setMetaCatalogId] = React.useState("");
  const [metaAccessToken, setMetaAccessToken] = React.useState("");
  const [metaFeedUrl, setMetaFeedUrl] = React.useState("");
  const [importando, setImportando] = React.useState(false);
  const [resumo, setResumo] = React.useState<ResumoDaImportacao | null>(null);
  const arquivoRef = React.useRef<HTMLInputElement>(null);
  const fotosRef = React.useRef<HTMLInputElement>(null);
  const videoRef = React.useRef<HTMLInputElement>(null);
  const [fotosAbertas, setFotosAbertas] = React.useState<string | null>(null);
  const [videoAberto, setVideoAberto] = React.useState<string | null>(null);
  const [videoModal, setVideoModal] = React.useState<{ nome: string; url: string } | null>(null);
  const [editando, setEditando] = React.useState<string | null>(null);
  const [produtoParaExcluir, setProdutoParaExcluir] = React.useState<Produto | null>(null);
  const [excluindo, setExcluindo] = React.useState(false);

  React.useEffect(() => {
    setProdutosLocais(inicial);
  }, [inicial]);

  React.useEffect(() => {
    setUrlsVideosLocais(urlsDosVideos);
  }, [urlsDosVideos]);

  const irPara = React.useCallback(
    (termo: string, novaPagina: number) => {
      const destino = queryDaTela(termo, novaPagina) || "?";
      iniciarNavegacao(() => router.replace(destino, { scroll: false }));
    },
    [router],
  );

  React.useEffect(() => {
    if (busca.trim() === buscaInicial) return;
    const timer = window.setTimeout(() => irPara(busca, 1), 350);
    return () => window.clearTimeout(timer);
  }, [busca, buscaInicial, irPara]);

  const primeiro = total === 0 ? 0 : (pagina - 1) * porPagina + 1;
  const ultimo = Math.min(pagina * porPagina, total);

  async function onFotosSelecionadas(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivos = Array.from(e.target.files ?? []);
    if (arquivos.length === 0) return;
    const toastId = toast.loading(t("Convertendo imagens para JPEG..."));
    try {
      const convertidas: { file: File; url: string }[] = [];
      for (const arq of arquivos) {
        if (fotosNovas.length + convertidas.length >= 5) {
          toast.warning(t("Máximo de 5 fotos por produto."));
          break;
        }
        const jpeg = await converterImagemParaJpeg(arq);
        convertidas.push({ file: jpeg, url: URL.createObjectURL(jpeg) });
      }
      setFotosNovas((atuais) => [...atuais, ...convertidas]);
      toast.success(t("Fotos convertidas para JPEG prontas!"), { id: toastId });
    } catch {
      toast.error(t("Erro ao converter imagens."), { id: toastId });
    } finally {
      if (e.target) e.target.value = "";
    }
  }

  function onVideoSelecionado(e: React.ChangeEvent<HTMLInputElement>) {
    const arq = e.target.files?.[0];
    if (!arq) return;
    if (arq.size > 300 * 1024 * 1024) {
      toast.error(t("O vídeo precisa ter até 300 MB."));
      return;
    }
    setVideoNovo({ file: arq, url: URL.createObjectURL(arq) });
  }

  async function processarMidiasEmSegundoPlano(
    produtoId: string,
    fotos: { file: File; url: string }[],
    video: { file: File; url: string } | null,
  ) {
    try {
      if (fotos.length > 0) {
        setProcessamentos((prev) => ({
          ...prev,
          [produtoId]: { percentual: 20, etapa: t("Enviando fotos otimizadas..."), finalizado: false },
        }));
        for (const f of fotos) {
          const form = new FormData();
          form.append("file", f.file);
          await fetch(`/api/v1/products/${produtoId}/fotos`, { method: "POST", body: form });
        }
      }

      if (video) {
        setProcessamentos((prev) => ({
          ...prev,
          [produtoId]: {
            percentual: fotos.length > 0 ? 35 : 10,
            etapa: t("Preparando envio do vídeo..."),
            finalizado: false,
          },
        }));

        let videoEnviado = false;

        // Tentativa 1: Upload direto assinado no Storage (sem limite de RAM, até 300MB)
        try {
          const prepRes = await fetch(`/api/v1/products/${produtoId}/video?action=prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });

          if (!prepRes.ok) {
            const errJson = (await prepRes.json().catch(() => null)) as { error?: { message?: string } } | null;
            throw new Error(errJson?.error?.message || t("Falha ao preparar envio do vídeo no servidor."));
          }

          const prepJson = (await prepRes.json()) as {
            data?: { uploadUrl?: string; path?: string; token?: string };
          };
          const uploadUrl = prepJson.data?.uploadUrl;
          const videoPath = prepJson.data?.path;

          if (!uploadUrl || !videoPath) {
            throw new Error(t("Servidor não gerou link para upload do vídeo."));
          }

          const mimeValido =
            video.file.type &&
            ["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo"].includes(video.file.type)
              ? video.file.type
              : "video/mp4";

          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("PUT", uploadUrl);
            xhr.setRequestHeader("Content-Type", mimeValido);

            xhr.upload.onprogress = (ev) => {
              if (ev.lengthComputable) {
                const basePct = fotos.length > 0 ? 35 : 10;
                const range = 80;
                const uploadPct = Math.round(basePct + (ev.loaded / ev.total) * range);
                const pctReal = Math.round((ev.loaded / ev.total) * 100);
                setProcessamentos((prev) => ({
                  ...prev,
                  [produtoId]: {
                    percentual: Math.min(92, uploadPct),
                    etapa: `${t("Transmitindo vídeo...")} ${pctReal}%`,
                    finalizado: false,
                  },
                }));
              }
            };

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
              } else {
                let detalhe = "";
                try {
                  const resErr = JSON.parse(xhr.responseText);
                  detalhe = resErr?.message || resErr?.error || "";
                } catch {}
                reject(
                  new Error(
                    detalhe ? `${t("Falha no storage:")} ${detalhe}` : `${t("Falha no storage (HTTP ")}${xhr.status})`,
                  ),
                );
              }
            };

            xhr.onerror = () => reject(new Error(t("Erro de conexão ao enviar o vídeo diretamente para o storage.")));
            xhr.send(video.file);
          });

          setProcessamentos((prev) => ({
            ...prev,
            [produtoId]: {
              percentual: 95,
              etapa: t("Concluindo vídeo para WhatsApp..."),
              finalizado: false,
            },
          }));

          const confirmRes = await fetch(`/api/v1/products/${produtoId}/video?action=confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ video_file_path: videoPath }),
          });

          if (!confirmRes.ok) {
            const errJson = await confirmRes.json().catch(() => null);
            throw new Error(errJson?.error?.message || t("Erro ao vincular o vídeo ao produto."));
          }

          const confirmJson = (await confirmRes.json()) as {
            data?: { video_file_path?: string; signedUrl?: string };
          };
          if (confirmJson.data?.video_file_path) {
            const caminho = confirmJson.data.video_file_path;
            setProdutosLocais((atuais) =>
              atuais.map((p) => (p.id === produtoId ? { ...p, video_file_path: caminho } : p)),
            );
            if (confirmJson.data.signedUrl) {
              setUrlsVideosLocais((prev) => ({ ...prev, [caminho]: confirmJson.data!.signedUrl! }));
            }
          }

          videoEnviado = true;
        } catch (diretoErr) {
          console.warn("[produtos] Falha no upload direto:", diretoErr);
          if (video.file.size > 25 * 1024 * 1024) {
            throw diretoErr;
          }
        }

        // Fallback: se o upload direto não foi concluído, tenta multipart clássico
        if (!videoEnviado) {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `/api/v1/products/${produtoId}/video`);

            xhr.upload.onprogress = (ev) => {
              if (ev.lengthComputable) {
                const basePct = fotos.length > 0 ? 35 : 15;
                const range = 50;
                const uploadPct = Math.round(basePct + (ev.loaded / ev.total) * range);
                setProcessamentos((prev) => ({
                  ...prev,
                  [produtoId]: {
                    percentual: Math.min(85, uploadPct),
                    etapa: uploadPct > 80 ? t("Otimizando e comprimindo vídeo para WhatsApp...") : t("Transmitindo vídeo..."),
                    finalizado: false,
                  },
                }));
              }
            };

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const resJson = JSON.parse(xhr.responseText) as { data?: { video_file_path?: string; signedUrl?: string } };
                  if (resJson.data?.video_file_path) {
                    const caminho = resJson.data.video_file_path;
                    setProdutosLocais((atuais) =>
                      atuais.map((p) => (p.id === produtoId ? { ...p, video_file_path: caminho } : p)),
                    );
                    if (resJson.data.signedUrl) {
                      setUrlsVideosLocais((prev) => ({ ...prev, [caminho]: resJson.data!.signedUrl! }));
                    }
                  }
                  resolve();
                } catch {
                  resolve();
                }
              } else {
                let msg = t("Falha no upload do vídeo.");
                try {
                  const errJson = JSON.parse(xhr.responseText);
                  if (errJson?.error?.message) msg = errJson.error.message;
                } catch {}
                reject(new Error(msg));
              }
            };

            xhr.onerror = () => reject(new Error(t("Erro de conexão no upload do vídeo.")));

            const formVideo = new FormData();
            formVideo.append("file", video.file);
            xhr.send(formVideo);
          });
        }
      }

      setProcessamentos((prev) => ({
        ...prev,
        [produtoId]: { percentual: 100, etapa: t("✨ Vídeo WhatsApp pronto!"), finalizado: true },
      }));
      toast.success(t("Mídias do produto processadas com sucesso!"));
      router.refresh();

      setTimeout(() => {
        setProcessamentos((prev) => {
          const copia = { ...prev };
          delete copia[produtoId];
          return copia;
        });
      }, 5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("Falha ao processar mídias.");
      setProcessamentos((prev) => ({
        ...prev,
        [produtoId]: { percentual: 0, etapa: msg, erro: msg, finalizado: true },
      }));
      toast.error(t("O produto foi salvo, mas houve falha no vídeo: ") + msg);
    }
  }

  async function salvar() {
    const corpo = doRascunho(rascunho, t);
    if ("erro" in corpo) {
      toast.error(corpo.erro as string);
      return;
    }
    setSalvando(true);
    try {
      const res = await apiClient.post<{ data: Produto }>("/api/v1/products", corpo);
      const novoProduto = res.data;

      // Fecha o diálogo e limpa o formulário na hora para retorno imediato à lista
      setCriando(false);
      setRascunho(VAZIO);

      // Atualiza a lista instantaneamente
      setProdutosLocais((prev) => [novoProduto, ...prev.filter((p) => p.id !== novoProduto.id)]);

      const fotosParaSubir = [...fotosNovas];
      const videoParaSubir = videoNovo;
      setFotosNovas([]);
      setVideoNovo(null);

      if (fotosParaSubir.length === 0 && !videoParaSubir) {
        toast.success(t("Produto cadastrado com sucesso!"));
        router.refresh();
      } else {
        toast.success(t("Produto salvo! Processando mídias em segundo plano..."));
        void processarMidiasEmSegundoPlano(novoProduto.id, fotosParaSubir, videoParaSubir);
      }
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  async function sincronizarComBling() {
    setSincronizandoBling(true);
    const toastId = toast.loading(t("Sincronizando catálogo com o Bling ERP..."));
    try {
      const res = await apiClient.post<{ data: { total_processados?: number } }>(
        "/api/v1/integrations/bling/sync-products",
        {},
      );
      const total = res.data?.total_processados ?? 0;
      toast.success(t(`Sincronização concluída! ${total} produtos importados/atualizados do Bling.`), { id: toastId });
      router.refresh();
      setModalImportarAberto(false);
    } catch (e) {
      showApiError(e);
    } finally {
      setSincronizandoBling(false);
    }
  }

  const carregarMetaConfig = React.useCallback(async () => {
    setCarregandoMetaConfig(true);
    try {
      const res = await apiClient.get<{
        config: {
          catalog_id: string | null;
          has_token: boolean;
          has_custom_token: boolean;
          feed_url: string | null;
          last_sync_at: string | null;
          products_count: number;
        };
      }>("/api/v1/products/integrations/meta");
      if (res?.config) {
        setMetaConfig(res.config);
        setMetaCatalogId(res.config.catalog_id ?? "");
        setMetaFeedUrl(res.config.feed_url ?? "");
      }
    } catch {
      // Falha silenciosa
    } finally {
      setCarregandoMetaConfig(false);
    }
  }, []);

  React.useEffect(() => {
    if (modalImportarAberto && abaImportar === "meta") {
      void carregarMetaConfig();
    }
  }, [modalImportarAberto, abaImportar, carregarMetaConfig]);

  async function salvarConfigMeta() {
    setSalvandoMetaConfig(true);
    try {
      const payload: Record<string, unknown> = {
        catalog_id: metaCatalogId.trim() || null,
        feed_url: metaFeedUrl.trim() || null,
      };
      if (metaAccessToken.trim().length > 0) {
        payload.access_token = metaAccessToken.trim();
      }
      const res = await apiClient.patch<{
        config: {
          catalog_id: string | null;
          has_token: boolean;
          has_custom_token: boolean;
          feed_url: string | null;
          last_sync_at: string | null;
          products_count: number;
        };
      }>("/api/v1/products/integrations/meta", payload);
      if (res?.config) {
        setMetaConfig(res.config);
        setMetaAccessToken("");
      }
      toast.success(t("Configuração do Catálogo Meta salva com sucesso!"));
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvandoMetaConfig(false);
    }
  }

  async function sincronizarComMeta() {
    setSincronizandoMeta(true);
    const toastId = toast.loading(t("Sincronizando produtos com a Meta..."));
    try {
      if (
        metaCatalogId.trim() !== (metaConfig?.catalog_id ?? "") ||
        metaFeedUrl.trim() !== (metaConfig?.feed_url ?? "") ||
        metaAccessToken.trim().length > 0
      ) {
        const payload: Record<string, unknown> = {
          catalog_id: metaCatalogId.trim() || null,
          feed_url: metaFeedUrl.trim() || null,
        };
        if (metaAccessToken.trim().length > 0) {
          payload.access_token = metaAccessToken.trim();
        }
        await apiClient.patch("/api/v1/products/integrations/meta", payload);
        setMetaAccessToken("");
      }

      const res = await apiClient.post<{
        total: number;
        gravados: number;
        criados: number;
        atualizados: number;
        erros: Array<{ linha: number; motivo: string }>;
        last_sync_at: string;
      }>("/api/v1/products/integrations/meta/sync", {});

      const total = res.gravados ?? res.total ?? 0;
      toast.success(
        t(
          `Sincronização concluída! ${total} produtos processados (${res.criados ?? 0} novos, ${res.atualizados ?? 0} atualizados).`,
        ),
        { id: toastId },
      );
      router.refresh();
    } catch (e) {
      toast.dismiss(toastId);
      showApiError(e);
    } finally {
      setSincronizandoMeta(false);
      void carregarMetaConfig();
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

  async function confirmarExclusao() {
    if (!produtoParaExcluir) return;
    setExcluindo(true);
    try {
      await apiClient.delete(`/api/v1/products/${produtoParaExcluir.id}`);
      toast.success(t("Produto excluído"));
      setProdutoParaExcluir(null);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setExcluindo(false);
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
                if (f) {
                  void importar(f);
                  setModalImportarAberto(false);
                }
              }}
            />
            <Button
              variant="outline"
              disabled={importando}
              onClick={() => setModalImportarAberto(true)}
              data-testid="importar-planilha"
            >
              <DownloadSimple className="size-4 mr-1.5" />
              {t(importando ? "Importando…" : "Importar planilha & Integrações")}
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
            <label className="text-sm sm:col-span-2">
              {t("Descrição do produto")} <span className="text-muted-foreground text-xs">{t("(enviada no WhatsApp junto ao produto e lida pela IA)")}</span>
              <textarea
                value={rascunho.descricao}
                onChange={(e) => setRascunho({ ...rascunho, descricao: e.target.value })}
                rows={2}
                placeholder={t("Descreva detalhes, garantia, especificações e diferenciais...")}
                className="mt-1 w-full rounded-md border px-3 py-1.5 text-sm"
                data-testid="produto-descricao"
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
              {t("Preço original (De)")} <span className="text-muted-foreground">{t("(opcional - promoção)")}</span>
              <input
                value={rascunho.preco_de}
                onChange={(e) => setRascunho({ ...rascunho, preco_de: e.target.value })}
                placeholder="6.999,00"
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="produto-preco-de"
              />
            </label>
            <label className="text-sm">
              {t("Preço de venda (Por)")}
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

          {/* CARD DE UPLOAD DE IMAGENS (CONVERSOR AUTOMÁTICO JPEG) */}
          <div className="mt-5 rounded-lg border bg-card/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">{t("🖼️ Imagens do Produto")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("Aceita qualquer formato (PNG, WEBP, HEIC, JPG). Converte automaticamente para JPEG otimizado para WhatsApp.")}
                </p>
              </div>
              <input
                ref={fotosRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => void onFotosSelecionadas(e)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={fotosNovas.length >= 5}
                onClick={() => fotosRef.current?.click()}
              >
                {t("Adicionar fotos")} ({fotosNovas.length}/5)
              </Button>
            </div>

            {fotosNovas.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-3">
                {fotosNovas.map((item, idx) => (
                  <div key={idx} className="relative group size-20 rounded-md border bg-muted overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.url} alt="" className="size-full object-cover" />
                    <span className="absolute bottom-0 inset-x-0 bg-black/60 text-[9px] text-white text-center py-0.5">
                      JPEG
                    </span>
                    <button
                      type="button"
                      onClick={() => setFotosNovas(fotosNovas.filter((_, i) => i !== idx))}
                      className="absolute top-1 right-1 size-5 rounded-full bg-destructive text-white flex items-center justify-center text-xs opacity-80 hover:opacity-100"
                      title={t("Remover foto")}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* DOIS CARDS DE VÍDEO (URL EXTERNA vs UPLOAD PARA WHATSAPP) */}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {/* Card 1: URL Externa */}
            <div className="rounded-lg border bg-card/60 p-4 flex flex-col justify-between">
              <div>
                <h3 className="text-sm font-semibold">{t("🎬 Card 1: Vídeo demonstrativo (URL)")}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("Link público (YouTube, Vimeo, CDN). Usado em catálogos externos como Meta Shopping.")}
                </p>
                <input
                  value={rascunho.video_url}
                  onChange={(e) => setRascunho({ ...rascunho, video_url: e.target.value })}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="mt-3 h-9 w-full rounded-md border px-3 text-sm"
                  data-testid="produto-video-url"
                />
              </div>
              <span className="mt-2 block text-[11px] text-muted-foreground">
                {t("O atendente e os feeds da Meta recebem este link de referência externa.")}
              </span>
            </div>

            {/* Card 2: Upload de Vídeo para WhatsApp */}
            <div className="rounded-lg border bg-card/60 p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{t("📲 Card 2: Vídeo do Produto para WhatsApp (Upload)")}</h3>
                  <input
                    ref={videoRef}
                    type="file"
                    accept="video/*,.mp4,.mov,.webm"
                    className="hidden"
                    onChange={onVideoSelecionado}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => videoRef.current?.click()}
                  >
                    {videoNovo ? t("Trocar vídeo") : t("Selecionar vídeo")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("Arquivo enviado como vídeo nativo no chat do WhatsApp (até 300 MB). Comprimido e otimizado em HD/Full HD.")}
                </p>

                {videoNovo ? (
                  <div className="mt-3 relative rounded-md border bg-black overflow-hidden">
                    <video src={videoNovo.url} controls className="max-h-36 w-full" />
                    <button
                      type="button"
                      onClick={() => setVideoNovo(null)}
                      className="absolute top-2 right-2 rounded-full bg-destructive/90 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-destructive"
                    >
                      {t("Remover vídeo")}
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 flex h-20 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                    {t("Nenhum vídeo selecionado.")}
                  </div>
                )}
              </div>
              <span className="mt-2 block text-[11px] text-muted-foreground">
                {t("Quando o atendente enviar este produto, o WhatsApp reproduz o vídeo nativamente no chat.")}
              </span>
            </div>
          </div>

          {/* ACORDEOM INTEGRAÇÕES & LOGÍSTICA (BLING & META) */}
          <details className="mt-5 rounded-lg border bg-card/40 p-4 text-sm">
            <summary className="cursor-pointer font-medium text-foreground select-none">
              {t("🛒 Integrações & Logística (Opcional - Bling & Meta Catalog)")}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 pt-3 border-t">
              <label className="text-sm">
                {t("Código de Barras (EAN / GTIN)")}
                <input
                  value={rascunho.gtin}
                  onChange={(e) => setRascunho({ ...rascunho, gtin: e.target.value })}
                  placeholder="7891234567890"
                  className="mt-1 h-9 w-full rounded-md border px-3"
                />
              </label>
              <label className="text-sm">
                {t("NCM (Fiscal Bling)")}
                <input
                  value={rascunho.ncm}
                  onChange={(e) => setRascunho({ ...rascunho, ncm: e.target.value })}
                  placeholder="8517.13.00"
                  className="mt-1 h-9 w-full rounded-md border px-3"
                />
              </label>
              <label className="text-sm">
                {t("Origem Fiscal")}
                <select
                  value={rascunho.origem_fiscal}
                  onChange={(e) => setRascunho({ ...rascunho, origem_fiscal: e.target.value })}
                  className="mt-1 h-9 w-full rounded-md border px-3 bg-background"
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
                  />
                  <span>×</span>
                  <input
                    value={rascunho.largura_cm}
                    onChange={(e) => setRascunho({ ...rascunho, largura_cm: e.target.value })}
                    placeholder="Larg."
                    className="h-9 w-1/3 rounded-md border px-2 text-center text-xs"
                  />
                  <span>×</span>
                  <input
                    value={rascunho.altura_cm}
                    onChange={(e) => setRascunho({ ...rascunho, altura_cm: e.target.value })}
                    placeholder="Alt."
                    className="h-9 w-1/3 rounded-md border px-2 text-center text-xs"
                  />
                </div>
              </label>
              <label className="text-sm">
                {t("Condição do Item (Meta)")}
                <select
                  value={rascunho.condicao}
                  onChange={(e) => setRascunho({ ...rascunho, condicao: e.target.value })}
                  className="mt-1 h-9 w-full rounded-md border px-3 bg-background"
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
                />
              </label>
            </div>
          </details>

          <div className="mt-5">
            <Button onClick={salvar} disabled={salvando} data-testid="salvar-produto">
              {t(salvando ? "Salvando…" : "Salvar produto")}
            </Button>
          </div>
        </div>
      ) : null}

      {produtosLocais.length === 0 && buscaInicial !== "" ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="produtos-busca-vazia">
          <p className="font-medium">{t("Nenhum produto encontrado para essa busca")}</p>
        </div>
      ) : produtosLocais.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="produtos-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul
          className={`divide-y rounded-lg border ${carregando ? "opacity-60" : ""}`}
          aria-busy={carregando}
          data-testid="lista-produtos"
        >
          {produtosLocais.map((p) => {
            const capa = p.fotos?.[0] ? urlsDasFotos[p.fotos[0]] : undefined;
            const videoWhatsAppUrl = p.video_file_path
              ? urlsVideosLocais[p.video_file_path] || urlsDosVideos[p.video_file_path]
              : undefined;
            return (
              <li key={p.id} data-testid={`produto-${p.codigo}`}>
                <div className="flex items-center gap-4 p-3">
                  {capa ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={capa} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`truncate font-medium ${p.ativo ? "" : "text-muted-foreground line-through"}`}>
                        {p.nome}
                      </p>
                      {p.video_file_path || videoWhatsAppUrl ? (
                        <button
                          type="button"
                          onClick={() => setVideoModal({ nome: p.nome, url: videoWhatsAppUrl || "" })}
                          className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400"
                          title={t("Assistir vídeo nativo do WhatsApp")}
                        >
                          <VideoCamera className="h-3 w-3" />
                          {t("Vídeo WhatsApp")}
                        </button>
                      ) : null}
                      {p.video_url ? (
                        <a
                          href={p.video_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-600 hover:bg-sky-500/20 dark:text-sky-400"
                          title={t("Ver vídeo demonstrativo externo")}
                        >
                          {t("Vídeo Link")}
                        </a>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {p.codigo}
                      {p.marca ? ` · ${p.marca}` : ""}
                      {p.controla_estoque
                        ? ` · ${p.quantidade} ${t("em estoque")}`
                        : ` · ${t("sem controle de estoque")}`}
                      {p.gtin ? ` · EAN: ${p.gtin}` : ""}
                    </p>
                    {p.descricao ? (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2 italic">
                        &ldquo;{p.descricao}&rdquo;
                      </p>
                    ) : null}

                    {/* BARRA DE PROGRESSO EM TEMPO REAL PARA VÍDEO/FOTOS EM SEGUNDO PLANO */}
                    {processamentos[p.id] ? (
                      <div className="mt-2.5 rounded-md border border-primary/30 bg-primary/5 p-2.5">
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <span className="flex items-center gap-1.5 font-medium text-foreground">
                            <CircleNotch
                              className={`size-3.5 text-primary ${
                                processamentos[p.id]?.finalizado ? "" : "animate-spin"
                              }`}
                            />
                            {processamentos[p.id]?.etapa}
                          </span>
                          <span className="tabular-nums font-semibold text-primary">
                            {processamentos[p.id]?.percentual}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full transition-all duration-300 ${
                              processamentos[p.id]?.erro ? "bg-destructive" : "bg-primary"
                            }`}
                            style={{ width: `${processamentos[p.id]?.percentual}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    {p.preco_de_cents && p.preco_de_cents > p.preco_cents ? (
                      <div className="flex flex-col items-end">
                        <span className="text-xs text-muted-foreground line-through tabular-nums">
                          {t("De")} {formatCents(p.preco_de_cents, p.moeda)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                            -{Math.round(((p.preco_de_cents - p.preco_cents) / p.preco_de_cents) * 100)}%
                          </span>
                          <span className="tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                            {formatCents(p.preco_cents, p.moeda)}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <span className="tabular-nums font-medium">
                        {formatCents(p.preco_cents, p.moeda)}
                      </span>
                    )}
                  </div>
                  {podeEditar ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditando((v) => (v === p.id ? null : p.id))}
                        aria-expanded={editando === p.id}
                        data-testid={`editar-${p.codigo}`}
                      >
                        {t("Editar")}
                      </Button>
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
                        onClick={() => setVideoAberto((v) => (v === p.id ? null : p.id))}
                        aria-expanded={videoAberto === p.id}
                      >
                        {t("Vídeo")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void alternarAtivo(p)}
                        data-testid={`alternar-${p.codigo}`}
                      >
                        {t(p.ativo ? "Desativar" : "Reativar")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setProdutoParaExcluir(p)}
                        data-testid={`excluir-${p.codigo}`}
                        title={t("Excluir produto")}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
                {podeEditar && fotosAbertas === p.id ? (
                  <FotosDoProduto produto={p} urls={urlsDasFotos} />
                ) : null}
                {podeEditar && videoAberto === p.id ? (
                  <VideoDoProduto
                    produto={p}
                    urlDoVideo={p.video_file_path ? urlsVideosLocais[p.video_file_path] || urlsDosVideos[p.video_file_path] : undefined}
                    onRemoverVideo={async () => {
                      await apiClient.delete(`/api/v1/products/${p.id}/video`);
                      const oldPath = p.video_file_path;
                      setProdutosLocais((atuais) =>
                        atuais.map((item) => (item.id === p.id ? { ...item, video_file_path: null } : item)),
                      );
                      if (oldPath) {
                        setUrlsVideosLocais((prev) => {
                          const copia = { ...prev };
                          delete copia[oldPath];
                          return copia;
                        });
                      }
                      toast.success(t("Vídeo removido com sucesso"));
                      router.refresh();
                    }}
                    onSubstituirVideo={(arquivo) => {
                      setVideoAberto(null);
                      void processarMidiasEmSegundoPlano(p.id, [], { file: arquivo, url: URL.createObjectURL(arquivo) });
                    }}
                  />
                ) : null}
                {podeEditar && editando === p.id ? (
                  <EdicaoDoProduto
                    key={p.id}
                    produto={p}
                    aoFechar={() => setEditando(null)}
                    onProdutoAtualizado={(atualizado) => {
                      setProdutosLocais((atuais) =>
                        atuais.map((item) => (item.id === atualizado.id ? { ...item, ...atualizado } : item)),
                      );
                      if (atualizado.video_file_path === null && p.video_file_path) {
                        setUrlsVideosLocais((prev) => {
                          const copia = { ...prev };
                          delete copia[p.video_file_path!];
                          return copia;
                        });
                      }
                    }}
                    onSubstituirVideo={(prodId, file) => {
                      void processarMidiasEmSegundoPlano(prodId, [], { file, url: URL.createObjectURL(file) });
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* Modal Importar Planilha, Catálogo Meta & Bling ERP */}
      <Dialog open={modalImportarAberto} onOpenChange={setModalImportarAberto}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DownloadSimple className="size-5 text-primary" />
              {t("Importar & Sincronizar Catálogo")}
            </DialogTitle>
            <DialogDescription>
              {t("Importe produtos via planilha CSV, conecte com o Catálogo da Meta ou sincronize com o Bling ERP.")}
            </DialogDescription>
          </DialogHeader>

          <Tabs value={abaImportar} onValueChange={(v) => setAbaImportar(v as "planilha" | "meta" | "bling")} className="mt-2">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="planilha">{t("Planilha CSV")}</TabsTrigger>
              <TabsTrigger value="meta">{t("Catálogo Meta")}</TabsTrigger>
              <TabsTrigger value="bling">{t("Bling ERP")}</TabsTrigger>
            </TabsList>

            {/* ABA 1: PLANILHA CSV */}
            <TabsContent value="planilha" className="space-y-4 pt-4">
              <div className="rounded-lg border bg-muted/30 p-3.5 text-sm space-y-2">
                <p className="font-medium text-foreground">{t("Modelos de Planilha Disponíveis:")}</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <a
                    href="/api/v1/products/import?formato=padrao"
                    download="modelo-catalogo-padrao.csv"
                    className="inline-flex items-center gap-1 rounded bg-secondary px-2.5 py-1 text-secondary-foreground hover:bg-secondary/80 font-medium"
                  >
                    <DownloadSimple className="size-3.5" />
                    {t("Modelo Padrão")}
                  </a>
                  <a
                    href="/api/v1/products/import?formato=meta"
                    download="modelo-meta-catalog.csv"
                    className="inline-flex items-center gap-1 rounded bg-secondary px-2.5 py-1 text-secondary-foreground hover:bg-secondary/80 font-medium"
                  >
                    <DownloadSimple className="size-3.5" />
                    {t("Modelo Meta Catalog")}
                  </a>
                  <a
                    href="/api/v1/products/import?formato=bling"
                    download="modelo-bling-erp.csv"
                    className="inline-flex items-center gap-1 rounded bg-secondary px-2.5 py-1 text-secondary-foreground hover:bg-secondary/80 font-medium"
                  >
                    <DownloadSimple className="size-3.5" />
                    {t("Modelo Bling ERP")}
                  </a>
                </div>
              </div>

              <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center">
                <FileText className="size-10 text-muted-foreground mb-2" />
                <p className="text-sm font-medium">{t("Selecione sua planilha CSV")}</p>
                <p className="text-xs text-muted-foreground mt-1 mb-4">
                  {t("Suporta formato Deskcomm, feed oficial da Meta Commerce ou exportação do Bling.")}
                </p>
                <Button
                  onClick={() => arquivoRef.current?.click()}
                  disabled={importando}
                >
                  {importando ? t("Processando planilha...") : t("Escolher arquivo CSV")}
                </Button>
              </div>
            </TabsContent>

            {/* ABA 2: CATÁLOGO META COMMERCE */}
            <TabsContent value="meta" className="space-y-4 pt-4">
              <div className="rounded-lg border bg-blue-500/10 border-blue-500/20 p-4 text-sm space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap font-medium text-blue-600 dark:text-blue-400">
                  <div className="flex items-center gap-2">
                    <Storefront className="size-4" />
                    {t("Catálogo de Produtos da Meta (Facebook & Instagram)")}
                  </div>
                  {metaConfig?.last_sync_at ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {t("Última sincronização:")} {new Date(metaConfig.last_sync_at).toLocaleString()} ({metaConfig.products_count} {t("produtos")})
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t(
                    "Conecte e sincronize produtos do seu Catálogo do Meta Commerce Manager. Funciona com qualquer canal (WhatsApp Oficial ou QR Code/WAHA).",
                  )}
                </p>
              </div>

              {carregandoMetaConfig ? (
                <div className="flex items-center justify-center p-6 text-sm text-muted-foreground gap-2">
                  <CircleNotch className="size-4 animate-spin text-primary" />
                  {t("Carregando configurações do catálogo...")}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-3 rounded-lg border p-3.5 bg-muted/20">
                    <div>
                      <label className="text-xs font-semibold block mb-1">
                        {t("ID do Catálogo no Meta Commerce Manager")}
                      </label>
                      <Input
                        value={metaCatalogId}
                        onChange={(e) => setMetaCatalogId(e.target.value)}
                        placeholder="Ex: 28651441394507856"
                        className="font-mono text-sm"
                        disabled={sincronizandoMeta || salvandoMetaConfig}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {t("Localizado em Gerenciador de Comércio → Configurações do Catálogo → Identificador.")}
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold block">
                          {t("Token de Acesso da Meta")}
                        </label>
                        {metaConfig?.has_token ? (
                          <span className="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium">
                            <CheckCircle className="size-3" />
                            {metaConfig.has_custom_token
                              ? t("Token customizado ativo")
                              : t("Herdado da conexão oficial")}
                          </span>
                        ) : (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400">
                            {t("Nenhum token configurado")}
                          </span>
                        )}
                      </div>
                      <Input
                        type="password"
                        value={metaAccessToken}
                        onChange={(e) => setMetaAccessToken(e.target.value)}
                        placeholder={
                          metaConfig?.has_token
                            ? t("•••••••• (Token já ativo — preencha apenas para trocar)")
                            : t("Token do Sistema ou Graph API (EAAG...)")
                        }
                        className="font-mono text-sm"
                        disabled={sincronizandoMeta || salvandoMetaConfig}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {t(
                          "Se a API Oficial da Meta já estiver conectada, o token é herdado automaticamente. Se usar WhatsApp via QR Code, insira um token com permissão catalog_management.",
                        )}
                      </p>
                    </div>

                    <div>
                      <label className="text-xs font-semibold block mb-1">
                        {t("URL do Feed de Dados da Meta (Alternativa ao Token)")}
                      </label>
                      <Input
                        value={metaFeedUrl}
                        onChange={(e) => setMetaFeedUrl(e.target.value)}
                        placeholder="Ex: https://.../products.csv"
                        className="text-sm"
                        disabled={sincronizandoMeta || salvandoMetaConfig}
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {t("Opcional: URL pública do feed CSV do Commerce Manager para atualização periódica.")}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={salvarConfigMeta}
                        disabled={salvandoMetaConfig || sincronizandoMeta}
                        size="sm"
                      >
                        {salvandoMetaConfig ? t("Salvando…") : t("Salvar Configurações")}
                      </Button>

                      <Button
                        type="button"
                        variant="default"
                        onClick={sincronizarComMeta}
                        disabled={sincronizandoMeta || salvandoMetaConfig || (!metaCatalogId.trim() && !metaFeedUrl.trim())}
                        size="sm"
                        className="flex-1"
                      >
                        <ArrowsClockwise className={`size-4 mr-1.5 ${sincronizandoMeta ? "animate-spin" : ""}`} />
                        {sincronizandoMeta ? t("Sincronizando...") : t("Sincronizar Catálogo Meta Agora")}
                      </Button>
                    </div>
                  </div>

                  {/* Opções manuais / exportação */}
                  <div className="pt-2">
                    <p className="text-xs font-medium text-muted-foreground mb-2">
                      {t("Outras opções de integração")}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <a
                        href="/api/v1/products/export/meta"
                        download="catalogo-meta-commerce.csv"
                        className="flex items-center gap-2.5 rounded-lg border p-3 hover:bg-muted/50 transition-colors text-left"
                      >
                        <DownloadSimple className="size-5 text-primary shrink-0" />
                        <div>
                          <span className="text-xs font-semibold block">{t("Exportar Catálogo para Meta")}</span>
                          <span className="text-[11px] text-muted-foreground block">
                            {t("Gera CSV pronto para o Commerce Manager")}
                          </span>
                        </div>
                      </a>

                      <button
                        type="button"
                        onClick={() => arquivoRef.current?.click()}
                        disabled={importando}
                        className="flex items-center gap-2.5 rounded-lg border p-3 hover:bg-muted/50 transition-colors text-left"
                      >
                        <FileText className="size-5 text-primary shrink-0" />
                        <div>
                          <span className="text-xs font-semibold block">{t("Importar CSV Manualmente")}</span>
                          <span className="text-[11px] text-muted-foreground block">
                            {t("Carrega arquivo CSV do seu computador")}
                          </span>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            {/* ABA 3: BLING ERP */}
            <TabsContent value="bling" className="space-y-4 pt-4">
              <div className="rounded-lg border bg-amber-500/10 border-amber-500/20 p-4 text-sm space-y-2">
                <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-400">
                  <Package className="size-4" />
                  {t("Sincronização Automática com Bling ERP")}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t(
                    "Importa e sincroniza automaticamente códigos, nomes, descrições, preços, estoque, EAN, NCM e peso diretamente da sua conta Bling configurada no Deskcomm.",
                  )}
                </p>
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  onClick={sincronizarComBling}
                  disabled={sincronizandoBling}
                  className="w-full h-11"
                >
                  <ArrowsClockwise className={`size-4 mr-2 ${sincronizandoBling ? "animate-spin" : ""}`} />
                  {sincronizandoBling ? t("Sincronizando com o Bling...") : t("Sincronizar Catálogo do Bling ERP Agora")}
                </Button>

                <div className="text-center pt-2">
                  <a
                    href="/api/v1/products/import?formato=bling"
                    download="modelo-bling-erp.csv"
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                  >
                    {t("Ou baixe o modelo de importação manual do Bling (CSV)")}
                  </a>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Modal para assistir ao vídeo do WhatsApp */}
      <Dialog open={!!videoModal} onOpenChange={(aberto) => !aberto && setVideoModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <VideoCamera className="h-5 w-5 text-emerald-600" />
              {videoModal?.nome}
            </DialogTitle>
          </DialogHeader>
          <div className="mt-2 rounded-md bg-black overflow-hidden">
            {videoModal?.url ? (
              <video src={videoModal.url} controls autoPlay className="w-full max-h-80" />
            ) : (
              <p className="p-4 text-center text-sm text-white">{t("Vídeo indisponível.")}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!produtoParaExcluir} onOpenChange={(aberto) => !aberto && setProdutoParaExcluir(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Excluir produto?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Tem certeza que deseja excluir o produto")} <strong>{produtoParaExcluir?.nome}</strong> ({produtoParaExcluir?.codigo})? {t("Esta ação não pode ser desfeita e todas as fotos serão apagadas permanentemente.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={excluindo}>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={excluindo}
              onClick={(e) => {
                e.preventDefault();
                void confirmarExclusao();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t(excluindo ? "Excluindo…" : "Excluir")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {total > 0 ? (
        <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground" data-testid="paginacao-produtos">
          <span className="tabular-nums" data-testid="contagem-produtos">
            {primeiro}–{ultimo} {t("de")} {total}
          </span>
          {total > porPagina ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pagina <= 1 || carregando}
                onClick={() => irPara(busca, pagina - 1)}
                data-testid="pagina-anterior"
              >
                {t("Página anterior")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={ultimo >= total || carregando}
                onClick={() => irPara(busca, pagina + 1)}
                data-testid="proxima-pagina"
              >
                {t("Próxima página")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
