import Link from "next/link";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TeamMembersClient } from "./_components/TeamMembersClient";
import { AttendantsClient } from "./_components/AttendantsClient";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const isAdmin = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const isManager = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Equipe</h1>
          <p className="text-sm text-muted-foreground">
            Gestão de membros, roles e atendimento do tenant.
          </p>
        </div>
        {isAdmin ? (
          <Button asChild>
            <Link href="/app/team/invite">Convidar membros</Link>
          </Button>
        ) : null}
      </header>

      <Tabs defaultValue="members" className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="members">Membros</TabsTrigger>
          <TabsTrigger value="attendants">Atendimento</TabsTrigger>
        </TabsList>
        <TabsContent value="members" className="mt-4">
          <TeamMembersClient currentUserId={user.id} canManage={isAdmin} />
        </TabsContent>
        <TabsContent value="attendants" className="mt-4">
          {isManager ? (
            <AttendantsClient canManage={isManager} />
          ) : (
            <p className="text-sm text-muted-foreground">
              A gestão de atendimento está disponível para gerentes e administradores.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
