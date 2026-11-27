# Chat no site — F4 completa (pedir o contato, "pode ser o mesmo contato", continuar no WhatsApp) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Antes de qualquer código: skills `deskcomm-contribuir`, `deskcomm-doutrina` e `sistema-vivo`.

**Goal:** fechar a F4 da Spec 36 em duas fatias. **F4-A:** quando a IA bate o teto do visitante anônimo, o visitante recebe uma frase pedindo telefone ou e-mail, e a conversa passa para a equipe com aviso na Central, em vez de silêncio. **F4-B:** o telefone ou o e-mail digitado no chat que já é de outra ficha aparece em Duplicados como par a conferir (nunca junta sozinho), e a janela ganha o botão opcional "Continuar no WhatsApp" com o código `dk1`.

**Medido (24/11, sobre `feat/chat-no-site-f4c` = `a0977108c6`):**
- Teto batido hoje = silêncio. `decidirElegibilidade` devolve `teto_do_visitante_anonimo` (`lib/ai/elegibilidade/gate.ts`), e o turno só registra "turno pulado" e dá `return` (`lib/agent-engine/agent/inbound-turn.ts`, bloco "GATE DE ELEGIBILIDADE", perto da linha 2924). O visitante não recebe nada e ninguém é avisado.
- O precedente exato já existe: o teto de GASTO faz `avisarLeadLendoOContato` (frase ao cliente) e depois `performHumanHandoff` (devolve à fila e abre o aviso na Central), com motivo `orcamento_de_ia` (`inbound-turn.ts` perto das linhas 1157-1190 e 2600; `lib/escalacao/aviso-ao-lead.ts`, `MotivoDoAviso`; `lib/escalacao/passagem.ts`, `MOTIVOS_DA_PASSAGEM` e a frase da tela; `lib/ai/handoff/orchestrator.ts`, `HandoffReason`). O aviso sai pelo mesmo adaptador da resposta comum, que já entrega ao chat (F1).
- Depois da passagem, `force_human` veta a IA antes do teto (`donoHumanoVetaIA`): a frase sai **uma vez** sem contador novo.
- Contato do chat: `atualizarDadosDoContato` (`lib/channels/webchat/ingest.ts`) grava `phone_number`/`email`; no `23505` (índices `uniq_contacts_org_phone` e `uniq_contacts_org_email`, um dado por ficha viva) ele **descarta** o dado com `logger.warn`. Resultado: a ficha do chat fica sem o telefone e Duplicados nunca vê o par que a spec promete.
- Duplicados já lê `source_metadata.telefone_em_conflito` (motivo `telefone_em_conflito`, `lib/contacts/duplicados.ts`), o mesmo que `fn_upsert_wa_contact` grava quando o WhatsApp acha o telefone em outra ficha. Para e-mail não há equivalente.
- WhatsApp: `channel_sessions.phone_number` existe; `montarCodigoDeOrigemDoSite(utm)` (`lib/leads/origem-do-site.ts`) monta o `dk1`; `lib/plataformas-de-anuncio/pagina-de-captura.ts` monta `https://wa.me/<digitos>?text=...`. A configuração do chat (`configuracaoDoChatSchema`, `lib/channels/webchat/config.ts`) não tem campo de WhatsApp.

**Spec:** `docs/specs/36-spec-chat-no-site.md`, seção "F4". Issue #1333.

## Global Constraints

- Sem migration e sem variável de ambiente nova (se a medição de uma tarefa provar que precisa, PARE e avise antes de escrever).
- Nenhum nome de provedor fora de `lib/channels/`; o motor decide pelo motivo do gate, nunca por `provider === 'webchat'`.
- `organization_id` sempre da fonte confiável (job, conexão resolvida pela chave), nunca do corpo.
- Nada junta fichas sozinho. Conflito só é **guardado** para quem opera decidir.
- O arquivo `lib/channels/webchat/codigo-para-colar.ts` e tudo que um componente `'use client'` importa **não** importa valor de módulo que toque `@/lib/env` (defeito da F2-B).
- Sem `console.log`. Textos novos nos dicionários pt-BR/en/es como os vizinhos.

## Review Focus

- A frase do teto sai uma vez por conversa; a segunda mensagem do visitante depois da passagem não gera outra.
- Aviso que falha não impede a passagem (mesma ordem e mesmo `try/catch` do teto de gasto).
- O caminho supabase (`workers/ai-response-worker.ts`, `lib/ai/runtime/agent.ts`) e o caminho pg (`inbound-turn.ts`) chegam ao MESMO desfecho com o teto batido. Se um deles não tiver como passar a conversa, medir e dizer, não inventar.
- Telefone do chat igual ao de outra ficha: a ficha do chat ganha `source_metadata.telefone_em_conflito`, a outra não muda, e Duplicados mostra o par. Nada é mesclado.
- Botão do WhatsApp desligado de fábrica; conexão escolhida de outra organização ou sem `phone_number` = sem botão.

## Fatia F4-A — o teto pede o contato e passa para a equipe

1. **Motivo novo, no vocabulário que já existe** (`lib/escalacao/aviso-ao-lead.ts`, `lib/escalacao/passagem.ts`, `lib/ai/handoff/orchestrator.ts` e os testes de cada um): `teto_do_visitante_anonimo` entra em `MOTIVOS_DA_PASSAGEM` (com a frase da tela: "A IA atingiu o limite de respostas para visitante sem contato — o cliente não pediu uma pessoa") e em `MotivoDoAviso`, cuja frase ao cliente pede telefone ou e-mail para a equipe continuar (variantes como as vizinhas, pt-BR/en/es). Rodar `git grep -n "Record<MotivoDoAviso\|Record<OrigemDaPassagem\|MOTIVOS_DA_PASSAGEM"` e completar todo mapa que quebrar.
2. **Motor, caminho pg** (`lib/agent-engine/agent/inbound-turn.ts` + teste no molde de `tests/unit/handoff-por-orcamento.test.ts`): no bloco do gate de elegibilidade, quando `elegib.motivo === 'teto_do_visitante_anonimo'` e o job é `inbound_turn`, faz `avisarLeadLendoOContato` (motivo novo) e `performHumanHandoff` (reason novo, sem chamar modelo), na mesma ordem e com o mesmo `try/catch` do teto de gasto; depois `return`. Os outros motivos seguem como hoje.
3. **Caminho supabase** (`workers/ai-response-worker.ts`, `lib/ai/runtime/agent.ts`): medir o que cada um faz com o veto. Se houver passagem equivalente (`triggerHandoff`), usar o mesmo motivo; se não houver, registrar no plano e no PR e não inventar.
4. **Documentos e sabotagem:** spec F4 (tirar o "Pendente" desta parte), jornada, mapa `docs/architecture/canal-do-chat-no-site.architecture.json` (aresta motor → Central), fragmento `.changes/chat-no-site-parte-4-completa-a.md` (`capacidade_nova`). Sabotagem: tirar o ramo novo do bloco do gate e ver o teste ficar vermelho.

## Fatia F4-B — "pode ser o mesmo contato" e continuar no WhatsApp

1. **Conflito guardado, nunca mesclado** (`lib/channels/webchat/ingest.ts` e teste): no `23505`, em vez de só descartar, grava na ficha do chat `source_metadata.telefone_em_conflito` (telefone) ou `source_metadata.email_em_conflito` (e-mail), por merge no jsonb (não apaga outras chaves), e o resto do patch (nome, o outro campo) entra normalmente. Descobrir qual dos dois colidiu tentando um campo por vez.
2. **Duplicados lê o e-mail em conflito** (`lib/contacts/duplicados.ts`, `app/api/v1/contacts/duplicates/route.ts` e testes): espelho de `telefoneEmConflito`, motivo novo `email_em_conflito`, com rótulo na tela (rodar `git grep -n "Record<MotivoDeDuplicidade\|telefone_em_conflito"` e completar). O telefone já funciona pelo motivo existente.
3. **Configuração do WhatsApp** (`lib/channels/webchat/config.ts`, rota de configuração da conexão do chat, `components/connections/CanalChatClient.tsx` e testes): campo opcional `whatsapp_channel_session_id` (uuid). A rota confere que a conexão é da MESMA organização, é de mensagem e tem `phone_number`; senão 422. A tela lista as conexões de WhatsApp da organização num seletor com "Nenhum" (padrão).
4. **Botão na janela** (`app/chat/[chave]/route.ts`, `lib/channels/webchat/janela-html.ts`, `public/webchat-janela.js` e testes): o servidor resolve o número da conexão escolhida (filtrando `organization_id` da conexão do chat) e manda à janela só os dígitos; a janela mostra "Continuar no WhatsApp" que abre `https://wa.me/<digitos>?text=<texto com o código dk1 das UTMs da página>` em nova aba (`rel="noopener noreferrer"`). Sem número = sem botão.
5. **Documentos e sabotagem:** spec F4, jornada, mapa, fragmento `.changes/chat-no-site-parte-4-completa-b.md` (`capacidade_nova`). Sabotagens: mesclar na ingestão em vez de guardar; aceitar conexão de outra organização.

## O que este plano não cobre

Turnstile (fora da spec). Coletar o contato de novo pela janela depois da primeira mensagem (o visitante responde em texto e a equipe lê na Inbox). Relatório por página.

## Como cada tarefa é verificada antes de empurrar

Só o leve aqui: parser do TypeScript, `vitest.mjs` focado e `tsc` focado. Suíte inteira, e2e e `test:db` vão ao CI do fork, e cada fatia só é "provada" depois do e2e dela pela branch descartável. Quem implementa é o opencode; quem roda a verificação, confere o diff e commita é o Claude.
