"use client";
import { useSearchParams, useRouter } from "next/navigation";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useEffect } from "react";
import { DetalheDoCompromisso } from "./DetalheDoCompromisso";
export function EntradaDaAgenda({
  onContext,
}: {
  onContext: (contact: string, conversation: string) => void;
}) {
  const podeEditar = usePermission("inbox.reply");
  const params = useSearchParams();
  const router = useRouter();
  const contact = params.get("contato");
  const conversation = params.get("conversa");
  useEffect(() => {
    if (contact) onContext(contact, conversation ?? "");
  }, [contact, conversation, onContext]);
  return (
    <DetalheDoCompromisso
      key={params.get("compromisso")}
      podeEditar={podeEditar}
      id={params.get("compromisso")}
      onClose={() => router.replace("/app/agenda")}
    />
  );
}
