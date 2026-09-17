"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { Archive, ArrowSquareOut, CheckCircle, CircleNotch, Warning } from "@/lib/ui/icons";

type IntakeStatus = "pending" | "processing" | "uploaded" | "failed" | "ignored";
type Intake = {
  status: IntakeStatus;
  pessoa_codigo: number | null;
  filename: string | null;
  attempts: number;
  max_attempts: number;
  advomax_file_id: number | null;
  documents_url: string | null;
  failure_reason: string | null;
};

const statusCopy: Record<IntakeStatus, { label: string; tone: string }> = {
  pending: { label: "Aguardando envio", tone: "text-amber-700" },
  processing: { label: "Enviando para o Advomax", tone: "text-blue-700" },
  uploaded: { label: "Arquivado no Advomax", tone: "text-emerald-700" },
  failed: { label: "Falha — ação necessária", tone: "text-destructive" },
  ignored: { label: "Ignorado", tone: "text-muted-foreground" },
};

export function DocumentIntakeDialog({ messageId, contactId, open, onOpenChange }: { messageId: string; contactId?: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT();
  const [pessoaCodigo, setPessoaCodigo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [pessoaVinculada, setPessoaVinculada] = useState(false);
  const [intake, setIntake] = useState<Intake | null>(null);

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

  useEffect(() => {
    if (!open) return;
    let ativo = true;
    const carregar = async () => {
      const response = await fetch(`/api/v1/messages/${messageId}/document-intake`);
      if (!ativo || response.status === 404) return;
      const body = await response.json().catch(() => null);
      if (ativo && response.ok && body?.data) {
        const status = body.data as Intake;
        setIntake(status);
        if (Number.isInteger(status.pessoa_codigo)) setPessoaCodigo(String(status.pessoa_codigo));
      }
    };
    void carregar().catch(() => undefined);
    const timer = window.setInterval(() => { void carregar().catch(() => undefined); }, 5_000);
    return () => { ativo = false; window.clearInterval(timer); };
  }, [messageId, open]);

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
      if (body?.data) setIntake(body.data as Intake);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível arquivar o documento."));
    } catch (e) {
      setErro(e instanceof Error ? e.message : t("Não foi possível arquivar o documento."));
    } finally {
      setSalvando(false);
    }
  }

  const status = intake?.status;
  const copy = status ? statusCopy[status] : null;
  const bloqueado = salvando || status === "processing" || status === "uploaded";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (nextOpen) setErro(null); onOpenChange(nextOpen); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Arquivar documento no Advomax")}</DialogTitle>
          <DialogDescription>{t("A mídia será salva na pasta de documentos da Pessoa e ficará visível na ficha do Advomax.")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {copy && (
            <div className={`flex items-start gap-2 text-sm ${copy.tone}`} role="status">
              {status === "processing" ? <CircleNotch size={18} className="mt-0.5 animate-spin" aria-hidden /> : status === "uploaded" ? <CheckCircle size={18} className="mt-0.5" aria-hidden /> : status === "failed" ? <Warning size={18} className="mt-0.5" aria-hidden /> : <Archive size={18} className="mt-0.5" aria-hidden />}
              <div>
                <p className="font-medium">{t(copy.label)}</p>
                {status === "failed" && <p className="text-xs">{intake?.failure_reason || t("Verifique a integração e tente novamente.")}</p>}
                {status === "pending" && <p className="text-xs">{intake?.failure_reason ? `${t("Última tentativa")}: ${intake.failure_reason}` : t("O cron tentará arquivar automaticamente quando a ponte estiver disponível.")}</p>}
                {status === "processing" && <p className="text-xs">{t("O arquivo está sendo enviado com proteção contra duplicidade.")}</p>}
                {status === "uploaded" && <p className="text-xs">{t("Recibo Advomax")}: {intake?.advomax_file_id}</p>}
                {status === "uploaded" && intake?.documents_url && (
                  <a className="mt-1 inline-flex items-center gap-1 text-xs underline" href={intake.documents_url} target="_blank" rel="noreferrer">
                    {t("Abrir ficha da Pessoa")} <ArrowSquareOut size={12} aria-hidden />
                  </a>
                )}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor={`pessoa-codigo-${messageId}`}>{t("Código da Pessoa")}</Label>
            <Input id={`pessoa-codigo-${messageId}`} inputMode="numeric" value={pessoaCodigo} onChange={(e) => setPessoaCodigo(e.target.value)} placeholder="Ex.: 1248" readOnly={pessoaVinculada} disabled={bloqueado} />
            {pessoaVinculada && <p className="text-xs text-muted-foreground">{t("Pessoa preenchida pelo vínculo jurídico deste contato.")}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`pessoa-descricao-${messageId}`}>{t("Descrição (opcional)")}</Label>
            <Input id={`pessoa-descricao-${messageId}`} value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder={t("Documento recebido pelo WhatsApp")} maxLength={1000} disabled={bloqueado} />
          </div>
          {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={salvando}>{t("Fechar")}</Button>
          {status !== "uploaded" && status !== "processing" && status !== "ignored" && <Button onClick={salvar} disabled={bloqueado}>{salvando ? t("Enviando…") : status === "failed" ? t("Tentar novamente") : t("Arquivar documento")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
