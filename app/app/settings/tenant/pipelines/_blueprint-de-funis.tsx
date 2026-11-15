"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { DownloadSimple, UploadSimple } from "@/lib/ui/icons";

/**
 * A PORTA DO BLUEPRINT DE FUNIS (#1995, fatia 2) — exportar os funis com as
 * etapas num arquivo e aplicá-lo nesta ou noutra organização. As rotas são
 * `GET /api/v1/pipelines/exportar` e `POST /api/v1/pipelines/importar`, as duas
 * `manager+` — a mesma régua da página de Configurações › Funis, que é quem
 * desenha os botões. O par de respostas rápidas é `BlueprintDeRespostas.tsx`.
 */

/** O teto do servidor (`TAMANHO_MAXIMO` da rota de import), conferido antes de subir. */
const TAMANHO_MAXIMO = 2 * 1024 * 1024;

function nomeDoAnexo(disposicao: string | null): string {
  return disposicao?.match(/filename="([^"]+)"/)?.[1] ?? "funis.json";
}

/**
 * `fetch` + Blob, e não `<a href>`: a rota devolve o arquivo cru quando dá
 * certo e o envelope de erro quando não dá — um link navegaria até o JSON do
 * 409 em vez de mostrar a frase.
 */
function ExportarFunisButton() {
  const t = useT();
  const exportar = useMutation({
    mutationKey: ["pipelines", "exportar"],
    mutationFn: async () => {
      const res = await fetch("/api/v1/pipelines/exportar", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(corpo?.error?.message || t("Erro ao exportar funis."));
      }
      return { blob: await res.blob(), nome: nomeDoAnexo(res.headers.get("Content-Disposition")) };
    },
    onSuccess: ({ blob, nome }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("Funis exportados."));
    },
    // A frase já vem traduzida do servidor.
    onError: (erro: Error) => toast.error(erro.message),
  });

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={exportar.isPending}
      onClick={() => exportar.mutate()}
      className="w-full sm:w-auto"
      data-testid="exportar-funis"
    >
      <DownloadSimple aria-hidden />
      {exportar.isPending ? t("Exportando…") : t("Exportar funis")}
    </Button>
  );
}

interface ResultadoDoImport {
  importados: number;
  renomeados: number;
  ja_existiam: number;
}

function ImportarFunisDialog() {
  const t = useT();
  const router = useRouter();
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoDoImport | null>(null);

  const importar = useMutation({
    mutationKey: ["pipelines", "importar"],
    mutationFn: async (arquivo: unknown) => {
      const res = await apiClient.post<{ data: ResultadoDoImport }>(
        "/api/v1/pipelines/importar",
        arquivo,
      );
      return res.data;
    },
    onSuccess: (data) => {
      setResultado(data);
      // A lista de funis desta página vem do servidor.
      if (data.importados > 0) router.refresh();
    },
    onError: (err: unknown) =>
      setErro(
        err instanceof Error && err.message ? err.message : t("Erro ao aplicar o blueprint."),
      ),
  });

  const limpar = () => {
    setTexto(null);
    setErro(null);
    setResultado(null);
    if (arquivoRef.current) arquivoRef.current.value = "";
  };
  // O botão do rodapé muda `open` por fora, e o Radix não chama `onOpenChange`
  // nesse caso: sem limpar aqui, reabrir mostrava o resultado do import anterior.
  const fechar = () => {
    limpar();
    setAberto(false);
  };

  const aoEscolher = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = e.target.files?.[0];
    setErro(null);
    setTexto(null);
    if (!arquivo) return;
    if (arquivo.size > TAMANHO_MAXIMO) {
      setErro(t("O arquivo passa de 2 MB."));
      return;
    }
    setTexto(await arquivo.text());
  };

  const aoImportar = (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    let arquivo: unknown;
    try {
      arquivo = JSON.parse(texto ?? "");
    } catch {
      setErro(t("O arquivo não é um JSON válido."));
      return;
    }
    importar.mutate(arquivo);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setAberto(true)}
        className="w-full sm:w-auto"
        data-testid="importar-funis"
      >
        <UploadSimple aria-hidden /> {t("Importar funis")}
      </Button>
      <Dialog
        open={aberto}
        onOpenChange={(proximo) => {
          if (!proximo) limpar();
          setAberto(proximo);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Importar funis")}</DialogTitle>
            <DialogDescription>
              {t(
                "Use o arquivo baixado em «Exportar funis», desta ou de outra organização. Cada funil chega como um funil novo, com as etapas na ordem do arquivo, e nada do que já existe é alterado. Aplicar o mesmo arquivo de novo não duplica.",
              )}
            </DialogDescription>
          </DialogHeader>

          {resultado ? (
            <div className="space-y-3" data-testid="importar-funis-resultado">
              <p className="text-sm">{t("Funis criados: {n}.").replace("{n}", String(resultado.importados))}</p>
              {resultado.renomeados > 0 && (
                <p className="text-sm text-text-muted">
                  {t("Criados como cópia, porque já havia um funil com o mesmo nome: {n}.").replace("{n}", String(resultado.renomeados))}
                </p>
              )}
              {resultado.ja_existiam > 0 && (
                <p className="text-sm text-text-muted">
                  {t("Já estavam aqui, com as mesmas etapas, e ficaram como estavam: {n}.").replace("{n}", String(resultado.ja_existiam))}
                </p>
              )}
              <DialogFooter>
                <Button type="button" onClick={fechar}>
                  {t("Fechar")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={aoImportar} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="importar-funis-arquivo">{t("Arquivo de funis (.json)")}</Label>
                <Input
                  id="importar-funis-arquivo"
                  ref={arquivoRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => void aoEscolher(e)}
                />
              </div>
              {/* O que o arquivo NÃO traz, dito antes de aplicar. */}
              <p className="text-xs text-text-muted">
                {t(
                  "O arquivo leva o nome, a descrição e as etapas de cada funil (nome, cor, ganho e perda). Vocabulário, campos personalizados e os ajustes finos de cada etapa ficam na origem.",
                )}
              </p>
              {erro && (
                <p role="alert" data-testid="importar-funis-erro" className="text-sm text-error-fg">
                  {erro}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={fechar}
                  disabled={importar.isPending}
                >
                  {t("Cancelar")}
                </Button>
                <Button type="submit" disabled={importar.isPending || !texto}>
                  {importar.isPending ? t("Importando…") : t("Importar")}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Os dois botões, lado a lado no topo de Configurações › Funis. */
export function BlueprintDeFunis() {
  return (
    <div className="flex flex-col gap-2 sm:flex-row" data-testid="blueprint-de-funis">
      <ExportarFunisButton />
      <ImportarFunisDialog />
    </div>
  );
}
