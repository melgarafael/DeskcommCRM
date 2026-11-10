# Prova dirigida de atendimento e follow-up (#3475)

Este script prepara a execução de seis jornadas contra uma bancada existente. O arquivo não é uma evidência: somente `relatorio.json` produzido por uma execução e as capturas inspecionadas podem registrar o que foi medido. Não inicia app, Supabase ou worker. Não lê `.env*`, não chama seeds e não muda specs, gates ou invariantes.

```sh
pnpm exec tsx tests/qa/provar-atendimento-followups-3475.ts --help
pnpm exec tsx tests/qa/provar-atendimento-followups-3475.ts --manifest /caminho/manifesto-sintetico.json
pnpm exec tsx tests/qa/provar-atendimento-followups-3475.ts --manifest /caminho/manifesto-sintetico.json --only dossie,inbox
```

O manifesto é validado inteiro antes de abrir recursos. Os destinos e as fixtures selecionadas são conferidos no PG antes de qualquer escrita. Senhas e tokens são passados por variáveis cujos **nomes** ficam no manifesto; o conteúdo deles não vai ao relatório. `--help` não exige ambiente, lê arquivo ou abre conexão. RC 0 pode ser parcial: `core_complete` exige as seis jornadas aprovadas; `complete` exige também as subprovas de transporte Push e da guarda de bolha invisível. Subprova `not_run` nunca vira sucesso por haver um unit verde.

## Ambiente fornecido pelo coordenador

Exporte `QA_3475_BASE_URL`, `SUPABASE_DB_URL`, `QA_3475_DESTINO_ID`, `QA_3475_BUILD_SHA`, `QA_3475_BUILD_ID`, `QA_3475_CRON_SECRET` e as variáveis referidas pelo manifesto. Os três identificadores de destino/build precisam coincidir com o manifesto da bancada. A associação entre o app servido e esse build pertence ao coordenador que compilou e iniciou a aplicação; o script a registra, sem afirmar que compilou ou instalou.

Para `pausa`, `assinatura` e `ack`, `WAHA_API_BASE_URL` precisa ser o **mesmo endereço configurado no app**, numa porta loopback exclusiva e livre. O script sobe ali um receiver HTTP real de `/api/sendText`, seguindo `encerramento-atendimento.spec.ts`, e fecha apenas o servidor que abriu. Porta ocupada é falha: não encerra outro processo. A assinatura é comparada ao texto que o transporte recebeu, já que `messages.body` não contém a linha de assinatura.

As fixtures pertencem a uma organização exclusiva cujo slug começa com `qa-3475-`. A organização precisa estar operante; usuários de teste usam e-mail `.test` ou `.invalid`. O cenário conserva as fixtures para investigação e **muta** aquelas inscrições, conversas e campanhas; não rode duas vezes com os mesmos enrollments cancelados. Use banco descartável e rode em sequência na bancada reservada.

## Formato do manifesto (schema 1)

O schema Zod no início do `.ts` é o contrato completo. Campos:

O arquivo `provar-atendimento-followups-3475.manifest.example.json` mostra o formato com identificadores fictícios. Ele não é uma fixture executável: substitua pelos registros da bancada reservada antes da prova.

| Campo | Conteúdo e precondição |
| --- | --- |
| `schema`, `synthetic` | `1` e `true` |
| `environment_id`, `build: {sha,id}` | Identidade sintética da bancada e o SHA/BUILD_ID que ela serve |
| `organization: {id,slug}` | Organização exclusiva `qa-3475-*` |
| `users: {admin,manager,viewer,other_tenant}` | Cada ator tem `{id,email,password_env}`; `other_tenant` também tem `organization_id` distinto. Manager é manager/admin; viewer é viewer. Admin é obrigatório no cenário de assinatura, pois iniciar a Prospecção exige admin; pode ser omitido nos demais. Sem MFA nesses atores de bancada; o script falha se o login exigir outro passo |
| `enrollments: {dossie_dormente,dossie_coletando,inbox_dormente}` | Cada fixture tem `{id,contact_id,contact_name,conversation_id}`. Precisam existir nos estados indicados, produzidos pelo fluxo real. Não inserir eventos de passo à mão |
| `human` | `{conversation_id,pure_conversation_id,user_id,token_env,no_scope_token_env}`. Duas conversas novas, automáticas e sem silêncio; dois bearers reais da org, somente o primeiro com `messages:on_behalf`; atendente ativo da org. Transporte liberado para os telefones sintéticos |
| `signatures` | `{agent_id,agent_name,llm_mode,automation,prospecting}`. `llm_mode` é `byok` ou `platform`. Assinatura IA/por_agente ligada e reserva diferente do nome do agente |
| `signatures.automation` | `{rule_id,conversation_id,event_type,entity_type,entity_id,payload}`. Regra real ativa com ação `send_ai_message` usando o agente indicado e condição que aceite o evento. O script emite o gatilho por `emit_event` e chama o dreno, **não** chama o handler de envio ou injeta resultado do LLM |
| `signatures.prospecting` | `{campaign_id,candidate_id,config}`. Campanha draft com busca succeeded; candidato selecionado em `new`, sem linha correspondente em `messages`. O UUID `message_id` já é reservado na criação e não prova envio. Config aceita pela API real de start e `funnel_entry=on_start`. Script inicia a campanha pela rota, lê a conversa criada pelo produtor, antecipa somente `next_send_at` da fixture e chama o cron real |
| `notices` | `{agent_id,version_id,keyword_regex,cases,push_transport}`. `push_transport` é `null` para provar UI/decisão/job sem alegar entrega; ou `{subscription_id,receipts_url,token_env}` para exigir também recibos de transporte |
| `notices.cases` | Exatamente quatro objetos `{name,conversation_id,contact_id,channel_session_id,body,type,expected_notice}`: `recusada/true`, `aceita/false`, `midia_sem_texto/true`, `ja_engajado/false`. `type` é text/audio. Conversas sem responsável e sem dono de negócio que mude a regra; agente automático publicado no número e elegibilidade válida. Só a última tem outbound real deste agente no atendimento corrente |
| `ack` | `{conversation_id,channel_session_id,session_name,webhook_token_env,hmac_secret_env,other_tenant_message_id}`. Canal sintético ativo, token de path e segredo HMAC reais da fixture. A mensagem da outra organização tem identificador externo que não existe na organização principal |

Para o cenário de assinatura é obrigatório um agente publicado com LLM real utilizável. No modo `byok`, `credential_id` precisa apontar para uma credencial real, ativa e validada. O seed padrão `seed-e2e-followup-agent.ts` grava bytes fictícios: sozinho **não** satisfaz essa precondição. No modo `platform`, o coordenador atesta o fallback real do app exportando `QA_3475_APP_PLATFORM_LLM_READY_FOR_SHA` com o SHA servido; não é uma prova de modelo por si só, pois o cenário ainda exige o produtor efetivamente gerar e enviar. O app precisa usar a credencial; saldo, consentimento, cap, janela e pré-go-live precisam permitir os telefones sintéticos. Sem isso, o cenário falha; os units com modelo dublado não são reapresentados como aceite do produtor.

O cenário aguarda o JOIN `alerts-messages` confirmado pelo servidor Realtime antes de inserir cada inbound. Abrir a página ainda não prova que a inscrição terminou.

Para avisos, configure as preferências de mensagem `in_app` e `push`, realtime funcionando e VAPID no app. O script observa toast, decisão autenticada e o resultado canônico do job: `vapid_ausente` reprova e `ia_conduz` precisa aparecer nos controles negativos. Um job apenas consumido não prova a decisão.

Transporte Push é separado. Com `push_transport` configurado, a inscrição precisa pertencer ao manager e usar um endpoint admitido pelo produto. O receiver deve receber e **decifrar Web Push real**, preservando recibos sintéticos consultáveis por `GET receipts_url`, com `Authorization: Bearer` da variável `token_env`. Resposta: `{ "deliveries": [{ "id": "recibo-unico", "conversation_id": "uuid", "user_id": "uuid" }] }`. O receiver deriva a conversa do `href` decifrado; não aceita recibo inventado. O script exige recibo positivo e ausência no controle negativo. Receiver controlado não é prova de aceitação pelo FCM. CA/DNS de teste só em processos ou containers próprios; não modificar trust global, `/etc/hosts` do VPS, allowlist ou guard do produto. Se o caminho canônico recusar o destino sintético, registrar o limite e completar as demais jornadas.

## O que cada jornada mede

- `dossie`: viewer não cancela; outro tenant não lê. Manager entra pela fila, cancela `dormente` e `coletando`, vê estado e timeline sem reload; confere PG/evento, recarrega e roda tick sem ressuscitar.
- `inbox`: expande o painel do contato, usa Parar no dormente, confere persistência/evento, reload e tick sem despertar.
- `pausa`: envio em nome de atendente por bearer real, controle puro sem pausa e recusa sem escopo; receiver real, carimbo de cinco minutos e selo na tela. Aguarda **cinco minutos reais** e verifica o automático de volta, sem editar o relógio.
- `assinatura`: automação e primeira Prospecção pelos produtores reais, LLM real, linha persistida e texto exato com assinatura no receiver; mensagem visível no Inbox.
- `avisos`: INSERT inbound real cuja trigger emite `message.received`, sem evento duplicado. Observa realtime/toast, consulta a decisão autenticada e mede o resultado do job. Filtro recusando/aceitando, mídia sem texto e agente já engajado. Entrega Push só conta com envelope recebido/decifrado.
- `ack`: envia pelo Inbox a um receiver real, entrega ACKs por webhook com HMAC canônico e compara banco/indicadores/reload. Cobre HMAC inválido, `read → 2/1/-1` sem regressão, `sent → -1 → 2/3` recuperando entrega/leitura, ACK1 conservando falha e isolamento da outra organização.

Capturas e relatório ficam sob `evidence/atendimento-followups-3475/<run>/`. O relatório persiste checks e hashes do texto recebido; não grava bearer, DSN, senha, trace ou HAR. O script não modifica `docs/testing/user-journey-map.md`; depois da execução e inspeção, o coordenador registra ali as jornadas efetivamente medidas e os achados.

A guarda de bolha invisível vive no `send_message` do turno do agente. API/MCP de envio comum não atravessa essa guarda. O sandbox não expõe o resultado `corpo_vazio` da tool; ausência de candidato por si só seria ambígua. A subprova `invisibleAgentTool` permanece `not_run` até observar um turno real tentando enviar o texto invisível e recebendo a recusa. Não há cenário vazio aprovado por reserva.

A execução de 26/10/2026 e a subprova separada pelo handler real estão em [evidence/atendimento-followups-3475](../../evidence/atendimento-followups-3475/README.md). O runner base continua deixando essa subprova como `not_run`; o consolidado aponta ao relatório separado e preserva os limites de cada execução. Este arquivo é harness manual em `tests/qa`, fora da imagem e sem coleta automática de spec.
