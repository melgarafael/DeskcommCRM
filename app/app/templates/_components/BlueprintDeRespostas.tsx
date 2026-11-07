"use client";

import { useT } from "@/hooks/i18n/useT";
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { DownloadSimple, UploadSimple } from "@/lib/ui/icons";
import { apiClient } from "@/lib/api/client";
import { CHAVE_DOS_TEMPLATES } from "@/hooks/inbox/useMessageTemplates";

/**
 * A PORTA DO BLUEPRINT DE RESPOSTAS RÁPIDAS (#1995) — exportar as
 * compartilhadas num arquivo e aplicá-lo noutra organização que ainda não
 * tenha nenhuma. As rotas são `GET /api/v1/message-templates/exportar` e
 * `POST /api/v1/message-templates/importar`; as duas pedem `manager+`, e por
 * isso quem desenha os botões é `TemplatesClient`, só com `canShare`.
 */

/** O teto do servidor (`TAMANHO_MAXIMO` da rota de import), conferido antes de subir. */
const TAMANHO_MAXIMO = 2 * 1024 * 1024;

/** O nome que o servidor deu ao arquivo, ou um padrão se o cabeçalho não vier. */
function nomeDoAnexo(disposicao: string | null): string {
  const achado = disposicao?.match(/filename="([^"]+)"/);
  return achado?.[1] ?? "respostas-rapidas.json";
}

/**
 * Baixa o arquivo. `fetch` + Blob, e não `<a href>`: a rota devolve o arquivo
 * cru quando dá certo e o envelope de erro quando não dá — um link navegaria
 * até o JSON do 409 em vez de mostrar a frase.
 */
export function ExportarRespostasButton() {
  const t = useT();
  const exportar = useMutation({
    mutationKey: ["message-templates", "exportar"],
    mutationFn: async () => {
      const res = await fetch("/api/v1/message-templates/exportar", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const corpo = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(corpo?.error?.message || t("Erro ao exportar respostas rápidas."));
      }
      return {
        blob: await res.blob(),
        nome: nomeDoAnexo(res.headers.get("Content-Disposition")),
        midiasDeFora: Number(res.headers.get("X-Blueprint-Midias-Nao-Exportadas") ?? "0"),
      };
    },
    onSuccess: ({ blob, nome, midiasDeFora }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nome;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t("Respostas rápidas exportadas."));
      // A mídia não viaja (o caminho no bucket é desta organização): quem
      // exporta tem de saber que as respostas vão chegar como texto.
      if (midiasDeFora > 0) {
        toast.warning(
          t("Mídias que ficaram de fora, porque o arquivo leva só o texto: {n}.").replace(
            "{n}",
            String(midiasDeFora),
          ),
        );
      }
    },
    // A frase já vem traduzida do servidor.
    onError: (erro: Error) => toast.error(erro.message),
  });

  return (
    <Button
      type="button"
      variant="outline"
      disabled={exportar.isPending}
      onClick={() => exportar.mutate()}
      className="w-full sm:w-auto"
      data-testid="exportar-respostas"
    >
      <DownloadSimple aria-hidden />
      {exportar.isPending ? t("Exportando…") : t("Exportar")}
    </Button>
  );
}

interface ResultadoDoImport {
  importadas: number;
  sem_texto: number;
}

export function ImportarRespostasDialog() {
  const t = useT();
  const qc = useQueryClient();
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoDoImport | null>(null);

  const importar = useMutation({
    mutationKey: ["message-templates", "importar"],
    mutationFn: async (arquivo: unknown) => {
      const res = await apiClient.post<{ data: ResultadoDoImport }>(
        "/api/v1/message-templates/importar",
        arquivo,
      );
      return res.data;
    },
    onSuccess: (data) => {
      setResultado(data);
      void qc.invalidateQueries({ queryKey: CHAVE_DOS_TEMPLATES });
    },
    // A frase do servidor diz o motivo (já existe, só áudio, versão…), já traduzida.
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
        onClick={() => setAberto(true)}
        className="w-full sm:w-auto"
        data-testid="importar-respostas"
      >
        <UploadSimple aria-hidden /> {t("Importar")}
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
            <DialogTitle>{t("Importar respostas rápidas")}</DialogTitle>
            <DialogDescription>
              {t(
                "Use o arquivo baixado em «Exportar», desta ou de outra organização. Ele só é aplicado numa organização que ainda não tem respostas compartilhadas, e nunca substitui nada.",
              )}
            </DialogDescription>
          </DialogHeader>

          {resultado ? (
            <div className="space-y-3" data-testid="importar-respostas-resultado">
              <p className="text-sm">
                {t("Respostas importadas como compartilhadas: {n}.").replace(
                  "{n}",
                  String(resultado.importadas),
                )}
              </p>
              {resultado.sem_texto > 0 && (
                <p className="text-sm text-text-muted">
                  {t(
                    "Respostas só de áudio que ficaram de fora, porque o arquivo não leva a mídia: {n}.",
                  ).replace("{n}", String(resultado.sem_texto))}
                </p>
              )}
              <DialogFooter>
                <Button type="button" onClick={() => setAberto(false)}>
                  {t("Fechar")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={aoImportar} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="importar-respostas-arquivo">
                  {t("Arquivo de respostas rápidas (.json)")}
                </Label>
                <Input
                  id="importar-respostas-arquivo"
                  ref={arquivoRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => void aoEscolher(e)}
                />
              </div>
              {/* O que o arquivo NÃO traz, dito antes de aplicar (#1995): grupo
                  e mídia ficam na origem. */}
              <p className="text-xs text-text-muted">
                {t(
                  "As respostas chegam sem grupo, numa lista só, e sem imagem nem áudio: o arquivo leva o texto, o atalho e a ordem.",
                )}
              </p>
              {erro && (
                <p
                  role="alert"
                  data-testid="importar-respostas-erro"
                  className="text-sm text-error-fg"
                >
                  {erro}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAberto(false)}
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
