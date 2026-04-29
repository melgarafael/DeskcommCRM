import Link from "next/link";
import { Buildings } from "@/lib/ui/icons";

/**
 * Sticky top banner that signals the user is operating in cross-tenant
 * Platform mode. Persistent visual cue to prevent accidental destructive
 * actions when the operator forgets which surface they're in.
 */
export function PlatformModeBanner() {
  return (
    <div
      role="region"
      aria-label="Modo Plataforma"
      className="sticky top-0 z-40 flex h-10 w-full items-center justify-between border-b border-amber-300 bg-amber-100 px-4 text-amber-900"
    >
      <div className="flex items-center gap-2 text-sm">
        <Buildings size={18} weight="fill" aria-hidden />
        <span className="font-semibold tracking-tight">MODO PLATAFORMA</span>
        <span className="hidden text-amber-800/80 sm:inline">— operação cross-tenant</span>
      </div>
      <Link
        href="/app"
        className="rounded-md px-2 py-1 text-xs font-medium underline-offset-2 hover:underline"
      >
        Sair pra app pessoal
      </Link>
    </div>
  );
}
