"use client";
import Link from "next/link";
import { Buildings } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * Sticky top banner that signals the user is operating in cross-tenant
 * Platform mode. Persistent visual cue to prevent accidental destructive
 * actions when the operator forgets which surface they're in.
 */
export function PlatformModeBanner() {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t("Modo Plataforma")}
      className="sticky top-0 z-40 flex h-10 w-full items-center justify-between border-b border-[#6d28d9] bg-[#050208] px-4 text-white shadow-[0_4px_16px_-4px_rgba(109,40,217,0.55)]"
    >
      <div className="flex items-center gap-2 text-sm">
        <Buildings size={18} weight="fill" aria-hidden />
        <span className="font-semibold tracking-tight">{t("MODO PLATAFORMA")}</span>
        <span className="hidden text-white/70 sm:inline">{t("— operação cross-tenant")}</span>
      </div>
      <Link
        href="/app"
        className="rounded-md px-2 py-1 text-xs font-medium underline-offset-2 hover:underline"
      >
        {t("Sair pra app pessoal")}
      </Link>
    </div>
  );
}
