"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useChannelSessions, channelLabel } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { linkDeEntrada, PADRAO_DO_CODIGO } from "@/lib/followup/gatilho-mensagem-regra";

/**
 * O link `wa.me` e o QR do gatilho «Link ou QR de entrada», um por número
 * conectado. Quem clica abre o WhatsApp com a frase + `#codigo` já escrita; ao
 * enviar, o fluxo começa. Vale igual no WAHA e na API oficial: é só texto.
 */
export function GatilhoLinkDeEntrada({ codigo, frase }: { codigo: string; frase: string }) {
  const t = useT();
  const { data: canais, isLoading } = useChannelSessions();
  const numeros = (canais ?? []).filter((c) => (c.phone_number ?? "").replace(/\D/g, "").length >= 10);
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const canal = numeros.find((c) => c.id === escolhido) ?? numeros[0] ?? null;
  const valido = PADRAO_DO_CODIGO.test(codigo);
  const link = canal && valido ? linkDeEntrada(canal.phone_number ?? "", codigo, frase) : null;

  // O QR fica preso ao link que o gerou: trocar o código não mostra o QR velho.
  const [gerado, setGerado] = useState<{ link: string; url: string } | null>(null);
  const qr = gerado && gerado.link === link ? gerado.url : null;
  const [copiado, setCopiado] = useState(false);
  useEffect(() => {
    if (!link) return;
    let vivo = true;
    void import("qrcode").then(({ default: QRCode }) =>
      QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 320 }).then((url) => {
        if (vivo) setGerado({ link, url });
      }),
    );
    return () => {
      vivo = false;
    };
  }, [link]);

  if (isLoading) return <p className="text-xs text-muted-foreground">{t("Carregando números…")}</p>;
  if (numeros.length === 0) {
    return (
      <p className="text-xs text-error-fg">
        {t("Nenhum número de WhatsApp conectado com telefone conhecido. Conecte um número para gerar o link.")}
      </p>
    );
  }
  if (!valido) return null;

  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="link-de-entrada">
      {numeros.length > 1 && (
        <select
          aria-label={t("Número do link")}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={canal?.id ?? ""}
          onChange={(e) => setEscolhido(e.target.value)}
        >
          {numeros.map((c) => (
            <option key={c.id} value={c.id}>
              {channelLabel(c, t)}
            </option>
          ))}
        </select>
      )}
      {link && (
        <>
          <p className="break-all text-xs text-text-muted" data-testid="link-de-entrada-url">
            {link}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => {
                  setCopiado(true);
                  setTimeout(() => setCopiado(false), 1500);
                });
              }}
            >
              {copiado ? t("Copiado") : t("Copiar link")}
            </Button>
            {qr && (
              <Button type="button" size="sm" variant="outline" asChild>
                <a href={qr} download={`qr-${codigo}.png`}>
                  {t("Baixar QR")}
                </a>
              </Button>
            )}
          </div>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element -- data URL gerado no navegador
            <img src={qr} alt={t("QR code do link de entrada")} className="mx-auto h-40 w-40" data-testid="link-de-entrada-qr" />
          )}
        </>
      )}
    </div>
  );
}
