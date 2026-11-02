"use client";
import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

/**
 * Filtro "por atendente" do Inbox (gerente para cima). Mora num componente
 * próprio de propósito: a lista de membros é uma consulta, e só quem pode usar o
 * filtro deve pagar por ela — `InboxFilters` o desenha apenas para gerente.
 */
export function SeletorDeAtendente(props: {
  value: string | undefined;
  onChange: (atendente: string | undefined) => void;
}) {
  // Sem o provedor de consultas (telas montadas isoladas) não há de onde ler a
  // equipe: o seletor simplesmente não aparece, em vez de derrubar a tela.
  const temProvedor = useContext(QueryClientContext) !== undefined;
  return temProvedor ? <SeletorComEquipe {...props} /> : null;
}

function SeletorComEquipe({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (atendente: string | undefined) => void;
}) {
  const t = useT();
  const { data } = useAssignableMembers(true);
  // A resposta pode vir vazia ou malformada: o seletor degrada para "só Todos".
  const membros = Array.isArray(data) ? data : [];
  const foraDaLista = value != null && !membros.some((m) => m.user_id === value);

  return (
    <Select value={value ?? "all"} onValueChange={(v) => onChange(v === "all" ? undefined : v)}>
      <SelectTrigger
        className={cn(
          "h-8 min-w-0 flex-1 rounded-full border-transparent bg-surface-elevated px-3 text-xs shadow-none",
          value != null && "border-accent bg-accent-soft text-accent",
        )}
        aria-label={t("Filtrar por atendente")}
      >
        <SelectValue placeholder={t("Todos os atendentes")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t("Todos os atendentes")}</SelectItem>
        {foraDaLista && value != null && (
          <SelectItem value={value}>{t("Atendente removido")}</SelectItem>
        )}
        {membros.map((m) => (
          <SelectItem key={m.user_id} value={m.user_id}>
            {rotuloDoMembro(m, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
