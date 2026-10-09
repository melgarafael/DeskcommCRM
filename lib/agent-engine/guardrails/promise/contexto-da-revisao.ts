/** Conversa informa pedido/perfil, nunca autoriza política da empresa. */
export interface ContextoDaRevisao {
  mensagens: ReadonlyArray<{ papel: "cliente" | "atendente"; texto: string }>;
  resumo: string | null;
  limitado: boolean;
  momento: string;
  fuso: string;
}

/** Recebe só conversa curada pelo servidor, sem consultar dados/identificadores. */
export function montarContextoDaRevisao(
  mensagens: readonly { direction: string; body: string }[],
  resumo: string | null | undefined,
  momento: string,
  fuso: string,
): ContextoDaRevisao {
  // A entrada já respeita a janela curada do agente (20 mensagens/8 mil tokens
  // no padrão). O teto adicional só protege transporte extraordinariamente grande.
  let limitado = mensagens.length > 100;
  let restante = 48000;
  const selecionadas: Array<{ papel: "cliente" | "atendente"; texto: string }> = [];
  for (const m of mensagens.slice(-100).reverse()) {
    if (m.direction !== "inbound" && m.direction !== "outbound") continue;
    if (!m.body.trim()) continue;
    const limite = restante;
    if (limite < 200) { limitado = true; break; }
    let texto = m.body;
    if (texto.length > limite) {
      const inicio = Math.floor(limite * 0.75);
      texto = texto.slice(0, inicio) + "\n[…]\n" + texto.slice(-(limite - inicio - 7));
      limitado = true;
    }
    restante -= texto.length;
    selecionadas.push({ papel: m.direction === "inbound" ? "cliente" : "atendente", texto });
  }
  const sum = resumo?.trim() || null;
  if (sum && sum.length > 4000) limitado = true;
  return { mensagens: selecionadas.reverse(), resumo: sum?.slice(0, 4000) ?? null, limitado, momento, fuso };
}
