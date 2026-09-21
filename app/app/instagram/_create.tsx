"use client";
import { randomId } from "@/lib/random-id";
import { useT } from "@/hooks/i18n/useT";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formats, type StudioItem } from "@/lib/instagram/schema";
import { StudioShell, Intro, Notice, studioApi } from "./_shared";
export function CreatePost({
  initialBrief = "",
  initialNiche = "",
}: {
  initialBrief?: string;
  initialNiche?: string;
}) {
  const t = useT();
  const router = useRouter();
  const pendingRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const [brief, setBrief] = useState(initialBrief);
  const [niche, setNiche] = useState(initialNiche);
  const [format, setFormat] = useState<keyof typeof formats>("feed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const fingerprint = JSON.stringify({ brief, niche, format });
    if (pendingRequest.current?.fingerprint !== fingerprint)
      pendingRequest.current = { fingerprint, id: randomId() };
    const id = pendingRequest.current.id;
    try {
      const item = await studioApi<StudioItem>("", {
        method: "POST",
        body: JSON.stringify({ id, kind: "post", brief, niche, format, caption: "" }),
      });
      router.push(`/app/instagram/posts/${item.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível gerar.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <StudioShell>
      <Intro eyebrow={t("Criar postagem")} title={t("O que você quer contar?")}>
        {t("Uma ideia já é um começo. Descreva do seu jeito; a imagem nasce daqui.")}
      </Intro>
      <form onSubmit={submit} className="grid items-start gap-10 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="niche" className="block text-sm font-medium">
              {t("Qual é o seu negócio?")}
            </label>
            <Input
              id="niche"
              required
              minLength={2}
              maxLength={150}
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder={t("Ex.: confeitaria artesanal")}
              disabled={busy}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="brief" className="block font-medium">
              {t("Conte sua ideia")}
            </label>
            <Textarea
              id="brief"
              required
              minLength={10}
              maxLength={3000}
              rows={6}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={t(
                "Quero mostrar meu bolo de chocolate e convidar as pessoas para encomendar no fim de semana. Cores quentes, estilo artesanal…",
              )}
              disabled={busy}
              className="rounded-3xl p-5 text-base"
            />
          </div>
          <fieldset disabled={busy} className="space-y-3">
            <legend className="block text-sm font-medium">
              {t("Onde essa ideia vai aparecer?")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(formats).map(([key, f]) => (
                <label
                  key={key}
                  className={`inline-flex cursor-pointer items-center rounded-2xl border px-4 py-3 ${format === key ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  <input
                    type="radio"
                    name="format"
                    value={key}
                    checked={format === key}
                    onChange={() => setFormat(key as keyof typeof formats)}
                    className="mr-2 accent-current"
                  />
                  {t(f.label)}
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <Notice error>
              {error}{" "}
              <a href="/app/instagram/library" className="underline">
                {t("Abrir minhas criações")}
              </a>
            </Notice>
          )}
          <Button size="lg" disabled={busy} type="submit">
            {busy ? t("Criando sua imagem…") : t("Gerar minha imagem")}
          </Button>
          {busy ? (
            <Notice>
              {t(
                "A imagem pode levar alguns minutos. Seu pedido já fica na biblioteca. Você não precisa enviar novamente.",
              )}
            </Notice>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                "GPT Image 2.5 · A imagem fica salva para você revisar e baixar. Nada é publicado automaticamente.",
              )}
            </p>
          )}
        </div>
        <aside className="rounded-[2rem] border border-border bg-muted/30 p-7">
          <div
            style={{ aspectRatio: formats[format].ratio }}
            className="flex items-center justify-center rounded-2xl border border-dashed border-border bg-background p-7 text-center"
          >
            <div>
              <p className="font-serif text-3xl">
                {t("Aqui nasce")}
                <br />
                {t("sua próxima ideia.")}
              </p>
              <p className="mt-4 text-sm text-muted-foreground">{t(formats[format].label)}</p>
            </div>
          </div>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            {t("Dica: conte o que quer mostrar, para quem e qual sensação a imagem deve passar.")}
          </p>
        </aside>
      </form>
    </StudioShell>
  );
}
