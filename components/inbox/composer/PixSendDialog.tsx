"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePixKeys } from "@/hooks/inbox/usePixKeys";
import {
  formatarIntroChave,
  formatarIntroCobranca,
  montarEmvPix,
} from "@/lib/pix/emv";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  sending?: boolean;
  /**
   * Envia sequência: QR (imagem) + mensagem só com a chave/EMV para o celular
   * oferecer “Copiar” no toque longo. A bolha nativa “Copiar chave Pix” do
   * WhatsApp exige payment_info, que o WAHA ainda não expõe para envio.
   */
  onSendPix: (payload: {
    qrFile: File;
    caption: string;
    copyBody: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
}

type Modo = "chave" | "cobranca";

function dataUrlParaFile(dataUrl: string, nome: string): File {
  const virgula = dataUrl.indexOf(",");
  if (virgula < 0) throw new Error("Data URL inválida.");
  const meta = dataUrl.slice(0, virgula);
  const b64 = dataUrl.slice(virgula + 1);
  const mime = /data:(.*?);/.exec(meta)?.[1] ?? "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], nome, { type: mime });
}

export function PixSendDialog({
  open,
  onOpenChange,
  conversationId: _conversationId,
  sending,
  onSendPix,
}: Props) {
  const t = useT();
  const { data: keys, isLoading } = usePixKeys();
  const [keyId, setKeyId] = React.useState<string>("");
  const [modo, setModo] = React.useState<Modo>("chave");
  const [valor, setValor] = React.useState("");
  const [descricao, setDescricao] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setModo("chave");
    setValor("");
    setDescricao("");
    setKeyId(keys?.[0]?.id ?? "");
  }, [open, keys]);

  const chave = keys?.find((k) => k.id === keyId) ?? null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chave) {
      toast.error(t("Selecione uma chave Pix."));
      return;
    }
    setBusy(true);
    try {
      if (modo === "chave") {
        const emv = montarEmvPix({
          chave: chave.key_value,
          nome: chave.name,
        });
        const { data } = await apiClient.post<{ data: { data_url: string } }>("/api/v1/pix/qr", {
          payload: emv,
        });
        const file = dataUrlParaFile(data.data_url, `pix-chave-${chave.id}.png`);
        await onSendPix({
          qrFile: file,
          caption: formatarIntroChave({ nome: chave.name, keyType: chave.key_type }),
          copyBody: chave.key_value,
          metadata: { pix: { key_id: chave.id, mode: "chave" } },
        });
        onOpenChange(false);
        return;
      }

      const reais = Number(valor.replace(",", "."));
      if (!Number.isFinite(reais) || reais < 0.01) {
        toast.error(t("Informe um valor válido (mín. R$ 0,01)."));
        return;
      }

      const emv = montarEmvPix({
        chave: chave.key_value,
        nome: chave.name,
        valor: reais,
        txid: `DC${Date.now().toString(36).toUpperCase()}`.slice(0, 25),
      });
      const { data } = await apiClient.post<{ data: { data_url: string } }>("/api/v1/pix/qr", {
        payload: emv,
      });
      const file = dataUrlParaFile(data.data_url, `pix-cobranca-${chave.id}.png`);
      await onSendPix({
        qrFile: file,
        caption: formatarIntroCobranca({
          nome: chave.name,
          valorReais: reais,
          description: descricao || undefined,
        }),
        copyBody: emv,
        metadata: {
          pix: { key_id: chave.id, mode: "cobranca", amount_cents: Math.round(reais * 100) },
        },
      });
      onOpenChange(false);
    } catch (err) {
      showApiError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Enviar Pix")}</DialogTitle>
          <DialogDescription>
            {t(
              "Envia QR + código para copiar no celular. A bolha nativa do WhatsApp depende do canal (WAHA ainda não envia payment_info).",
            )}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("Carregando chaves…")}</p>
        ) : !keys?.length ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              {t("Nenhuma chave Pix cadastrada nesta organização.")}
            </p>
            <Button asChild variant="outline">
              <Link href="/app/templates">{t("Cadastrar em Respostas rápidas")}</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pix-send-key">{t("Chave Pix")}</Label>
              <select
                id="pix-send-key"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                required
              >
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.key_type})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>{t("Modo")}</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-sm",
                    modo === "chave"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input hover:bg-muted",
                  )}
                  onClick={() => setModo("chave")}
                >
                  {t("Enviar chave")}
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex-1 rounded-md border px-3 py-2 text-sm",
                    modo === "cobranca"
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input hover:bg-muted",
                  )}
                  onClick={() => setModo("cobranca")}
                >
                  {t("Gerar cobrança")}
                </button>
              </div>
            </div>
            {modo === "cobranca" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="pix-valor">{t("Valor (R$)")} *</Label>
                  <Input
                    id="pix-valor"
                    inputMode="decimal"
                    placeholder="0,00"
                    value={valor}
                    onChange={(e) => setValor(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pix-desc">{t("Descrição (opcional)")}</Label>
                  <Input
                    id="pix-desc"
                    value={descricao}
                    onChange={(e) => setDescricao(e.target.value)}
                    maxLength={72}
                  />
                </div>
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("Cancelar")}
              </Button>
              <Button type="submit" disabled={busy || sending}>
                {t("Enviar")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
