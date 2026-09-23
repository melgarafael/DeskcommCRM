"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { searchable } from "@/lib/navigation/registry";
import { destinationForPath, JOURNEYS } from "@/lib/navigation/journeys";
import { ArtisanIcon } from "@/components/brand/ArtisanIcon";

export function JourneyGuide() {
  const pathname = usePathname();
  const t = useT();
  const { user, activeOrg } = useAuth();
  const destinations = searchable(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  );
  const destination = destinationForPath(pathname, destinations);
  if (!destination || pathname === "/app") return null;
  const journey = JOURNEYS[destination.group];
  const steps = journey.steps.flatMap((href) => destinations.filter((d) => d.href === href));
  return (
    <div className="journey-guide mb-5 flex flex-wrap items-start justify-between gap-3 px-1">
      <nav
        aria-label={t("Você está aqui")}
        className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground"
      >
        <Link href="/app" className="rounded-md px-1 py-2 hover:text-foreground">
          {t("Seu espaço")}
        </Link>
        <span aria-hidden>/</span>
        {pathname === destination.href ? (
          <span aria-current="page">{t(destination.label)}</span>
        ) : (
          <>
            <Link href={destination.href} className="rounded-md px-1 py-2 hover:text-foreground">
              {t(destination.label)}
            </Link>
            <span aria-hidden>/</span>
            <span>{t(pathname.endsWith("/new") ? "Criar" : "Detalhes")}</span>
          </>
        )}
      </nav>
      <details key={pathname} className="journey-help group max-w-full sm:max-w-md">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-end gap-2 rounded-full px-3 text-xs text-muted-foreground hover:bg-surface-elevated focus-visible:outline-2 focus-visible:outline-accent">
          <ArtisanIcon symbol="spark" className="h-4 w-4" />
          {t("Como seguir por aqui")}
        </summary>
        <div className="mt-3 rounded-2xl border bg-card p-5 shadow-sm">
          <p className="text-sm font-medium">{t(journey.title)}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t(destination.description)}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">{t(journey.description)}</p>
          <ol className="mt-4 space-y-1">
            {steps.map((step, i) => (
              <li key={step.href}>
                <Link
                  href={step.href}
                  aria-current={step.href === destination.href ? "step" : undefined}
                  className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm hover:bg-muted aria-[current=step]:bg-muted"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs">
                    {i + 1}
                  </span>
                  {t(step.label)}
                  <span className="ml-auto" aria-hidden>
                    ↗
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </details>
    </div>
  );
}
