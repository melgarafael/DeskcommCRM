import { requireAuth } from "@/lib/auth/server";
import { WorkspaceHome } from "./_components/WorkspaceHome";
export const dynamic = "force-dynamic";
export default async function AppHome() {
  await requireAuth();
  return <WorkspaceHome />;
}
