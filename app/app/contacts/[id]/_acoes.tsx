"use client";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { nexusToast } from "@/components/nexus-ui/feedback/nexus-toast";

/**
 * Barra lateral "Próximas ações" do 360°: só ações reais (navegar, criar
 * tarefa de retorno via POST /api/v1/tarefas). Sem responsável inventado:
 * o campo não existe no contato — a ação cria a tarefa para quem executa.
 */
export function ProximasAcoes({
  contactId,
  nome,
  conversaId,
  anonimo,
}: {
  contactId: string;
  nome: string;
  conversaId: string | null;
  anonimo: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  async function criarRetorno() {
    setBusy(true);
    try {
      await apiClient.post<{ data: { id: string } }>("/api/v1/tarefas", {
        titulo: `Retomar ${nome}`,
        descricao: "Tarefa criada a partir da ficha 360° do cliente.",
        tipo: "retorno",
        contact_id: contactId,
      });
      nexusToast.success(t("Tarefa criada"), `${t("Retomar")} ${nome} ${t("entrou na rotina.")}`);
    } catch {
      nexusToast.error(t("Não foi possível criar a tarefa"), t("Tente novamente em instantes."));
    } finally {
      setBusy(false);
    }
  }

  if (anonimo) return null;

  return (
    <aside
      aria-label={t("Próximas ações")}
      className="space-y-2 rounded-lg border border-border bg-surface p-4 shadow-xs"
    >
      <h2 className="text-sm font-semibold text-text">{t("Próximas ações")}</h2>
      <div className="grid gap-2">
        <Button asChild variant="primary" size="sm">
          <Link href="/app/pedidos/novo">{t("Criar pedido")}</Link>
        </Button>
        {conversaId ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/app/inbox?id=${conversaId}`}>{t("Abrir conversa")}</Link>
          </Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={criarRetorno}>
          {busy ? t("Criando…") : t("Agendar retorno")}
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/app/inteligencia">{t("Ver no grafo")}</Link>
        </Button>
      </div>
    </aside>
  );
}
