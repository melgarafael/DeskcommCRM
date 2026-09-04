"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useImportContacts } from "@/hooks/contacts/useImportContacts";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * Diálogo de importação de contatos por CSV. O resumo é mostrado NO diálogo
 * (e não só em toast) porque erros por linha são a parte que interessa —
 * fechar sozinho esconderia o que o usuário veio corrigir na planilha.
 */
export function ImportContactsDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const importar = useImportContacts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [resumo, setResumo] = useState<Awaited<ReturnType<typeof importar.mutateAsync>> | null>(null);

  function reset() {
    setFile(null);
    setResumo(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || importar.isPending) return;
    try {
      const r = await importar.mutateAsync(file);
      setResumo(r);
      if (r.imported > 0) toast.success(`${r.imported} ${t("contato(s) importado(s)")}`);
      if (r.errors.length > 0) toast.warning(`${r.errors.length} ${t("linha(s) com problema")}`);
    } catch (err) {
      // Falha de requisição (arquivo grande, formato errado…): mostra no rodapé.
      const msg =
        err instanceof Error && err.message
          ? t(err.message)
          : t("Não foi possível importar o arquivo.");
      toast.error(msg);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Importar contatos de planilha")}</DialogTitle>
          <DialogDescription>
            {t(
              "Envie um arquivo .csv com cabeçalho — colunas reconhecidas: nome, telefone, email, cpf, nascimento, tags. Excel: use “Salvar como” → “CSV UTF-8”. Máximo de 500 linhas por arquivo.",
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {!resumo && (
            <>
              <div className="space-y-2">
                <Label htmlFor="csv-file">{t("Arquivo CSV")}</Label>
                <Input
                  id="csv-file"
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file && (
                  <p className="text-xs text-muted-foreground">
                    {file.name} · {(file.size / 1024).toFixed(1)} KB
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={importar.isPending}
                >
                  {t("Cancelar")}
                </Button>
                <Button type="submit" disabled={!file || importar.isPending}>
                  {importar.isPending ? t("Importando…") : t("Importar")}
                </Button>
              </DialogFooter>
            </>
          )}

          {resumo && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="rounded-md bg-surface px-2 py-1">
                  {resumo.total_linhas} {t("linha(s) lidas")}
                </span>
                <span className="rounded-md px-2 py-1 font-medium">
                  {resumo.imported} {t("importado(s)")}
                </span>
                {resumo.skipped_duplicates > 0 && (
                  <span className="rounded-md bg-surface px-2 py-1">
                    {resumo.skipped_duplicates} {t("já existente(s)")}
                  </span>
                )}
                {resumo.errors.length > 0 && (
                  <span className="rounded-md px-2 py-1 font-medium">
                    {resumo.errors.length} {t("com erro")}
                  </span>
                )}
              </div>

              {resumo.errors.length > 0 && (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-sm">
                  {resumo.errors.map((err) => (
                    <p key={err.linha}>
                      {t("Linha")} {err.linha}: {err.motivo}
                    </p>
                  ))}
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={reset}>
                  {t("Importar outro arquivo")}
                </Button>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  {t("Concluir")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
