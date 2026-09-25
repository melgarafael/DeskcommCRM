import { resolveField } from "@/lib/automation/conditions";

const ALIASES: Record<string, string> = {
  nome: "contact.name",
  primeiro_nome: "contact.name",
  telefone: "contact.phone_number",
  email: "contact.email",
};

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const resolved = resolveField(context, ALIASES[path] ?? path);
    // `{{primeiro_nome}}` = primeira palavra do nome, como no Inbox e na campanha.
    const texto = String(resolved ?? "");
    return path === "primeiro_nome" ? (texto.trim().split(/\s+/)[0] ?? "") : texto;
  });
}
