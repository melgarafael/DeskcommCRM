"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { randomId } from "@/lib/random-id";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { referenceSchema, type StudioItem } from "@/lib/instagram/schema";
import { StudioShell, Intro, Notice, Loading, useItems, studioApi } from "./_shared";
export function Inspirations() {
  const t = useT();
  const locale = useTagDeIdioma();
  const { items, loading, error: loadError, reload, canCreate } = useItems();
  const [username, setUsername] = useState("");
  const [niche, setNiche] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<StudioItem | null>(null);
  const pendingSearch = useRef<{ fingerprint: string; id: string } | null>(null);
  const refs = items.filter((i) => i.kind === "reference");
  const researches = items.filter((i) => i.kind === "research");
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const p = referenceSchema.safeParse(username);
    if (!p.success) {
      setError("Informe apenas o @ do perfil, sem espaços ou links.");
      return;
    }
    if (
      refs.some(
        (r) =>
          r.input.kind === "reference" && r.input.username.toLowerCase() === p.data.toLowerCase(),
      )
    ) {
      setError("Esse perfil já está nas suas referências.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await studioApi("", {
        method: "POST",
        body: JSON.stringify({ id: randomId(), kind: "reference", username: p.data }),
      });
      setUsername("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }
  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const request = {
      kind: "research",
      niche,
      brief,
      references: refs
        .flatMap((r) => (r.input.kind === "reference" ? [r.input.username] : []))
        .slice(0, 10),
    };
    const fingerprint = JSON.stringify(request);
    if (pendingSearch.current?.fingerprint !== fingerprint)
      pendingSearch.current = { fingerprint, id: randomId() };
    try {
      const value = await studioApi<StudioItem>("", {
        method: "POST",
        body: JSON.stringify({ ...request, id: pendingSearch.current.id }),
      });
      setResult(value);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível pesquisar.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await studioApi(`/${id}`, { method: "DELETE" });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível remover.");
    } finally {
      setBusy(false);
    }
  }
  const selected =
    (result && researches.find((i) => i.id === result.id)) ??
    result ??
    researches.find((i) => i.status === "ready");
  return (
    <StudioShell>
      <Intro eyebrow={t("Inspirações")} title={t("Uma boa referência vira uma ideia sua.")}>
        {t(
          "Explore assuntos do seu nicho e perfis que você admira. A pesquisa procura fontes públicas; adicionar um perfil não segue nem envia mensagens a ele.",
        )}
      </Intro>
      <div className="grid items-start gap-10 lg:grid-cols-[1.4fr_1fr]">
        <form onSubmit={search} className="space-y-5">
          <label htmlFor="research-niche" className="block font-medium">
            {t("Qual é o seu nicho?")}
          </label>
          <Input
            id="research-niche"
            required
            minLength={2}
            maxLength={150}
            placeholder={t("Ex.: estética, imobiliária, confeitaria…")}
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
            disabled={busy || !canCreate}
          />
          <label htmlFor="research-brief" className="block font-medium">
            {t("Sobre o que você quer encontrar ideias?")}
          </label>
          <Textarea
            id="research-brief"
            required
            minLength={3}
            maxLength={1000}
            rows={4}
            placeholder={t("Ex.: ideias recentes para mostrar bastidores e atrair encomendas")}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={busy || !canCreate}
          />
          <Button type="submit" disabled={busy || !canCreate}>
            {busy ? t("Preparando…") : t("Buscar inspirações")}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t(
              "As sugestões mostram as fontes. Popularidade só é afirmada quando houver evidência.",
            )}
          </p>
        </form>
        <aside className="rounded-3xl border border-border p-6">
          <h2 className="font-serif text-2xl">{t("Quem inspira você?")}</h2>
          <p className="my-3 text-sm text-muted-foreground">
            {t("Guarde até 10 perfis para orientar suas pesquisas.")}
          </p>
          <form onSubmit={add} className="flex gap-2">
            <label htmlFor="reference" className="sr-only">
              {t("Perfil de referência")}
            </label>
            <Input
              id="reference"
              placeholder={t("@perfil")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy || !canCreate || refs.length >= 10}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={busy || !canCreate || refs.length >= 10}
            >
              {t("Adicionar")}
            </Button>
          </form>
          {loading ? (
            <Loading />
          ) : (
            <ul className="mt-5 space-y-3">
              {refs.map(
                (r) =>
                  r.input.kind === "reference" && (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <a
                        className="min-w-0 truncate underline"
                        href={`https://www.instagram.com/${r.input.username}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        @{r.input.username}
                      </a>
                      {canCreate && (
                        <button
                          aria-label={`Remover @${r.input.username}`}
                          className="p-2 text-sm underline"
                          disabled={busy}
                          onClick={() => void remove(r.id)}
                        >
                          {t("Remover")}
                        </button>
                      )}
                    </li>
                  ),
              )}
            </ul>
          )}
        </aside>
      </div>
      {(error || loadError) && <Notice error>{error || loadError}</Notice>}
      {busy && (
        <Notice>
          {t("A pesquisa pode levar alguns minutos. Ela ficará guardada aqui quando terminar.")}
        </Notice>
      )}
      {selected?.status === "failed" && <Notice error>{selected.error}</Notice>}
      {selected?.status === "ready" && selected.input.kind === "research" && (
        <section className="space-y-6 border-t border-border pt-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 className="font-serif text-3xl">
              {t("Ideias para")}
              {selected.input.niche}
            </h2>
            <span className="text-sm text-muted-foreground">
              {t("Pesquisado em")}
              {new Date(selected.created_at).toLocaleString(locale)}
            </span>
          </div>
          <div className="space-y-4 leading-relaxed">
            {selected.answer.split(/\n\s*\n/).map((paragraph, i) => (
              <p key={i} className="break-words whitespace-pre-wrap">
                {paragraph
                  .replace(/^#{1,6}\s+/gm, "")
                  .replace(/\*\*(.*?)\*\*/g, "$1")
                  .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")}
              </p>
            ))}
          </div>
          <div>
            <h3 className="mb-3 font-medium">{t("Confira as fontes")}</h3>
            <ul className="space-y-2">
              {selected.sources.map((s) => (
                <li key={s.url}>
                  <a
                    className="break-words underline underline-offset-4"
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {s.title} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <Button asChild>
            <Link
              href={`/app/instagram/new?niche=${encodeURIComponent(selected.input.niche)}&brief=${encodeURIComponent(selected.answer.slice(0, 2500))}`}
            >
              {t("Adaptar para meu negócio")}
            </Link>
          </Button>
        </section>
      )}
      {researches.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-serif text-2xl">{t("Pesquisas anteriores")}</h2>
          {researches.map((r) => (
            <button
              key={r.id}
              onClick={() => setResult(r)}
              className="block w-full rounded-xl border border-border p-4 text-left"
            >
              {r.input.kind === "research" ? r.input.brief : t("Pesquisa")}{" "}
              <span className="text-sm text-muted-foreground">
                ·{" "}
                {r.status === "ready"
                  ? t("Abrir")
                  : r.status === "failed"
                    ? r.error
                    : t("Em andamento")}
              </span>
            </button>
          ))}
        </section>
      )}
    </StudioShell>
  );
}
