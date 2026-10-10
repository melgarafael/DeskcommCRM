import type { MidiaDeTemplate } from "@/lib/templates/midias";

/**
 * Interpola variáveis de template com dados do contato da conversa (Onda 5).
 * Suporta {{nome}} e {{primeiro_nome}}. Variável sem valor ou desconhecida
 * mantém o literal `{{x}}` — nunca gera texto quebrado que iria pro cliente.
 */
export interface TemplateContact {
  name?: string | null;
}

/** O que uma resposta rápida guarda além do texto (#2526). */
export interface RespostaRapida {
  /**
   * O `id` do template (linhas de `message_templates`). O payload só lê `body`
   * e `midias`, mas recebe a linha COMPLETA vind do hook — escondê-lo no
   * chamador obrigaria a todo mundo a remapear para dentro.
   */
  id?: string;
  body: string;
  /** `undefined`/`null` em linha antiga e em teste — os dois são "só texto". */
  midias?: readonly MidiaDeTemplate[] | null;
}

/**
 * O PAYLOAD DE USO (#2526): o que a escolha da resposta rápida entrega ao
 * compositor, pronto para virar uma mensagem editável.
 *
 * `texto` é o corpo interpolado — a legenda da PRIMEIRA imagem quando há mídia,
 * o mesmo contrato do envio de mídia que já existe —, e `midias` são as
 * imagens que o próprio operador carregou no template, na ordem gravada.
 *
 * O `slice` devolve uma lista NOVA de propósito: o compositor embaralha a fila
 * de envio, e embaralhar a lista do cache do React Query mudaria o que a tela
 * de templates mostra sem ninguém ter mexido nela.
 */
export function payloadDeUso(
  template: RespostaRapida,
  contact: TemplateContact,
): { texto: string; midias: MidiaDeTemplate[] } {
  return {
    texto: interpolateTemplate(template.body, contact),
    midias: [...(template.midias ?? [])],
  };
}

export function interpolateTemplate(body: string, contact: TemplateContact): string {
  const full = (contact.name ?? "").trim();
  const first = full.split(/\s+/)[0] ?? "";
  return body.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (literal, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (key === "nome") return full !== "" ? full : literal;
    if (key === "primeiro_nome") return first !== "" ? first : literal;
    return literal; // desconhecida: mantém
  });
}
