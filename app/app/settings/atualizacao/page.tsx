import { notFound } from "next/navigation";

import { exigirProvaDeMfa, loadAuthUser, mfaEmDividaEstrita } from "@/lib/auth/server";
import { UpdatePanel } from "./_components/UpdatePanel";

export const metadata = { title: "Atualização do sistema" };
export const dynamic = "force-dynamic";

/**
 * Só o dono do servidor. Um `notFound()` em vez de uma tela de "sem permissão"
 * porque, para quem não é dono, esta página simplesmente não faz parte do
 * produto.
 */
export default async function Page() {
  const user = await loadAuthUser();
  if (!user?.is_platform_admin) notFound();
  // Os botões batem em `POST /api/v1/system/update`, que exige o código provado
  // nesta sessão (`requirePlatformAdminEscrita`); quem entrou pelo dispositivo
  // confiável vai a ele antes, como em Extensões e no Servidor MCP externo.
  if (!user.support) await exigirProvaDeMfa(mfaEmDividaEstrita);
  return <UpdatePanel />;
}
