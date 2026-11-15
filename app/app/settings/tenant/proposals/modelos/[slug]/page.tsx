import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { EditorDeModelo } from "./_client";

export const metadata = { title: "Modelo de proposta" };

export default async function EditorDeModeloPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const { slug } = await params;
  return (
    <>
      <div className="mx-auto w-full max-w-5xl px-6 pt-6">
        <CabecalhoDaSubTela idioma={user.idioma} />
      </div>
      <EditorDeModelo slug={slug} />
    </>
  );
}
