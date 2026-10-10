import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A comanda é MÓDULO DE TABELA do ADR-0002 (D2/D3): as cinco tabelas nascem em
 * `fn_financeiro_provisionar()` e só existem onde `modulos_instalados` tem a
 * linha `financeiro` ativa (#1907, item 4). Desinstalado, esta tela não existe
 * para ninguém — é o mesmo desenho de `/app/companies` (crm_b2b) e de
 * `/app/ai/atendimento` (fluxos_atendimento): a porta some, não abre vazia.
 *
 * Quem instala é quem administra a instalação, em `/admin/modulos`, com a linha
 * do catálogo que o #1907 acrescentou (`lib/modulos/catalogo.ts`).
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "financeiro"))) notFound();
  return children;
}
