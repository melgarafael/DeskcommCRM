import type { Metadata } from "next";

import { ConfiguracaoDeCampanhas } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Configuração de campanhas" };

export default function ConfiguracaoDeCampanhasPage() {
  return <ConfiguracaoDeCampanhas />;
}
