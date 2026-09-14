"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

export function DocumentIntakeDialog({ messageId, contactId, open, onOpenChange }: { messageId: string; contactId?: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const [pessoaCodigo, setPessoaCodigo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [pessoaVinculada, setPessoaVinculada] = useState(false);

  useEffect(() => {
    if (!open || !contactId) return;
    let ativo = true;
    void fetch(`/api/v1/contacts/${contactId}/advomax-link`).then((r) => r.ok ? r.json() : null).then((body) => {
      const link = body?.data as { pessoa_codigo?: number; status?: string } | null | undefined;
      if (!ativo || link?.status !== "linked" || !Number.isInteger(link.pessoa_codigo)) return;
      setPessoaCodigo(String(link.pessoa_codigo));
      setPessoaVinculada(true);
    }).catch(() => undefined);
    return () => { ativo = false; };
  }, [contactId, open]);

  async function salvar() {
    const codigo = Number(pessoaCodigo);
    if (!Number.isInteger(codigo) || codigo <= 0) {
      setErro(t("Informe o código da Pessoa no Advomax."));
      return;
    }
    setErro(null);
    setSalvando(true);
    try {
      const response = await fetch(`/api/v1/messages/${messageId}/document-intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pessoa_codigo: codigo, descricao: descricao.trim() || undefined }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível arquivar o documento."));
      onOpenChange(false);
      setPessoaCodigo("");
      setDescricao("");
    } catch (e) {
      setErro(e instanceof Error ? e.message : t("Não foi possível arquivar o documento."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Arquivar documento no Advomax")}</DialogTitle>
          <DialogDescription>{t("A mídia será salva na pasta de documentos da Pessoa e ficará visível na ficha do Advomax.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor={`pessoa-codigo-${messageId}`}>{t("Código da Pessoa")}</Label>
            <Input id={`pessoa-codigo-${messageId}`} inputMode="numeric" value={pessoaCodigo} onChange={(e) => setPessoaCodigo(e.target.value)} placeholder="Ex.: 1248" readOnly={pessoaVinculada} />
            {pessoaVinculada && <p className="text-xs text-muted-foreground">{t("Pessoa preenchida pelo vínculo jurídico deste contato.")}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`pessoa-descricao-${messageId}`}>{t("Descrição (opcional)")}</Label>
            <Input id={`pessoa-descricao-${messageId}`} value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder={t("Documento recebido pelo WhatsApp")} maxLength={1000} />
          </div>
          {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={salvando}>{t("Cancelar")}</Button>
          <Button onClick={salvar} disabled={salvando}>{salvando ? t("Salvando…") : t("Arquivar documento")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
