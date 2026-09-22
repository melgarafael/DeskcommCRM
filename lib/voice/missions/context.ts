export type ContextMessage = {
  id?: string;
  direction: string;
  body: string;
  sent_at: string | Date;
};

export function callSuggestions(messages: ContextMessage[]) {
  const latest = messages.find((m) => m.direction === "inbound" && m.body.trim());
  if (!latest) return [];
  const evidence = latest.body.trim().slice(0, 240);
  return [
    {
      id: "continue",
      label: "Continuar esse assunto",
      evidence,
      message_id: latest.id,
      objective: `Continue por telefone o assunto da última mensagem do cliente, usando o histórico para entender o que já foi resolvido. Referência: ${JSON.stringify(evidence)}. Esclareça o que ainda falta, sem pedir que conte tudo novamente.`,
    },
    {
      id: "next-step",
      label: "Combinar o próximo passo",
      evidence,
      message_id: latest.id,
      objective: `Retome o assunto da última mensagem do cliente e combine um próximo passo adequado ao contexto. Referência: ${JSON.stringify(evidence)}. Não presuma que houve aceite nem repita perguntas já respondidas.`,
    },
  ];
}

/** Input is newest first; keep the newest messages when the context budget is full. */
export function serializeCallContext(company: string, name: string, messages: ContextMessage[]) {
  const selected: { quem: string; texto: string; quando: string | Date }[] = [];
  let budget = 21000;
  for (const m of messages) {
    const entry = {
      quem: m.direction === "inbound" ? "cliente" : "empresa",
      texto: String(m.body).slice(0, 1600),
      quando: m.sent_at,
    };
    const size = JSON.stringify(entry).length + 1;
    if (size > budget) break;
    selected.push(entry);
    budget -= size;
  }
  return JSON.stringify({
    empresa: String(company ?? "").slice(0, 300),
    cliente: String(name ?? "").slice(0, 300),
    mensagens: selected.reverse(),
  });
}
