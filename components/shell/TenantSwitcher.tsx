"use client";
import Link from "next/link";
import { useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useOrganizationTransition } from "./OrganizationTransitionProvider";
import { CaretDown, Storefront } from "@/lib/ui/icons";
import { useUser, useActiveOrg } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";

export function TenantSwitcher() {
  const t = useT();
  const user = useUser();
  const active = useActiveOrg();
  const transition = useOrganizationTransition();
  const [isPending, setPending] = useState(false);
  const switchTo = async (orgId: string) => {
    if (orgId === active?.orgId) return;
    flushSync(() => { setPending(true); transition.begin(t("Carregando organização…")); });
    try {
      const result = await setActiveOrg(orgId);
      if (!result.ok) throw new Error(result.error);
      // Novo documento elimina QueryClient, subscriptions e respostas em voo.
      window.location.assign("/app/inbox");
    } catch {
      transition.cancel();
      setPending(false);
      toast.error(t("Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente."));
    }
  };

  if (user.organizations.length <= 1 && !user.is_platform_admin) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={isPending || !!user.support} className="gap-2" title={user.support ? "Saia do acompanhamento para trocar de organização" : undefined} data-testid="tenant-switcher">
          <Storefront size={16} weight="duotone" aria-hidden />
          <span className="max-w-[160px] truncate">{active?.name ?? "Selecionar org"}</span>
          <CaretDown size={12} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {user.organizations.map((org) => (
          <DropdownMenuItem
            key={org.organization_id}
            data-testid={`tenant-switcher-item-${org.organization_id}`}
            onClick={() => { void switchTo(org.organization_id); }}
            className="flex items-center justify-between"
          >
            <span className="truncate">{org.organization_name}</span>
            {active?.orgId === org.organization_id && <span className="text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
        {user.is_platform_admin && <DropdownMenuItem asChild>
          <Link href="/admin/tenants">{t("Gerenciar organizações")}</Link>
        </DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
