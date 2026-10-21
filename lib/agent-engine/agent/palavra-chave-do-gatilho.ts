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
 * decisão do cabeçalho da janela). Três casos particulares seguem a mesma
 * direção e por isso ficam na função de decisão:
 *
 *  - Corpo SEM TEXTO: mídia sem legenda chega com `body` NULL e a transcrição
 *    só é gravada depois pelo media-derive-worker — a corrida que o #617
 *    mediu. Barrar aqui calaria o áudio inteiro por causa de uma coluna que
 *    ainda vai ser preenchida. Dispara, como antes.
 *
 *    ⚠️ "SEM TEXTO" NÃO É `corpo === null`. O corpo do turno é composto por
 *    `corpoDaMensagem` (get-lead-context), que devolve o marcador `[audio]` /
 *    `[image]` enquanto não há derivado — `null` só quando a linha não existe.
 *    A régua é a mesma do roteador (`resolve-turn-agent.ts`, que decide pelo
 *    `signal`): sem `body` E sem `media_derived_text`. Sobre o corpo já
 *    composto, isso é `corpoTemTexto`: vazio ou só o marcador de mídia. (CR do
 *    mantenedor no #2696, ponto 2 — com `=== null` a falha aberta da mídia
 *    nunca rodava em produção.)
 *  - Nenhuma mensagem a julgar (turno montado à mão, teste, mensagem fixada
 *    ausente): sem corpo não há o que casar, e adivinhar é calar. Dispara.
 *  - Uma RAJADA é julgada pelo CONJUNTO: o drain coalesce a segunda mensagem no
 *    job da primeira, então "oi" + "quero um orçamento" só casa se o filtro
 *    olhar as duas (ponto 3 do mesmo CR). Ver `turnoDisparaNasMensagens`.
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
 * `inbound-turn.ts`, no caminho AUTOMÁTICO do turno `inbound_turn`: depois de
 * resolver o agente publicado, depois das DUAS detecções determinísticas —
 * pedido de humano e opt-out ambíguo (CR do #2696, ponto 1: elas não dependem
 * do filtro e não podem ser caladas por ele; é a mesma ordem do modo
 * assistido) — e antes de qualquer chamada de modelo. No modo assistido o
 * rascunho passa por aprovação humana — quem decide é gente, e filtrar a fila
 * de aprovação tiraria de lá mensagens que o operador talvez quisesse
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
 * O marcador que `corpoDaMensagem` põe no lugar do texto quando a mídia ainda
 * não tem derivado: `[audio]`, `[image]`, `[document]`, `[video]`… O tipo vem
 * de `messages.type`, em minúsculas.
 */
const MARCADOR_DE_MIDIA = /^\[[a-z_]+\]$/i;

/**
 * O corpo composto tem TEXTO de gente? A régua do "sem texto" do roteador
 * (`resolve-turn-agent.ts`: `body` nulo E `media_derived_text` vazio), lida
 * sobre o corpo que o turno já tem em mãos.
 *
 * `corpoDaMensagem` compõe a linha uma única vez: derivado ⇒ texto enquadrado
 * (tem texto); senão `body ?? '[tipo]'` (mídia sem derivado). Então "sem texto"
 * sobre o composto é: nulo, vazio/whitespace, ou só o marcador de mídia.
 */
export function corpoTemTexto(corpo: string | null): boolean {
  if (corpo === null) return false;
  const texto = corpo.trim();
  if (texto === '') return false;
  return !MARCADOR_DE_MIDIA.test(texto);
}

/**
 * A decisão pura do gate: o turno deste inbound ENTRA no agente?
 *
 * `filtro === null` ⇒ sempre `true` (sem keyword preenchida nada muda — as
 * instalações existentes continuam respondendo a tudo). Sem texto no corpo ⇒
 * `true` (falha aberta da mídia, ver cabeçalho). Caso contrário, o corpo tem
 * de casar a regex — a promessa da tela, literal.
 */
export function turnoDisparaNaPalavraChave(filtro: RegExp | null, corpo: string | null): boolean {
  if (filtro === null) return true;
  if (!corpoTemTexto(corpo)) return true;
  // Depois da guarda acima o corpo é string de gente: `corpoTemTexto` já
  // recusou `null` e vazio, e o TS não estreita por função.
  return filtro.test(corpo as string);
}

/**
 * A MESMA decisão sobre o que o cliente disse e AINDA NÃO FOI RESPONDIDO — a
 * lista que o handoff e o opt-out usam (`inboundsNaoRespondidos`).
 *
 * Uma mensagem que casa basta: o filtro é por mensagem (spec 10), e a rajada
 * coalescida pelo drain ("oi" + "quero um orçamento" no job do "oi") não pode
 * ser descartada inteira por causa da primeira linha. Cada mensagem é julgada
 * sozinha — emendar a rajada num texto só destruiria as réguas de palavra
 * isolada do opt-out, o mesmo motivo de `inboundsNaoRespondidos` ser lista.
 *
 * Lista vazia (nada a julgar) ⇒ `true`: falha aberta, como no caso do corpo
 * ausente.
 */
export function turnoDisparaNasMensagens(
  filtro: RegExp | null,
  corpos: readonly (string | null)[],
): boolean {
  if (filtro === null) return true;
  if (corpos.length === 0) return true;
  return corpos.some((corpo) => turnoDisparaNaPalavraChave(filtro, corpo));
}
