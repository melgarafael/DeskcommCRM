"use client";
import Link from "next/link";
import { Buildings } from "@/lib/ui/icons";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { useT } from "@/hooks/i18n/useT";

/**
 * Sticky top banner that signals the user is operating in cross-tenant
 * Platform mode. Persistent visual cue to prevent accidental destructive
 * actions when the operator forgets which surface they're in.
 *
 * ── Por que a troca de tema mora AQUI ────────────────────────────────────────
 *
 * O `AdminShell` não tem barra de topo no desktop — o único `<header>` dele é
 * `lg:hidden`. Esta tarja é o único elemento persistente do topo em TODAS as
 * larguras, então é o único lugar onde um controle global cabe sem inventar
 * uma barra nova (o que mudaria o layout de todas as telas do admin).
 *
 * ── Por que as cores são token e não `amber-*` ───────────────────────────────
 *
 * A versão anterior usava `bg-amber-100 border-amber-300 text-amber-900`, cru
 * do Tailwind e portanto FIXO: a tarja não acompanhava claro e escuro, e num
 * tema escuro ela virava uma faixa clara gritando no topo. Os tokens de
 * `warning` são os mesmos que o `Badge variant="warning"` usa, e existem nos
 * dois temas com contraste aferido.
 *
 * O `--color-warning-bg` é translúcido (12% em claro, 18% em escuro), e esta
 * tarja é `sticky` — conteúdo rolando por baixo apareceria através dela. Por
 * isso são DOIS elementos: o de fora dá o fundo opaco da página, o de dentro
 * dá o tom de aviso por cima. Sem `backdrop-blur`, que é anti-pattern nº 5.
 */
export function PlatformModeBanner() {
  const t = useT();
  return (
    <div role="region" aria-label={t("Modo Plataforma")} className="sticky top-0 z-40 w-full bg-bg">
      <div className="flex h-10 w-full items-center justify-between border-b border-warning/35 bg-warning-bg px-4 text-warning-fg">
        <div className="flex items-center gap-2 text-sm">
          <Buildings size={18} weight="fill" aria-hidden />
          <span className="font-semibold tracking-tight">{t("MODO PLATAFORMA")}</span>
          <span className="hidden opacity-80 sm:inline">{t("— operação cross-tenant")}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* 40px de tarja não comportam os 44px de alvo de toque do `size="icon"`.
              O mesmo já valia para o link ao lado, que é `text-xs`: quem opera o
              modo plataforma está num desktop, com cursor. */}
          <ThemeToggle className="h-7 w-7 text-warning-fg lg:h-7 lg:w-7" />
          <Link
            href="/app"
            className="rounded-md px-2 py-1 text-xs font-medium underline-offset-2 hover:underline"
          >
            {t("Sair pra app pessoal")}
          </Link>
        </div>
      </div>
    </div>
  );
}
