import { PLURAL_DO_TIPO, type TipoDeAviso } from "./tipos";

/**
 * O texto do WhatsApp de um aviso. Leva título e link — nunca senha, valor ou
 * dado do cofre (SPEC-avisos, A5): quem precisa do detalhe abre na área.
 */
export function textoDoAviso(p: {
  tipo: TipoDeAviso;
  titulos: readonly string[];
  corpo?: string | null;
  /** URL absoluta para abrir na área. */
  url: string;
}): string {
  if (p.titulos.length <= 1) {
    const linhas = [`🔔 ${p.titulos[0] ?? "Novo aviso"}`];
    if (p.corpo) linhas.push(p.corpo);
    linhas.push(p.url);
    return linhas.join("\n\n");
  }
  const MAX = 8;
  const itens = p.titulos.slice(0, MAX).map((t) => `• ${t}`);
  if (p.titulos.length > MAX) itens.push(`• e mais ${p.titulos.length - MAX}`);
  return [`🔔 Você tem ${p.titulos.length} ${PLURAL_DO_TIPO[p.tipo]}:`, itens.join("\n"), p.url].join("\n\n");
}
