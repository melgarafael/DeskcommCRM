"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/auth/AuthProvider";
import Image from "next/image";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";
import { Button } from "@/components/ui/button";
import type { StudioItem } from "@/lib/instagram/schema";

export async function studioApi<T>(path = "", init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1/instagram${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(json?.error?.message || "Não foi possível concluir. Tente novamente.");
  return json.data;
}
export function useItems() {
  const { activeOrg } = useAuth();
  const query = useQuery({
    queryKey: ["instagram-studio", activeOrg?.orgId],
    queryFn: ({ signal }) =>
      studioApi<{ items: StudioItem[]; can_create: boolean }>("", { signal }),
    refetchInterval: (q) =>
      q.state.data?.items.some((i) => i.status === "generating") ? 5000 : false,
  });
  return {
    items: query.data?.items ?? [],
    loading: query.isPending,
    error: query.error?.message ?? "",
    canCreate: query.data?.can_create ?? false,
    reload: async () => {
      await query.refetch();
    },
  };
}
const sections = [
  { href: "/app/instagram", label: "Seu Instagram" },
  { href: "/app/instagram/library", label: "Minhas criações" },
  { href: "/app/instagram/inspirations", label: "Inspirações" },
  { href: "/app/instagram/insights", label: "Meus resultados" },
];
export function StudioShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  const path = usePathname();
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/app/instagram"
          className="inline-flex items-center gap-3 text-lg font-semibold"
        >
          <ArtisanIcon symbol="instagram" className="h-7 w-7" />
          {t("Instagram")}
        </Link>
        <Link href="/app/connections?aba=sociais" className="text-sm underline underline-offset-4">
          {t("Conectar minha conta")}
        </Link>
      </div>
      <nav
        aria-label={t("Instagram")}
        className="flex gap-2 overflow-x-auto border-b border-border pb-3"
      >
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            aria-current={path === s.href ? "page" : undefined}
            className={`shrink-0 rounded-full px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 ${path === s.href ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            {t(s.label)}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
export function Intro({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <header className="max-w-2xl space-y-3">
      {eyebrow && <p className="text-sm text-muted-foreground">{t(eyebrow)}</p>}
      <h1 className="font-serif text-3xl tracking-tight sm:text-5xl">{t(title)}</h1>
      {children && (
        <div className="text-base leading-relaxed text-muted-foreground">{children}</div>
      )}
    </header>
  );
}
export function Notice({ error, children }: { error?: boolean; children: React.ReactNode }) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`rounded-2xl border p-4 text-sm leading-relaxed ${error ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40"}`}
    >
      {children}
    </div>
  );
}
export function Loading() {
  const t = useT();
  return (
    <p role="status" className="py-12 text-muted-foreground">
      {t("Preparando seu espaço…")}
    </p>
  );
}
export function Empty({
  title,
  children,
  href,
  label,
}: {
  title: string;
  children: React.ReactNode;
  href: string;
  label: string;
}) {
  const t = useT();
  return (
    <div className="rounded-3xl border border-dashed border-border p-8 sm:p-12">
      <h2 className="font-serif text-2xl">{t(title)}</h2>
      <p className="mt-3 max-w-lg text-muted-foreground">{children}</p>
      <Button asChild className="mt-6">
        <Link href={href}>{t(label)}</Link>
      </Button>
    </div>
  );
}
export function Gallery({ items }: { items: StudioItem[] }) {
  const locale = useTagDeIdioma();
  const t = useT();
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <Link
          href={`/app/instagram/posts/${item.id}`}
          key={item.id}
          className="group min-w-0 space-y-3 rounded-3xl focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          <div className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-3xl border border-border bg-muted/40">
            {item.image_url ? (
              <Image
                unoptimized
                width={1024}
                height={1280}
                src={item.image_url}
                alt={item.input.kind === "post" ? item.input.brief : "Criação"}
                className="h-full w-full object-contain"
              />
            ) : (
              <div className="px-6 text-center">
                <ArtisanIcon symbol="instagram" className="mx-auto mb-4 h-12 w-12" />
                <p>
                  {item.status === "generating"
                    ? t("Sua imagem está sendo criada…")
                    : item.status === "failed"
                      ? t("Pedido preservado")
                      : t("Imagem temporariamente indisponível")}
                </p>
              </div>
            )}
          </div>
          <h2 className="line-clamp-2 font-medium">
            {item.input.kind === "post" ? item.input.brief : t("Criação")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {item.status === "ready"
              ? t("Pronta para revisar")
              : item.status === "failed"
                ? t("Precisa de atenção")
                : t("Em andamento")}{" "}
            · {new Date(item.created_at).toLocaleDateString(locale)}
          </p>
        </Link>
      ))}
    </div>
  );
}
