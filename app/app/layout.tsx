import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { AuthProvider } from "@/hooks/auth/AuthProvider";
import { AppShell } from "./_components/AppShell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await loadAuthUser();
  if (!user) redirect("/login");

  const activeOrg = await resolveActiveOrg(user);

  // Read sidebar collapsed state SSR to avoid flash.
  const store = await cookies();
  const collapsed = store.get("sidebar_collapsed")?.value === "1";

  return (
    <AuthProvider user={user} activeOrg={activeOrg}>
      <AppShell sidebarCollapsed={collapsed}>{children}</AppShell>
    </AuthProvider>
  );
}
