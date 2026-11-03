import type { Metadata } from "next";

import { ColdCall } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cold Call" };

export default function ColdCallPage() {
  return <ColdCall />;
}
