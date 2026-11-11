import type { Metadata } from "next";

import { DashboardComercial } from "@/components/relatorios/dashboard-comercial";
import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Relatórios comerciais" };

/**
 * RELATÓRIOS COMERCIAIS (#4280, fatia 2) — a tela de LEITURA do que já foi
 * vendido.
 *
 * ─── Por que uma tela nova, e não mais uma aba em Atividades ────────────────
 *
 * Atividades responde "o que a operação fez no período" (volume de trabalho, por
 * pessoa e por etiqueta); esta responde "quanto entrou e de quem". São perguntas
 * de donos diferentes — operação e comercial — e empilhá-las na mesma tela faria
 * a aba de Atividades carregar dois relatórios que nunca são lidos juntos.
 *
 * ─── O que ela NÃO faz ──────────────────────────────────────────────────────
 *
 * Não registra venda. A issue #4280 pede também "várias vendas no mesmo contato"
 * (o botão "+ Adicionar venda"), e essa parte mexe no MODELO de venda — decisão
 * do mantenedor, fora desta fatia. Aqui só se lê o que o Kanban já gravou.
 *
 * `viewer` de piso, como as irmãs de Análise: conferir o faturamento não é
 * privilégio de quem lança, e a RLS já recorta o que cada pessoa vê.
 */
export default async function RelatoriosComerciaisPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Relatórios comerciais")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Quanto vendemos no período, quais tags vendem mais e quais clientes estão comprando.",
          )}
        </p>
      </header>

      <DashboardComercial />
    </div>
  );
}
