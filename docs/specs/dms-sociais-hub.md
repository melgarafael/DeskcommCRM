# DMs de Instagram e Facebook Messenger

Escopo autorizado: mensagens diretas nas duas redes pelo [Sócios AI Hub](https://hub.sociosai.com/docs/referencia), com atendimento humano e agente de IA existente. Comentários de posts ficam fora desta entrega, por decisão do solicitante.

## Contrato confirmado

Referência pública consultada em 12/09/2026, contrato 1.3. Autenticação Bearer de **subconta**, validada em `GET /v1/me`; nenhuma requisição envia `X-Subaccount-Id`. Uma subconta exclusiva por organização evita roteamento acidental entre clientes. Cadastro de chave cifra o valor com AES-GCM e a chave de instalação já usada nas credenciais de IA. Não há nova variável obrigatória.

`POST /v1/connect-sessions` devolve a autorização hospedada no HUB. `GET /v1/channels` sincroniza os canais. `POST /v1/webhooks` registra o recebimento HTTPS. Webhooks verificam HMAC do corpo bruto, timestamp, id de evento e subconta. IGSID/PSID são strings opacas da conversa; não se cria telefone artificial. `POST /v1/messages` usa `Idempotency-Key` e retorna aceite assíncrono. `message.status` confirma envio, entrega, leitura ou falha. Fora das 24 horas da última entrada não existe envio livre nem template para estas redes.

## Fluxo implementado

Conexões → Instagram e Facebook → chave de subconta → configurar e testar recebimento → conectar Instagram/Messenger. A tela distingue configuração de recebimento de **teste efetivamente recebido**. Atualizar conexões relê o provedor; desconectar conserva o histórico. Recuperar DMs usa `/v1/events?event=message.received` a partir da data escolhida pelo operador, com continuação explícita quando há mais páginas. Eventos expirados pelo provedor não são recuperáveis.

A RPC `fn_ingest_social_dm` grava contato, conversa, mensagem e evento `social.dm_received` na mesma transação. Identidade da sessão e FK composta cercam a organização. A anonimização do contato remove o identificador social, a thread externa e os ids externos das mensagens na mesma transação. Reentrega não recria mensagem nem trabalho. O consumidor registrado no drain existente executa opt-out, criação de demanda e despacho de IA; falhas retornam à fila existente, com tentativas e dead-letter. O evento guarda apenas referência da mensagem. Anexos suportados entram no worker de mídia existente, com destinos HTTPS de CDN Meta e tamanho limitado.

A IA começa bloqueada por canal. O administrador pode liberá-la na aba social; a execução exige agente publicado e vinculado, credencial de IA e worker/cron funcionando. Assumir/devolver usa a autoridade existente do Inbox; entrada nova preserva `bot_silenced_until`. A última checagem antes do transporte relê a janela e a autoridade. Aceite assíncrono permanece `sending`, com id externo, até o recibo; o ledger reconhece esse aceite sem retransmitir a intenção. Confirmações não rebaixam leitura/entrega para enviado.

Falha de canal alimenta a Central de avisos pelo monitor existente, com resolução quando a conexão retorna. Falha de entrega aparece na mensagem do Inbox. Cadastro, sincronização, recuperação, desconexão e configuração geram auditoria com a operação, sem chave nem conteúdo de DM.

## Operação e validação

A instalação aplica as migrations 0275, 0276 e 0277, ou o apêndice do baseline, antes de servir a versão nova. O processamento usa o worker/cron já distribuído no produto. Desenvolvimento: app e `scripts/dev-crons.ts` precisam estar ativos. O endereço `NEXT_PUBLIC_APP_URL` precisa ser HTTPS público para receber do HUB; localhost permite validar a interface e eventos de teste locais.

Provas automatizadas: `lib/channels/social/*.test.ts`, `tests/invariants/social-dms.test.ts`, `tests/unit/followup-send-ledger.test.ts` e `tests/e2e/social-dms.spec.ts`. A suíte E2E usa organização e credenciais fictícias, assinatura real, banco/Auth reais e não envia mensagens externas.

**Não medido contra contas reais:** autorização Meta, aceite/envio e entrega de DMs pelo HUB, anexos de contas reais e resposta de modelo com chave paga. Requerem subconta do solicitante, página/Instagram profissional, HTTPS público e credencial de IA. Os testes de transporte usam o contrato público; não equivalem a homologação com o provedor.


## Evidência desta implementação

- Build de produção local aprovado; o bundle aponta para Supabase local.
- `gov:verify` com Node 22: 793 arquivos, 8.392 testes aprovados e um expected-fail da suíte existente; tipos e lint aprovados.
- Banco completo: 189 arquivos aprovados; dois casos de `agenda-meet.test.ts` falham também no HEAD original `53428145`, em cópia isolada. Não são causados por esta integração. Após incluir LGPD, a seleção de DMs/RLS/RBAC/ordem de locks passou em 77 casos, incluindo baseline em install e update.
- E2E social aprovado com capturas desktop/celular e checagem de largura; assumir/devolver e janela também verificados no banco.
- Controle negativo em cópia isolada: substituir a verificação HMAC por `true` fez nove casos falharem. O código usado pela instância não foi alterado nessa sabotagem.

As contagens registram esta execução, não uma promessa permanente da suíte. Artefatos visuais locais ficam em `test-results/social-dms-*/`; não fazem parte do commit.
