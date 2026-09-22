"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  return (
    <>
      {/* `shrink-0`: a casca agora tem altura fixa (`h-screen`) e o `main`
          rola por dentro — sem isso a barra seria espremida quando o espaço
          aperta. O `sticky` fica como segunda rede nas páginas que ainda rolam
          no body (banners acima da casca). */}
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur md:gap-4 md:px-6 print:hidden">
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
    </>
  );
}
