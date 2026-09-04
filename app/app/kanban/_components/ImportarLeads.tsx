"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { UploadSimple } from "@/lib/ui/icons";

import type { FunilDaLista } from "../_client";

export interface ResumoDaImportacao {
  total_linhas: number;
  criados: number;
  contatos_criados: number;
  erros: { linha: number; motivo: string }[];
  colunas_ignoradas: string[];
}

/**
 * IMPORTAR LEADS — a lista que a empresa já tem, para dentro do funil.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). Duas diferenças, e as
 * duas são consequência de a leitura ter ido para o SERVIDOR:
 *
 *  1. Não há passo de MAPEAR COLUNAS. O servidor reconhece os cabeçalhos usuais
 *     (`lib/leads/planilha.ts`) e o resumo diz, nominalmente, quais colunas ele
 *     ignorou — então quem precisa mapear renomeia o cabeçalho no Excel, que é
 *     um gesto que ele já sabe fazer. É o mesmo caminho por onde o catálogo da
 *     loja já entra, e ter dois jeitos de importar planilha neste produto seria
 *     duas verdades sobre o mesmo gesto.
 *  2. Não há escolha de ETAPA. Planilha traz gente NOVA, e gente nova entra na
 *     primeira etapa do funil. Perguntar seria uma pergunta a mais para uma
 *     resposta que já é a certa — e quem quiser outra etapa arrasta os cards,
 *     que é o gesto do quadro.
 */
export function ImportarLeads({ funis }: { funis: FunilDaLista[] }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [funilId, setFunilId] = useState(funis[0]?.id ?? "");
  const [enviando, setEnviando] = useState(false);
  const [resumo, setResumo] = useState<ResumoDaImportacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const arquivoRef = useRef<HTMLInputElement>(null);

  async function importar(arquivo: File) {
    setEnviando(true);
    setErro(null);
    setResumo(null);
    try {
      const form = new FormData();
      form.append("file", arquivo);
      form.append("pipeline_id", funilId);
      const res = await fetch("/api/v1/leads/import", { method: "POST", body: form });
      const json = (await res.json()) as
        | { data: ResumoDaImportacao }
        | { error?: { message?: string } };
      if (!res.ok || !("data" in json)) {
        setErro(
          ("error" in json ? json.error?.message : undefined) ??
            t("Não consegui ler essa planilha."),
        );
        return;
      }
      // O resumo fica NA TELA, não num toast que some em quatro segundos: quem
      // importou 300 linhas precisa ler quais foram recusadas e por quê.
      setResumo(json.data);
    } catch {
      setErro(t("Não consegui enviar o arquivo."));
    } finally {
      setEnviando(false);
      if (arquivoRef.current) arquivoRef.current.value = "";
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setAberto(true)} data-testid="abrir-importar-leads">
        {t("Importar planilha")}
      </Button>

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("Importar leads de uma planilha")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Um arquivo CSV com uma linha por lead. Os leads entram na primeira etapa do funil escolhido.",
              )}
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="funil-de-destino">{t("Funil de destino")}</Label>
              <Select value={funilId} onValueChange={setFunilId}>
                <SelectTrigger id="funil-de-destino">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {funis.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <input
              ref={arquivoRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              data-testid="arquivo-de-leads"
              onChange={(e) => {
                const arquivo = e.target.files?.[0];
                if (arquivo) void importar(arquivo);
              }}
            />
            <Button
              className="w-full gap-2"
              disabled={enviando || !funilId}
              onClick={() => arquivoRef.current?.click()}
              data-testid="escolher-planilha"
            >
              <UploadSimple size={16} aria-hidden />
              {enviando ? t("Importando…") : t("Escolher o arquivo CSV")}
            </Button>

            {/* Rota de API que devolve o arquivo com `content-disposition:
                attachment` — é download, não navegação de página. */}
            <a
              href="/api/v1/leads/import"
              download="modelo-leads.csv"
              className="block text-xs text-muted-foreground underline"
              data-testid="modelo-de-leads"
            >
              {t("Baixar planilha modelo")}
            </a>

            {erro ? (
              <p role="alert" className="rounded-md bg-destructive/10 p-2 text-xs font-medium text-destructive">
                {erro}
              </p>
            ) : null}

            {resumo ? (
              <div className="rounded-lg border p-3 text-sm" data-testid="resumo-da-importacao">
                <p className="font-medium">
                  {resumo.criados} {t("leads criados")} · {resumo.contatos_criados}{" "}
                  {t("contatos novos")} · {resumo.total_linhas} {t("linhas na planilha")}
                </p>
                {resumo.colunas_ignoradas.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("Colunas que não reconheci:")} {resumo.colunas_ignoradas.join(", ")}
                  </p>
                ) : null}
                {resumo.erros.length > 0 ? (
                  <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
                    {resumo.erros.map((e) => (
                      <li key={`${e.linha}-${e.motivo}`}>
                        {t("Linha")} {e.linha}: {e.motivo}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
