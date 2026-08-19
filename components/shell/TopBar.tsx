"use client";
import { List } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { AlertsBell } from "./AlertsBell";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur sm:gap-4 sm:px-4 lg:px-6">
      <div className="flex items-center gap-1 sm:gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // O alvo de 44px já vem do próprio `size="icon"` (ver button.tsx);
          // `lg:hidden` é a regra à parte — a partir dali o hambúrguer nem
          // renderiza, porque o menu completo volta a caber.
          className="shrink-0 lg:hidden"
          onClick={onOpenMobileNav}
          aria-label="Abrir menu de navegação"
        >
          <List size={20} aria-hidden />
        </Button>
        <TenantSwitcher />
      </div>
      <div className="flex flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
