import type { ReactNode } from "react";
import { PlatformModeBanner } from "./PlatformModeBanner";
import { AdminSidebar } from "./AdminSidebar";

interface AdminShellProps {
  userEmail: string;
  children: ReactNode;
}

/**
 * Server component shell for /admin/*. Renders the cross-tenant banner
 * (sticky top), platform sidebar, and main content area.
 */
export function AdminShell({ userEmail, children }: AdminShellProps) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      <PlatformModeBanner />
      <div className="flex flex-1">
        <AdminSidebar userEmail={userEmail} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
