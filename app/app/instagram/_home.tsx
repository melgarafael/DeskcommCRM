"use client";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";
import { StudioShell, Intro, Gallery, Loading, Notice, useItems } from "./_shared";
export function InstagramHome() {
  const t = useT();
  const { items, loading, error, canCreate, reload } = useItems();
  const posts = items.filter((i) => i.kind === "post");
  return (
    <StudioShell>
      <section className="grid items-center gap-10 py-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-7">
          <Intro
            eyebrow={t("Da sua ideia para o mundo")}
            title={t("Seu negócio tem muito para contar.")}
          >
            {t("Transforme uma ideia em uma postagem com a sua cara. Escreve aí.")}
          </Intro>
          <Button asChild size="lg">
            <Link href="/app/instagram/new">{t("Criar minha postagem")}</Link>
          </Button>
          <p className="text-sm text-muted-foreground">
            {t("Você descreve. A IA desenha. Você revisa.")}
          </p>
        </div>
        <div
          aria-hidden="true"
          className="relative mx-auto flex aspect-square w-full max-w-sm items-center justify-center rounded-[3rem] bg-muted/40"
        >
          <div className="absolute inset-10 rotate-[-7deg] rounded-[2rem] border border-border bg-background shadow-sm" />
          <div className="relative flex h-64 w-52 rotate-[6deg] flex-col justify-between rounded-[2rem] border border-border bg-primary p-7 text-primary-foreground">
            <ArtisanIcon symbol="instagram" className="h-10 w-10" />
            <span className="font-serif text-4xl leading-tight">
              {t("Uma ideia.")}
              <br />
              {t("Seu jeito.")}
            </span>
            <span className="text-xs">{t("crie · revise · compartilhe")}</span>
          </div>
        </div>
      </section>
      <div className="grid gap-6 border-y border-border py-8 sm:grid-cols-2">
        <Link
          href="/app/instagram/inspirations"
          className="space-y-2 rounded-xl p-2 focus-visible:outline-2"
        >
          <h2 className="font-serif text-2xl">{t("Sem ideia do que postar? ↗")}</h2>
          <p className="text-muted-foreground">
            {t("Explore referências e encontre um assunto para o seu nicho.")}
          </p>
        </Link>
        <Link
          href="/app/instagram/insights"
          className="space-y-2 rounded-xl p-2 focus-visible:outline-2"
        >
          <h2 className="font-serif text-2xl">{t("Entenda o que funcionou ↗")}</h2>
          <p className="text-muted-foreground">
            {t("Veja o alcance e as interações da sua conta conectada.")}
          </p>
        </Link>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <Notice error>
          {error}{" "}
          <button onClick={() => void reload()} className="underline">
            {t("Tentar novamente")}
          </button>
        </Notice>
      ) : posts.length > 0 ? (
        <section className="space-y-5">
          <div className="flex justify-between gap-4">
            <h2 className="font-serif text-2xl">{t("Suas últimas ideias")}</h2>
            <Link className="underline" href="/app/instagram/library">
              {t("Ver todas")}
            </Link>
          </div>
          <Gallery items={posts.slice(0, 3)} />
        </section>
      ) : (
        <p className="text-muted-foreground">
          {canCreate
            ? t("Sua primeira criação vai aparecer aqui.")
            : t(
                "Você pode acompanhar as criações da sua equipe. Para criar, peça acesso de edição.",
              )}
        </p>
      )}
    </StudioShell>
  );
}
