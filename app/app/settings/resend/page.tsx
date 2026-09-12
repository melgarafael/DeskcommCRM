import { notFound } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import { getSmtpConfig } from "@/lib/email/config";
import { SmtpSettingsForm } from "./_form";

export const dynamic = "force-dynamic";
export const metadata = { title: "E-mail e convites" };

export default async function EmailSettingsPage() {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin) notFound();
  const config = await getSmtpConfig();
  return (
    <SmtpSettingsForm config={config} />
  );
}
