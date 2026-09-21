import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { companyContext } from "@/lib/instagram/brand";
import { CreatePost } from "../_create";
export const metadata = { title: "Criar postagem" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || org.role === "viewer") redirect("/app/instagram");
  const q = await searchParams;
  const company = await companyContext(org.orgId);
  return (
    <CreatePost
      company={company}
      initialBrief={typeof q.brief === "string" ? q.brief.slice(0, 3000) : ""}
      initialNiche={typeof q.niche === "string" ? q.niche.slice(0, 2000) : company.description}
    />
  );
}
