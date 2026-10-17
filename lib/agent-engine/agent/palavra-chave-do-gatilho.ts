/**
 * FILTRO DE PALAVRA-CHAVE DO AGENTE — a regra que a tela oferecia e nenhum
 * leitor vivo consultava (#2679).
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * `TriggerEditor.tsx` oferece "Só responder quando a mensagem falar de algo
 * específico (opcional)" e promete: "Se preencher, ele só entra quando a
 * mensagem contiver uma dessas palavras". O valor vai para
 * `ai_agent_versions.trigger_config.filters.keyword_regex` — mas o ÚNICO leitor
 * era `lib/ai/dispatcher/triggers.ts`, dentro de `triggerMatches`, chamado só
 * por `dispatchAgents`, que desde a Fase 0 não tem chamador fora de testes (o
 * cron `app/api/v1/cron/agent-dispatcher` é NO-OP permanente). O runtime vivo
 * (`lib/agent-engine`) nunca soube que o campo existia: quem preenchia o campo
 * via o agente respondendo a tudo.
 *
 * É o mesmo defeito que `janela-de-atendimento.ts` consertou para
 * `business_hours` ("a regra que a tela oferecia e ninguém lia") — este arquivo
 * é o irmão dele para `keyword_regex`.
 *
 * ## Falha ABERTA, sempre (a direção que não cala o cliente)
 *
 * `trigger_config` é jsonb livre e o campo nasceu como texto de gente, não
 * como linguagem de programação: regex malformada (`"["`, `"(orçamento"`),
 * valor que nem é string, campo vazio ou ausente ⇒ NENHUM filtro ⇒ o agente
 * responde como sempre. Uma config quebrada não pode virar mordaça (mesma
 * decisão do cabeçalho da janela). Dois casos particulares seguem a mesma
 * direção e por isso ficam na função de decisão:
 *
 *  - Corpo SEM texto (`null`): mídia sem legenda chega com `body` NULL e a
 *    transcrição só é gravada depois pelo media-derive-worker — a corrida que
 *    o #617 mediu. Barrar aqui calaria o áudio inteiro por causa de uma coluna
 *    que ainda vai ser preenchida. Dispara, como antes.
 *  - Mensagem fixada ausente (turno montado à mão, teste): sem corpo não há o
 *    que casar, e adivinhar é calar. Dispara, como antes.
 *
 * ## Por que um miss NÃO adia (diferente da janela)
 *
 * A janela horária adia o turno para a abertura: quem escreve às 22h é
 * atendido às 8h. O filtro de palavra não tem "depois": a MESMA mensagem nunca
 * vai conter a palavra que não contém. Adiar seria enfileirar para sempre. O
 * que o miss faz é encerrar o turno sem resposta — e a mensagem continua
 * visível na linha do tempo da Central, onde o operador vê, responde à mão ou
 * corrige o filtro na tela do agente. O consumo do job é o mesmo de todo outro
 * veto do início do turno (lead em handoff, conversa não elegível): `return`,
 * log info, nada de reagendamento.
 *
 * (Abrir item novo em `agent_inbox_items` para cada miss exigiria migration —
 * a coluna `kind` tem CHECK e a governance do repo congela `MANIFEST.md`; o
 * próximo que quiser esse rastro na Central soma o kind e a migration juntos.)
 *
 * ## Onde isto é aplicado
 *
 * `inbound-turn.ts`, no mesmo lugar e com o mesmo escopo do gate da janela de
 * atendimento: turno `inbound_turn` do caminho AUTOMÁTICO, depois de resolver
 * o agente publicado e antes de qualquer chamada de modelo. No modo assistido
 * o rascunho passa por aprovação humana — quem decide é gente, e filtrar a
 * fila de aprovação tiraria de lá mensagens que o operador talvez quisesse
 * responder.
 */

/**
 * Extrai o filtro de `trigger_config` (jsonb livre da versão publicada).
 *
 * `null` = sem filtro declarado OU declarado de forma que não dá para obedecer
 * (regex malformada, valor que não é string, texto vazio) — nos dois casos o
 * agente entra em tudo, como antes deste conserto.
 */
export function lerFiltroDePalavraChave(triggerConfig: unknown): RegExp | null {
  if (typeof triggerConfig !== 'object' || triggerConfig === null) return null;
  const filters = (triggerConfig as { filters?: unknown }).filters;
  if (typeof filters !== 'object' || filters === null) return null;
  const valor = (filters as { keyword_regex?: unknown }).keyword_regex;
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  if (texto === '') return null;
  // Case-insensitive, como o dispatcher legado (`new RegExp(..., 'i')`) e como
  // o campo promete ("uma dessas palavras" — ninguém escreve pensando em
  // maiúscula). SEM flag `g`: `lastIndex` de um RegExp `g` faria a segunda
  // chamada de `test` na MESMA instância responder diferente.
  try {
    return new RegExp(texto, 'i');
  } catch {
    // Regex torta de gente que preencheu o campo à mão: falha ABERTA.
    return null;
  }
}

/**
 * A decisão pura do gate: o turno deste inbound ENTRA no agente?
 *
 * `filtro === null` ⇒ sempre `true` (sem keyword preenchida nada muda — as
 * instalações existentes continuam respondendo a tudo). `corpo === null` ⇒
 * `true` (falha aberta da mídia, ver cabeçalho). Caso contrário, o corpo tem
 * de casar a regex — a promessa da tela, literal.
 */
export function turnoDisparaNaPalavraChave(filtro: RegExp | null, corpo: string | null): boolean {
  if (filtro === null) return true;
  if (corpo === null) return true;
  return filtro.test(corpo);
}
