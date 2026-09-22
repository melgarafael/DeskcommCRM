import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { InteligenciaClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function InteligenciaPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <InteligenciaClient />
    </div>
  );
}
