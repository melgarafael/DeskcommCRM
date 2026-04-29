import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import { TeamMembersClient } from "./_components/TeamMembersClient";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const isAdmin = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Equipe</h1>
          <p className="text-sm text-muted-foreground">
            Gestão de membros, roles e acesso ao tenant.
          </p>
        </div>
        {isAdmin ? (
          <Button asChild>
            <Link href="/app/team/invite">Convidar membros</Link>
          </Button>
        ) : null}
      </header>

      <TeamMembersClient currentUserId={user.id} canManage={isAdmin} />
    </div>
  );
}
