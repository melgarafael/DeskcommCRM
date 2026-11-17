/**
 * O TEXTO QUE O MOTOR GRAVA — e que a tela mostra como veio.
 *
 * A linha do turno na timeline (`crm_lead_activities.reason`), o aviso do
 * espelho de etapa na Central, o resumo da passagem para uma pessoa e a razão
 * da nota do negócio são DADO: nascem no servidor e nunca passam por `t()` na
 * renderização. Por isso cada um é traduzido no instante em que é gravado, no
 * idioma da organização — e `pt-BR` devolve a chave, byte a byte o de antes.
 *
 * O conteúdo escrito pela IA (o compromisso, a próxima ação) NÃO é traduzido:
 * entra no `{texto}` depois da tradução, por função.
 */
export const TEXTOS_DO_MOTOR_GRAVADO = {
  // lib/leads/checkpoint-diff.ts — a linha "Resposta da IA" na timeline.
  "Nova objeção: {texto}": { es: "Nueva objeción: {texto}" },
  "{n} novas objeções: {texto}": { es: "{n} nuevas objeciones: {texto}" },
  "Novo compromisso: {texto}": { es: "Nuevo compromiso: {texto}" },
  "{n} novos compromissos: {texto}": { es: "{n} nuevos compromisos: {texto}" },
  "Próxima ação: {texto}": { es: "Próxima acción: {texto}" },

  // lib/agent-engine/edge/crm/move-lead-stage.ts — o aviso do espelho de etapa.
  "a etapa de destino do funil": { es: "la etapa de destino del embudo" },
  "nenhum funil liberado para este assistente": { es: "ningún embudo habilitado para este asistente" },
  "o negócio está num funil que este assistente não cuida": {
    es: "el negocio está en un embudo del que este asistente no se encarga",
  },
  "este assistente não cuida do funil onde o negócio está": {
    es: "este asistente no se encarga del embudo donde está el negocio",
  },
  "O assistente quis organizar um negócio de um funil que não é dele": {
    es: "El asistente quiso organizar un negocio de un embudo que no es suyo",
  },
  "O assistente concluiu que este negócio deveria ir para {etapa}, mas ele não cuida do funil onde o negócio está ({detalhe}). Ninguém mexeu no card. Se ele deveria cuidar desse funil, marque isso na configuração do assistente; se não, não há nada a fazer.":
    {
      es: "El asistente concluyó que este negocio debería ir a {etapa}, pero no se encarga del embudo donde está el negocio ({detalhe}). Nadie movió la tarjeta. Si debería encargarse de ese embudo, márcalo en la configuración del asistente; si no, no hay nada que hacer.",
    },
  "O assistente quis marcar um negócio como perdido — e isso exige um motivo": {
    es: "El asistente quiso marcar un negocio como perdido, y eso exige un motivo",
  },
  'O assistente concluiu que este negócio deveria ir para {etapa}, que no seu funil é uma etapa de perda. Perder um negócio exige um motivo, e o motivo é a razão que quem está no negócio reconhece — o assistente não inventa uma. Ninguém mexeu no card: ele continua onde estava. Se o negócio realmente se perdeu, abra o card no funil, use "Marcar como perdido" e informe o motivo; se não, não há nada a fazer.':
    {
      es: 'El asistente concluyó que este negocio debería ir a {etapa}, que en tu embudo es una etapa de pérdida. Perder un negocio exige un motivo, y el motivo es la razón que reconoce quien lleva el negocio: el asistente no se la inventa. Nadie movió la tarjeta: sigue donde estaba. Si el negocio realmente se perdió, abre la tarjeta en el embudo, usa "Marcar como perdido" e indica el motivo; si no, no hay nada que hacer.',
    },
  "O assistente quis mover um negócio — o funil exige campos antes": {
    es: "El asistente quiso mover un negocio, pero el embudo exige campos antes",
  },
  "O assistente concluiu que este negócio deveria ir para {etapa}, mas o seu funil exige o preenchimento de alguns campos antes de entrar nela. {detalhe} Ninguém mexeu no card: ele continua onde estava. Abra o negócio, preencha o que falta no dossiê e mova o card normalmente.":
    {
      es: "El asistente concluyó que este negocio debería ir a {etapa}, pero tu embudo exige rellenar algunos campos antes de entrar en ella. {detalhe} Nadie movió la tarjeta: sigue donde estaba. Abre el negocio, rellena lo que falta en el expediente y mueve la tarjeta normalmente.",
    },
  "Espelho de stage no CRM falhou — funil possivelmente inconsistente": {
    es: "Falló el reflejo de etapa en el CRM: el embudo puede estar inconsistente",
  },
  'lead_state avançou para "{etapaDeDestino}" no harness, mas crm_move_lead_stage falhou ({motivo}: {detalhe}). Reconcilie o stage no CRM manualmente.':
    {
      es: 'lead_state avanzó a "{etapaDeDestino}" en el harness, pero crm_move_lead_stage falló ({motivo}: {detalhe}). Concilia la etapa en el CRM manualmente.',
    },

  // lib/agent-engine/agent/declaracao.ts + lib/escalacao/briefing-da-passagem.ts — o resumo da passagem.
  "O que a pessoa quer: {texto}": { es: "Lo que la persona quiere: {texto}" },
  "Prometido a ela: {texto}": { es: "Lo que se le prometió: {texto}" },
  "{o_que} (até {prazo})": { es: "{o_que} (hasta {prazo})" },
  "Dados coletados automaticamente (confira antes de usar):": {
    es: "Datos recogidos automáticamente (compruébalos antes de usarlos):",
  },
  "Compromissos: {texto}": { es: "Compromisos: {texto}" },
  "Objeções: {texto}": { es: "Objeciones: {texto}" },
  "Dados coletados: {texto}": { es: "Datos recogidos: {texto}" },
  "Por que a IA passou: {texto}": { es: "Por qué la IA pasó la conversación: {texto}" },
  'Quem passou escreveu: "{texto}"': { es: 'Quien la pasó escribió: "{texto}"' },
  "O que o cliente quer (segundo a IA — confira): {texto}": {
    es: "Lo que el cliente quiere (según la IA, compruébalo): {texto}",
  },
  "O que a IA já tentou:": { es: "Lo que la IA ya intentó:" },
  "Últimas mensagens do cliente (palavras dele): {texto}": {
    es: "Últimos mensajes del cliente (sus palabras): {texto}",
  },
  "Contexto acumulado (segundo a IA — confira):": { es: "Contexto acumulado (según la IA, compruébalo):" },
  "Caso: {texto}": { es: "Caso: {texto}" },
  "Bloqueio: {texto}": { es: "Bloqueo: {texto}" },
  'A pessoa que escalou escreveu: "{texto}"': { es: 'La persona que escaló escribió: "{texto}"' },
  "Valores e negociação: fora do escopo da IA.": { es: "Precios y negociación: fuera del alcance de la IA." },
  "Resposta comercial barrada; valores e negociação são exclusivos da equipe.": {
    es: "Respuesta comercial bloqueada; los precios y la negociación son exclusivos del equipo.",
  },

  // lib/leads/score-formula.ts — a razão da nota do negócio.
  "compromisso do cliente": { es: "compromiso del cliente" },
  "compromissos do cliente": { es: "compromisos del cliente" },
  "objeção em aberto": { es: "objeción abierta" },
  "objeções em aberto": { es: "objeciones abiertas" },
  "item de qualificação": { es: "dato de calificación" },
  "itens de qualificação": { es: "datos de calificación" },
  "outro fator": { es: "otro factor" },
  "outros fatores": { es: "otros factores" },
  "conversa em dia": { es: "conversación al día" },
  "resposta da IA a caminho": { es: "respuesta de la IA en camino" },
  "sem resposta além do esperado": { es: "sin respuesta más de lo esperado" },
  "sem resposta há muito tempo": { es: "sin respuesta desde hace mucho" },
  "limitado a {n}": { es: "limitado a {n}" },
  "sem parcelas relevantes além da base": { es: "sin factores relevantes además de la base" },

  // lib/wacalls/events-bridge.ts — a atividade da ligação na linha do tempo.
  "Chamada de voz atendida": { es: "Llamada de voz atendida" },
  "Chamada de voz perdida — {motivo}": { es: "Llamada de voz perdida — {motivo}" },
  "Chamada de voz sem resposta — {motivo}": { es: "Llamada de voz sin respuesta — {motivo}" },
} as const;
