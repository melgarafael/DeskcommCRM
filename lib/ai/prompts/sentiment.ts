/**
 * System prompt for the sentiment classifier.
 *
 * Instructs the model to return JSON with:
 *   - sentiment_score: number 0..1 (0 = muito negativo, 0.5 = neutro, 1 = muito positivo)
 *   - reasoning_short: string (máximo 100 caracteres, explicação breve do score)
 *
 * Idioma: PT-BR. Tom direto, sem floreios.
 *
 * ─── A régua mede HOSTILIDADE, não o assunto (issue #2209) ─────────────────
 *
 * Este texto presumia e-commerce ("clientes de e-commerce", "deceção com
 * produto/entrega" na faixa 0.2–0.4) e, numa instalação de advocacia, mandou
 * para humano um lead que escreveu "Fui bloqueado na Uber" — frase sem
 * irritação nenhuma, e no nicho relatar o problema é o conteúdo normal da
 * conversa. Em advocacia, saúde, assistência técnica e cobrança, chegar com a
 * queixa é chegar com o ASSUNTO.
 *
 * Por isso a separação é explícita e fica nas duas pontas da régua: hostilidade
 * com quem responde (ameaça, xingamento, pedido agressivo de falar com uma
 * pessoa) mora nas faixas baixas, que são as que cruzam o limiar; relatar o
 * problema, no neutro. `tests/unit/prompt-de-sentimento-separa-relato-de-
 * hostilidade.test.ts` prende estas duas pontas — apagar a âncora de relato ou
 * devolver "e-commerce" ao texto reprova o gate.
 */
export const SENTIMENT_SYSTEM_PROMPT = `Você é um classificador de sentimento para mensagens de quem conversa com uma equipe de atendimento — o assunto pode ser qualquer um: conta bloqueada, problema no produto, dúvida de cobrança, marcação, orçamento.

Analise a mensagem fornecida e retorne um objeto JSON com dois campos:
- "sentiment_score": número entre 0 e 1 (0 = muito negativo, 0.5 = neutro, 1 = muito positivo)
- "reasoning_short": string com no máximo 100 caracteres explicando o score

O score mede a HOSTILIDADE COM O ATENDIMENTO, não o assunto da mensagem. Quem relata o problema que o trouxe até aqui — "Fui bloqueado na Uber", "a conta está bloqueada desde ontem" — está passando informação, não brigando com ninguém: relatar o problema não é insatisfação, e entra na faixa neutra como qualquer outra frase sem carga emocional.

Critérios de pontuação:
- 0.0–0.2: hostilidade aberta com quem responde — ameaça (de processo, de expor a empresa, de chargeback), xingamento ou pedido agressivo de falar com uma pessoa (ex.: "isso é um absurdo, só tem palhaçada aqui")
- 0.2–0.4: irritação com o atendimento — reclamação de demora ou de resposta que não resolve, cobrança fechada, decepção explícita com quem respondeu
- 0.4–0.6: neutro — dúvida simples, solicitação de informação ou relato do problema que a pessoa descreve, sem irritação com quem respondeu (ex.: "Fui bloqueado na Uber")
- 0.6–0.8: satisfação leve, agradecimento, confirmação positiva
- 0.8–1.0: muito satisfeito, elogio, recomendação

Retorne SOMENTE o JSON, sem texto adicional.`;

/**
 * Abaixo desta nota o cliente conta como irritado e a conversa passa para um
 * humano (`ai.sentiment_alert`, em `workers/ai-sentiment-worker.ts`), quando o
 * agente não define `sentiment_threshold` próprio. Mora aqui, junto da escala
 * que ele corta, porque tem dois leitores: o worker, que dispara a passagem, e a
 * concordância do Jev (`app/api/v1/ai/jev/route.ts`), que mede se as duas notas
 * caíram do mesmo lado DESTE corte.
 *
 * É também o default declarado em `agentConfigSchema` (issue #2209): o valor que
 * a tela mostra quando o agente nunca configurou o limiar tem de ser o mesmo que
 * o worker usa, e por isso vem daqui por import — dois 0.3 à deriva seria um
 * terceiro defeito desta mesma família.
 */
export const DEFAULT_SENTIMENT_THRESHOLD = 0.3;
