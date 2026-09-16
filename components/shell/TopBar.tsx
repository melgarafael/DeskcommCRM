"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar({ sidebarCollapsed, onToggleSidebar, togglePending }: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  togglePending: boolean;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-2 border-b border-border bg-white px-4 shadow-[0_6px_24px_rgba(7,27,51,0.04)] md:gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <button
          type="button"
          onClick={onToggleSidebar}
          disabled={togglePending}
          aria-label={sidebarCollapsed ? "Expandir menu de navegação" : "Recolher menu de navegação"}
          title={sidebarCollapsed ? "Expandir menu de navegação" : "Recolher menu de navegação"}
          className="hidden h-9 w-9 items-center justify-center rounded-md text-[#071b33] hover:bg-[#eef3f8] disabled:opacity-50 md:inline-flex"
        >
          <svg viewBox="64 64 896 896" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d="M408 442h480c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8H408c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8zm-8 204c0 4.4 3.6 8 8 8h480c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8H408c-4.4 0-8 3.6-8 8v56zm504-486H120c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8zm0 632H120c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8z" />
            <path d={sidebarCollapsed
              ? "M142.4 642.1L298.7 519a8.84 8.84 0 000-13.9L142.4 381.9c-5.8-4.6-14.4-.5-14.4 6.9v246.3a8.9 8.9 0 0014.4 7z"
              : "M115.4 518.9L271.7 642c5.8 4.6 14.4.5 14.4-6.9V388.9c0-7.4-8.5-11.5-14.4-6.9L115.4 505.1a8.74 8.74 0 000 13.8z"} />
          </svg>
        </button>
        <SearchTrigger />
        <TenantSwitcher />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
