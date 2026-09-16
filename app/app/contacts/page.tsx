import type { Metadata } from "next";
import { ContactsListClient } from "./_client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contatos" };

export default function ContactsPage() {
  return <ContactsListClient sincronizarAdvomax={env.ADVOMAX_DEPLOYMENT_MODE} />;
}
