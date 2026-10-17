"use client";

import { useT } from "@/hooks/i18n/useT";
import { useRef, useState } from "react";
import Link from "next/link";

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
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/types";
import {
  useImportFollowupFlow,
  type FollowupFlowPointerRow,
  type PendenciaDaImportacao,
} from "@/hooks/followup/useFollowupFlows";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rota do editor desta superfície — o link «Abrir o fluxo» depois de importar. */
  baseHref: string;
}

/** O teto do servidor (`TAMANHO_MAXIMO_DO_ARQUIVO`) — conferido aqui para não subir o que vai voltar 413. */
const TAMANHO_MAXIMO = 512 * 1024;

/** A frase de cada pendência. O código é do contrato (`portabilidade.ts`); a frase é desta tela. */
function fraseDaPendencia(p: PendenciaDaImportacao, t: (texto: string) => string): string {
  const onde = p.no ? `«${p.no.label}»: ` : `${t("Gatilho")}: `;
  const nome = p.referencia ? ` (${p.referencia})` : "";
  switch (p.codigo) {
    case "etapa_remapeada":
      return onde + t("a etapa foi ligada à etapa de mesmo nome desta conta.") + nome;
    case "etapa_nao_encontrada":
      return (
        onde +
        t("a etapa não existe nesta conta. Escolha a etapa no editor antes de publicar.") +
        nome
      );
    case "modelo_remapeado":
      return (
        onde + t("o modelo de mensagem foi ligado ao modelo de mesmo nome desta conta.") + nome
      );
    case "modelo_nao_encontrado":
      return (
        onde +
        t(
          "o modelo de mensagem não existe nesta conta. Escolha outro no editor antes de publicar.",
        ) +
        nome
      );
    case "modelo_reserva_removido":
      return onde + t("o modelo de reserva não existe nesta conta e foi retirado.") + nome;
    case "responsavel_trocado":
      return onde + t("a pessoa da tarefa não é desta conta; a tarefa vai para o dono do lead.");
    case "proximo_fluxo_remapeado":
      return onde + t("o próximo fluxo foi ligado ao fluxo de mesmo nome desta conta.") + nome;
    case "proximo_fluxo_removido":
      return (
        onde + t("o próximo fluxo não existe nesta conta; ao finalizar, nada é iniciado.") + nome
      );
    case "gatilho_trocado_para_manual":
      return (
        onde +
        t(
          "o gatilho apontava para algo que não existe nesta conta e voltou para Manual. Escolha o gatilho antes de publicar.",
        ) +
        nome
      );
    default:
      return onde + p.codigo;
  }
}

export function ImportFlowDialog({ open, onOpenChange, baseHref }: Props) {
  const t = useT();
  const importar = useImportFollowupFlow();
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [texto, setTexto] = useState("");
  const [nomeDoArquivo, setNomeDoArquivo] = useState<string | null>(null);
  const [nome, setNome] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [problemas, setProblemas] = useState<string[]>([]);
  const [resultado, setResultado] = useState<{
    flow: FollowupFlowPointerRow;
    pendencias: PendenciaDaImportacao[];
  } | null>(null);

  const limpar = () => {
    setTexto("");
    setNomeDoArquivo(null);
    setNome("");
    setErro(null);
    setProblemas([]);
    setResultado(null);
    if (arquivoRef.current) arquivoRef.current.value = "";
  };

  const aoEscolherArquivo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = e.target.files?.[0];
    setErro(null);
    setProblemas([]);
    if (!arquivo) return;
    if (arquivo.size > TAMANHO_MAXIMO) {
      setErro(t("Arquivo grande demais para um fluxo (máximo de 512 KB)."));
      return;
    }
    setNomeDoArquivo(arquivo.name);
    setTexto(await arquivo.text());
  };

  const aoImportar = (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);
    setProblemas([]);
    let file: unknown;
    try {
      file = JSON.parse(texto);
    } catch {
      setErro(t("O conteúdo não é um JSON válido. Use o arquivo baixado em «Exportar»."));
      return;
    }
    importar.mutate(
      { file, ...(nome.trim() ? { name: nome.trim() } : {}) },
      {
        onSuccess: (data) => setResultado(data),
        onError: (err: unknown) => {
          setErro(
            err instanceof Error && err.message
              ? t(err.message)
              : t("Não consegui importar o fluxo. Tente de novo."),
          );
          const lista = err instanceof ApiError ? (err.details?.problemas as unknown) : undefined;
          setProblemas(Array.isArray(lista) ? lista.map(String) : []);
        },
      },
    );
  };

  const bloqueiam = resultado?.pendencias.filter((p) => p.bloqueia) ?? [];
  const avisos = resultado?.pendencias.filter((p) => !p.bloqueia) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) limpar();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Importar fluxo")}</DialogTitle>
          <DialogDescription>
            {t(
              "Use um arquivo baixado em «Exportar», desta ou de outra conta. O fluxo entra como rascunho: nada é enviado até você revisar e publicar.",
            )}
          </DialogDescription>
        </DialogHeader>

        {resultado ? (
          <div className="space-y-4" data-testid="import-flow-result">
            <p className="text-sm">
              {t("Importado como rascunho:")} <strong>{resultado.flow.name}</strong>
            </p>
            {bloqueiam.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-error-fg">
                  {t("Resolva antes de publicar:")}
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {bloqueiam.map((p, i) => (
                    <li key={`b${i}`}>{fraseDaPendencia(p, t)}</li>
                  ))}
                </ul>
              </div>
            )}
            {avisos.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">{t("Ajustado automaticamente:")}</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
                  {avisos.map((p, i) => (
                    <li key={`a${i}`}>{fraseDaPendencia(p, t)}</li>
                  ))}
                </ul>
              </div>
            )}
            {resultado.pendencias.length === 0 && (
              <p className="text-sm text-text-muted">
                {t(
                  "Todas as referências do arquivo existem nesta conta. Revise o fluxo e publique quando quiser.",
                )}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={limpar}>
                {t("Importar outro")}
              </Button>
              <Button asChild>
                <Link href={`${baseHref}/${resultado.flow.id}`}>{t("Abrir o fluxo")}</Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={aoImportar} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="import-flow-file">{t("Arquivo do fluxo (.json)")}</Label>
              <Input
                id="import-flow-file"
                ref={arquivoRef}
                type="file"
                accept=".json,application/json"
                onChange={(e) => void aoEscolherArquivo(e)}
              />
              {nomeDoArquivo && <p className="text-xs text-text-muted">{nomeDoArquivo}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="import-flow-text">{t("Ou cole o conteúdo do arquivo")}</Label>
              <Textarea
                id="import-flow-text"
                value={texto}
                onChange={(e) => {
                  setTexto(e.target.value);
                  setNomeDoArquivo(null);
                }}
                rows={6}
                className="font-mono text-xs"
                placeholder='{ "format": …, "version": 1, "flow": { … } }'
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="import-flow-name">{t("Nome (opcional)")}</Label>
              <Input
                id="import-flow-name"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder={t("Deixe em branco para usar o nome do arquivo")}
                maxLength={80}
              />
            </div>
            {erro && (
              <div
                role="alert"
                data-testid="import-flow-error"
                className="space-y-1 text-sm text-error-fg"
              >
                <p>{erro}</p>
                {problemas.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs">
                    {problemas.map((linha, i) => (
                      <li key={i}>{linha}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={importar.isPending}
              >
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={importar.isPending || texto.trim().length === 0}>
                {importar.isPending ? t("Importando…") : t("Importar")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
