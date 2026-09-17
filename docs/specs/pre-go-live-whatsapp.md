# Pré-go-live do WhatsApp

Contrato implementado na issue [#573](https://github.com/melgarafael/DeskcommCRM/issues/573).
Estado: **CONFIRMADO por código e testes**, não um simulador de mensagens.

## Comportamento

- Administrador do tenant ou da plataforma configura cada canal em **Conexões › Configurar acesso da IA**.
- Novos canais criados por QR, onboarding, conexão oficial ou provedor parceiro nascem em teste com lista vazia. Reconexões e canais anteriores não são alterados.
- Números são cadastrados com DDI antes de existir contato/conversa. A lista é normalizada, deduplicada e reconhece a variante brasileira com/sem nono dígito.
- Em teste, somente a lista do canal autoriza respostas automáticas. Formulário, campanha, automação ou devolução ao automático NÃO autorizam quem está fora dela.
- Lista vazia bloqueia todos; remover um número bloqueia as próximas respostas automáticas. As mensagens recebidas e o atendimento manual continuam no Inbox.
- Abrir ao público desativa a restrição da lista sem apagá-la. O agente ainda precisa estar publicado/vinculado; opt-out, silêncio e atribuição humana continuam válidos.
- Testes usam o WhatsApp real e têm os custos normais. O **Teste do agente** no editor continua sendo um fluxo separado, sem envio ao canal.

## Contrato técnico

`GET/PATCH /api/v1/channel-sessions/:id/ai-access`, somente admin.
GET retorna `{data:{mode,test_phone_numbers}}`; PATCH recebe
`{mode:"open"|"pre_go_live",test_phone_numbers:string[]}`.
O modo legado `allowlist` é lido sem ser convertido em aberto ou teste implicitamente.

Fonte de verdade: `channel_sessions.metadata`.
`ai_gate="allowlist"` + `ai_gate_mode="pre_go_live"` seleciona teste;
`ai_test_phone_numbers` guarda a lista por canal, sem TTL.
`ai_gate="open"` ignora a lista. Sem marcador de teste, o allowlist legado
continua usando `contacts.ai_authorized_at` e seu prazo.

A RPC `fn_configurar_pre_go_live_canal` grava somente as três chaves em um
UPDATE atômico, filtrado por organização/canal não arquivado. `ai_gate_mode`
recebe o MODO REAL da chamada (`open`/`pre_go_live`, o mesmo vocabulário do
PATCH): abrir ao público volta a gravar `open`, e o marcador de teste existe
somente enquanto o canal está em teste. Não substitui as
demais chaves de metadata e não modifica contatos ou histórico. EXECUTE somente
para service_role; a API resolve tenant/papel da sessão, nunca do body.

O allowlist POR ORIGEM continua por script
(`scripts/ativar-gate-elegibilidade-ia.ts`), que grava `ai_gate` e `ai_gate_mode`
na MESMA instrução: o alvo vale nos dois campos, então ligar o gate por origem
não devolve o canal ao modo de teste com a lista antiga. O preflight do script
promete o veredito que `gate.ts` executa.

`gate.ts` é a decisão compartilhada pelos adaptadores pg/Supabase, drain,
turnos, runtime legado, handoff e follow-up. A automação `send_ai_message`
checa antes do modelo; o sweep de silêncio usa a mesma regra. O sink
`sendMessageHandler` relê antes de enviar mensagens não humanas: se o
operador fechou o canal durante a geração, registra falha `pre_go_live`,
sem envio nem opt-out. O redrive de mensagens pendentes em `session-reconciler.ts`
também relê a lista antes de cada reenvio direto ao WAHA. Falha de leitura não envia.
Uma requisição já entregue ao provedor não pode ser recolhida por este modo.

## Sistema vivo

- Entrada: decisão do administrador em `ChannelAiAccess` e telefone recebido pela ingestão.
- Saída: regra de elegibilidade, drain/turnos e sink de mensagens.
- Log: `channel.ai_access_updated` no Audit Log, com modo e contagem, nunca telefones. Bloqueio tardio aparece no estado da mensagem.
- Superfície/porta: item Conexões da navegação existente; painel nas conexões por QR, oficial e parceiro.
- Continuidade: inbound continua registrado no Inbox; a equipe responde manualmente. Lista de teste não remove o silêncio humano nem opt-out.
- Anti-morte: a restrição é deliberada e visível; o próximo passo é autorizar testadores, responder manualmente ou abrir ao público. Não cria follow-up para contornar a restrição.
- Laço de retorno: operador observa as conversas de teste no Inbox, ajusta o agente e libera/restringe o canal explicitamente. Não há autoabertura.
- Mapa: `docs/architecture/pre-go-live-whatsapp.architecture.json`.

## Evidências e limites

- `pre-go-live.test.ts`, `gate.test.ts`, `consulta-supabase.test.ts`, `drain.test.ts`: elegibilidade e compatibilidade.
- `ai-access/route.test.ts`: RBAC, tenant, validação, falhas e auditoria sem números.
- `tests/invariants/pre-go-live-canal.test.ts`: banco real do baseline, privilégios, isolamento, remoção, primeira conversa e atualização sem perda de metadata. Abrir ao público devolve `ai_gate_mode="open"`.
- `gate-volta-a-autorizacao-por-origem.test.ts`: a ORDEM tela nova → abrir ao público → gate por origem, com o motor concordando com o preflight do script (issue #602).
- `tests/e2e/pre-go-live-whatsapp.spec.ts`: bootstrap/auth/DB reais e interface, inclusive recarga e viewport móvel.
- `messages-handler-desfechos.test.ts`: bloqueio no sink e envio humano preservado.
- `tests/invariants/agent-watchdog.test.ts`: reenvio com banco e receiver HTTP reais; remoção de número bloqueia mensagem pendente antes de alcançar o transporte.

O E2E não pareia um telefone nem paga uma chamada de modelo: prova a configuração
na tela com banco real. A elegibilidade e a ausência de envio são comprovadas
nos testes de integração/unidade; não se afirma uma conversa ponta a ponta com
um aparelho WhatsApp externo.
