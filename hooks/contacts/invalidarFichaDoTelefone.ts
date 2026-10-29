"use client";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Depois de mexer nos telefones de uma ficha, relê tudo que mostra esse número:
 * a própria ficha, a lista de contatos, a caixa de entrada (o painel do contato
 * lê por ali) e a linha "A resposta sai por" do cabeçalho da conversa.
 */
export function invalidarFichaDoTelefone(qc: QueryClient, contactId: string): void {
  qc.invalidateQueries({ queryKey: ["contact", contactId] });
  qc.invalidateQueries({ queryKey: ["contacts"] });
  qc.invalidateQueries({ queryKey: ["conversations"] });
  qc.invalidateQueries({ queryKey: ["conversation-reply-address"] });
}
