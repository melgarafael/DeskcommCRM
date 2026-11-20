import type { Lead } from "@/lib/types/leads";

/** Só identificadores rotulados, nunca números de endereço/CPF ou DDD inferido. */
export function dadosDoCardParaContato(lead: Pick<Lead, "custom_fields" | "description" | "tags">) {
  const fields = lead.custom_fields ?? {};
  function valor(chave: string, rotulo: RegExp): string | undefined {
    if (typeof fields[chave] === "string" && fields[chave].trim()) return fields[chave].trim();
    const valores = [
      ...new Set(
        (lead.description ?? "")
          .split(/\r?\n/)
          .map((linha) => rotulo.exec(linha)?.[1]?.trim())
          .filter((v): v is string => !!v),
      ),
    ];
    // Mais de um telefone exige que o atendente escolha o principal.
    return valores.length === 1 ? valores[0] : undefined;
  }
  return {
    email: valor("email", /^\s*e-?mail\s*:\s*(.+)$/i),
    phone_number: valor(
      "phone_number",
      /^\s*(?:telefone(?: original)?(?: \d+)?|celular|whatsapp)\s*:\s*(.+)$/i,
    ),
    tags: lead.tags,
  };
}
