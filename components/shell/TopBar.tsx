"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-2 bg-background/80 px-3 backdrop-blur-xl md:gap-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <TenantSwitcher />
      </div>
      <div className="flex min-w-0 flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
