import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { AdminShell } from "@/components/admin/AdminShell";

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requirePlatformAdmin();
  return <AdminShell userEmail={user.email ?? ""}>{children}</AdminShell>;
}
