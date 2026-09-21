"use client";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { copyToClipboard } from "@/lib/clipboard";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { StudioItem } from "@/lib/instagram/schema";
import { StudioShell, Intro, Loading, Notice, studioApi } from "./_shared";
export function Review({ id }: { id: string }) {
  const t = useT();
  const [item, setItem] = useState<StudioItem | null>(null);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await studioApi<StudioItem>(`/${id}`);
        if (!active) return;
        setItem(value);
        setCaption(value.caption);
        if (value.status === "generating") timer = setTimeout(() => void read(), 5000);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Não foi possível abrir.");
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id]);
  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await studioApi(`/${id}`, { method: "PATCH", body: JSON.stringify({ caption }) });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "A legenda não foi salva.");
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    if (!item?.image_url) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(item.image_url);
      if (!r.ok)
        throw new Error("O link da imagem expirou. Atualize esta página e tente novamente.");
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `postagem-${id}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível baixar.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <StudioShell>
      <Intro eyebrow={t("Revisar postagem")} title={t("Agora, deixe com a sua cara.")}>
        {t("Confira a imagem, ajuste a legenda e leve sua ideia para o Instagram.")}
      </Intro>
      {error && <Notice error>{error}</Notice>}
      {!item && !error ? (
        <Loading />
      ) : item && item.input.kind === "post" ? (
        <div className="grid gap-9 lg:grid-cols-2">
          <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-3xl border border-border bg-muted/30">
            {item.image_url ? (
              <Image
                unoptimized
                width={1024}
                height={1280}
                src={item.image_url}
                alt={item.input.brief}
                className="max-h-[650px] w-full object-contain"
              />
            ) : (
              <Notice error={item.status === "failed"}>
                {item.error ||
                  (item.status === "generating"
                    ? t("Sua imagem está sendo criada. Você pode voltar pela biblioteca.")
                    : t(
                        "Não foi possível abrir a imagem. Atualize a página para renovar o acesso.",
                      ))}
              </Notice>
            )}
          </div>
          <div className="space-y-5">
            <div>
              <p className="text-sm text-muted-foreground">{t("Sua ideia")}</p>
              <p className="mt-2 whitespace-pre-wrap">{item.input.brief}</p>
            </div>
            <label htmlFor="caption" className="block font-medium">
              {t("Legenda da postagem")}
            </label>
            <Textarea
              id="caption"
              rows={9}
              maxLength={2200}
              value={caption}
              disabled={busy || !item.can_edit}
              onChange={(e) => {
                setCaption(e.target.value);
                setSaved(false);
              }}
              placeholder={t("Escreva o convite para quem vai ver sua postagem…")}
            />
            <p className="text-sm text-muted-foreground">
              {caption.length}
              {t("/2.200 caracteres")}
            </p>
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => void save()} disabled={busy || !item.can_edit}>
                {t("Salvar legenda")}
              </Button>
              <Button
                variant="outline"
                onClick={() => void download()}
                disabled={busy || !item.image_url}
              >
                {t("Baixar imagem")}
              </Button>
              <Button
                variant="ghost"
                disabled={!caption}
                onClick={() =>
                  void copyToClipboard(caption)
                    .then((ok) => {
                      if (ok) setCopied(true);
                      else
                        setError(
                          "Não foi possível copiar. Selecione a legenda e copie manualmente.",
                        );
                    })
                    .catch(() =>
                      setError("Não foi possível copiar. Selecione a legenda e copie manualmente."),
                    )
                }
              >
                {t("Copiar legenda")}
              </Button>
            </div>
            {saved && <Notice>{t("Legenda salva com sucesso.")}</Notice>}
            {copied && <Notice>{t("Legenda copiada.")}</Notice>}
            <Link
              className="block text-sm underline"
              href={`/app/instagram/new?brief=${encodeURIComponent(item.input.brief)}&niche=${encodeURIComponent(item.input.niche)}`}
            >
              {t("Criar outra versão")}
            </Link>
            <p className="text-sm text-muted-foreground">
              {t("Baixar ou salvar não publica a postagem. Você escolhe quando compartilhar.")}
            </p>
          </div>
        </div>
      ) : null}
    </StudioShell>
  );
}
