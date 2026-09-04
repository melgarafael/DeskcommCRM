# HANDOFF — o silêncio de 3h da retomada humana não gruda no banco

> **Nota de privacidade.** Este registro foi anonimizado antes de entrar no
> repositório, que é **público**: nomes de lead, de atendente e de tenant, o
> valor negociado e os UUIDs de produção viraram rótulos. Nada disso é
> necessário para o defeito — o que importa são os horários, o
> `sent_via='external_device'` e a sequência de chamadas, e esses estão
> intactos. O caso continua reproduzível.


> ⚠️ **INSTRUÇÃO PERMANENTE:** ler no INÍCIO de toda sessão que investigue este
> defeito e ATUALIZAR + COMMITAR a cada avanço. Progresso só conta com PROVA
> VISÍVEL (query real contra produção, log real, reprodução real — não
> "deveria funcionar"). Commitar este arquivo junto — mudança só no working
> tree se perde.

## O caso que expôs o defeito (um tenant de produção, 2026-09-02)

A lead (`contacts.id = <contato-1>`,
`conversations.id = <conversa-2>`) conversou com o
agente o agente. Em paralelo, um humano (um atendente da oficina) respondeu ela
**direto pelo WhatsApp do celular da oficina** — três mensagens `fromMe=true`,
`sent_via='external_device'`, às 11:59:45, 12:09:42 e 12:18:53 (nota fiscal,
prazo de 2 dias, um valor fechado).

`handleOutboundFromUserPhone` (`lib/waha/ingest.ts`) existe exatamente para
esse caso: ao ver `fromMe=true` fora do composer/IA, chama
`silenciarBotPorRetomadaHumana`, que deveria silenciar o bot por 3h
(`HUMAN_TAKEOVER_SILENCE_MS`) sem precisar de handoff formal. **Não silenciou
nenhuma das três vezes.** O bot continuou respondendo por cima do humano
(ex.: às 12:11:40, mais de 100s depois da 2ª tentativa de silêncio), pedindo de
novo informação que o humano já tinha resolvido — e é daí que nasce o efeito
colateral que motivou a investigação original: o agente dizendo "já registrei
sua dúvida com o o atendente" sem nunca ter chamado nenhuma ferramenta de handoff
(ver commit deste mesmo dia em `operator-turn.ts`/`inbound-turn.ts` — prompts
reforçados para não descrever uma ação que não foi executada).

## O que foi MEDIDO, sem sucesso em explicar

```
$ psql "$SUPABASE_DB_URL" -c "select bot_silenced_until, now() from conversations where id='<conversa-2>'"
 bot_silenced_until | now
---------------------+-------------------------------
                     | 2026-09-02 12:28:13.536988+00
```
(vazio 100+s depois da 3ª tentativa de silenciar, que deveria ter valido até ~15:18)

Eliminado, um por um, com evidência — **não é nenhum destes**:

1. **Código não deployado** — `faf9446ba` (fix de 30/ago, mesmo tenant,
   "o atendente") é ancestral de `v1.11.0`, a tag rodando em produção.
2. **RLS bloqueando silenciosamente** — `service_role` tem `rolbypassrls=true`
   medido (`select rolbypassrls from pg_roles`), e a JWT do `.env` decodifica
   com `role: service_role` correto.
3. **Contato/conversa duplicados** (LID vs telefone) — só existe 1 contato e 1
   conversa para a lead (`wa_identity` bate, `wa_lid` bate).
4. **Corrida de fila/timing** — o job que respondeu por cima (`647cdd97`) foi
   criado às 12:11:21 e rodou às 12:11:29, **mais de 100s** depois do silêncio
   ter sido setado (12:09:43). Folga enorme, não é corrida.
5. **RPCs do caminho de ingestão zerando o campo** — `fn_upsert_wa_conversation`
   e `fn_mark_conversation_message` (as duas chamadas em toda mensagem
   inbound/outbound) foram lidas no SQL: nenhuma toca `bot_silenced_until`.
6. **Toda outra escrita do campo no repo** — `grep -rln bot_silenced_until`
   inteiro (app/lib/sql) foi lido. Existem 3 lugares legítimos que zeram o
   campo de propósito (fechar conversa sem handoff formal, `fn_conversation_assign`
   ao liberar assignee, "devolver ao automático"), mas **nenhum foi acionado**:
   `conversation_assignment_events` está **vazio** para essa conversa (nunca
   rodou claim/release/transfer/routing nela) e não há entrada correspondente
   em `api_audit_log` no intervalo.
7. **`console.error` engolido** — testado que saída não-estruturada REALMENTE
   aparece em `docker logs` (outras linhas non-JSON aparecem normalmente), e
   nenhuma das 3 tentativas de silêncio logou erro de leitura nem de update.
8. **Mecanismo geral quebrado** — outras conversas do MESMO tenant, na MESMA
   janela, ficaram silenciadas corretamente por 27+ minutos seguidos
   (`grep "turno pulado" nos logs do worker`, lead `b7e4f713-…`).

## A reprodução que FUNCIONOU (e por isso não fecha o caso)

Rodei a função real `silenciarBotPorRetomadaHumana` contra a API real de
produção (mesmo endpoint, mesma service role key), com um contato+conversa
sintéticos criados só para o teste (apagados depois):

```
=== 4. chamando silenciarBotPorRetomadaHumana ===
[diag] valor lido antes do update: null
[diag] resultado do update — data: [{"bot_silenced_until":"2026-09-02T15:47:48.37+00:00"}] error: null
=== 5/6. lendo depois (imediato e após 3s) ===
bot_silenced_until: 2026-09-02T15:47:48.37+00:00   ← gruda
=== 7/8. simulando um novo inbound (fn_upsert_wa_conversation de novo) ===
bot_silenced_until: 2026-09-02T15:47:48.37+00:00   ← continua gravado
```

Ou seja: **o mesmo código, contra o mesmo banco, pelo mesmo caminho, funciona
perfeitamente quando isolado.** Isso descarta "bug determinístico simples no
código" como explicação — o defeito só aparece na conversa real, sob a
concorrência real (9 mensagens em 20 minutos, turnos de IA disparando quase
sem intervalo).

## Hipótese que restou, não verificada

Sem acesso aos logs internos do Supabase (API/Postgres logs do próprio
provedor — não expostos via `docker logs` neste ambiente), não dá pra ver o
que a REST API respondeu de fato para as 3 chamadas reais. As duas hipóteses
que sobraram, nenhuma confirmada:

- O `UPDATE` real recebeu `error: null` mas afetou 0 linhas por algum motivo
  específico daquela requisição (não reproduzido isoladamente).
- Algo na camada do PostgREST/pooler do Supabase (fora do nosso código) sob
  alta concorrência de escritas na mesma linha.

## Próximo passo (precisa de acesso que esta sessão não tinha)

No painel do Supabase do projeto (`xiysdkvcvnqbzkknwdzd`) → **Logs → API
Logs / Postgres Logs**, filtrar por `PATCH /rest/v1/conversations` no
intervalo **2026-09-02 11:59:00–12:19:00 UTC**, e conferir o `id` filtrado e o
corpo da resposta das 3 chamadas. Isso mostra se o Supabase recebeu e
processou a request como um `UPDATE ... 0 rows` (silencioso) ou algo mais.

## O que JÁ foi corrigido nesta mesma sessão (não depende deste achado)

- `lib/agent-engine/agent/operator-turn.ts` (`SYSTEM_DO_OPERADOR`) — o Operador
  agora é instruído a não tratar uma promessa redigida no passado ("registrei
  com o Fulano") como prova de que algo foi gravado no CRM.
- `lib/agent-engine/agent/inbound-turn.ts` (`AGENT_TOOL_DEFS.open_human_case` e
  `.request_human_handoff`) — descrições reforçadas: citar o nome de alguém
  não substitui chamar a ferramenta no mesmo turno.
- `typecheck` 0, `lint` 0, `tests/unit/operador-*.test.ts` +
  `tests/unit/handoff-fernando-fiacao.test.ts` + `tests/unit/entrega-de-capacidade.test.ts`
  → 55/55 verdes.
- Card da lead (`crm_leads.id = <id-3>`) movido
  manualmente para o estágio `repassado-ao-atendente`, com atividade registrada em
  `crm_lead_activities` explicando a correção manual — o estágio **não**
  reflete uma automação corrigida, é conserto pontual daquele card.
