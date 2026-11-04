import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { DashboardClient } from "./_client";

export const metadata = { title: "Dashboard — Admin Plataforma" };

export default async function AdminDashboardPage() {
  const { user } = await requirePlatformAdmin();
  return <DashboardClient actorId={user.id} />;
}
