---
title: "Spec 33 — Canal de e-mail para a Zoe"
parent: 00-prd-master.md
type: spec
scope: transversal
status: draft
version: 0.1.0
owner: produto-arquitetura
created_at: 2026-11-02
---

# Spec 33 — Canal de e-mail para a Zoe

## 1. Decisão e origem

### Confirmado pelo dono do produto

- A Zoe deve pesquisar, qualificar, registrar, abordar e acompanhar leads automaticamente dentro de uma política de campanha configurada uma vez. Não deve pedir aprovação para cada lead ou mensagem.
- WhatsApp fica fora deste fluxo por enquanto, conforme decisão do dono do produto. O teste Cloud API retornou erro Meta `131031` (`Business Account locked`).
- Respostas, pedidos para parar, reclamações, endereços inválidos, limites da campanha e situações incertas devem interromper a sequência ou escalar conforme a regra correspondente.
- O domínio `dreamlab.lol` usa e-mail Hostinger e o endereço criado para contato é `contato@dreamlab.lol`.

### Inferido do código e da operação atual

- O CRM tem envio SMTP/Resend para ações de automação. Esta branch adiciona conexão Hostinger, captura IMAP, persistência na Inbox e caminho de resposta; ainda não está implantada nem conectada a uma caixa real.
- A caixa deve ser conectada à interface de conversas do CRM; n8n pode orquestrar quando necessário, mas não escreve diretamente nas tabelas do CRM.
- Até uma política de campanha estar definida e a caixa ser conectada, a descoberta pode preparar candidatos, mas nenhum contato comercial é iniciado.

## 2. Objetivo

Permitir que uma organização conecte uma caixa de e-mail e use a caixa de entrada existente do CRM para receber, responder e acompanhar conversas da Zoe, incluindo campanhas autorizadas. A integração deve funcionar no Mac self-hosted atual e continuar instalável em um clone limpo do DeskcommCRM.

## 3. Limites funcionais

1. A conexão de e-mail é um canal de conversa próprio, não apenas uma ação `send_email` de automação.
2. O canal usa SMTP para saída e IMAP com TLS para entrada. O primeiro conector é Hostinger Email, com `smtp.hostinger.com:465` e `imap.hostinger.com:993` fixos pelo adapter. Outros provedores exigem adapters próprios; o usuário não pode informar um host arbitrário.
3. A mensagem recebida deve ser associada à organização, caixa, contato e conversa corretos antes de chamar qualquer agente. Nenhuma busca pode cruzar organizações.
4. Respostas a mensagens enviadas preservam `Message-ID`, `In-Reply-To` e `References` para manter a conversa no mesmo tópico.
5. A conversa entra no runtime de agentes já existente, respeitando o Brain e a política de atendimento da organização. A resposta gerada é gravada no CRM antes de ser enviada.
6. O canal não envia automaticamente por falta de configuração. Estado inicial: desconectado e campanhas pausadas.

## 4. Configuração e segredos

- Nesta primeira entrega, cada organização tem uma caixa Hostinger, endereço e senha próprios. Hosts, portas e TLS ficam fixos no adapter; expansão para outros provedores acrescenta um adapter revisado, sem permitir destinos arbitrários.
- Senhas SMTP/IMAP são cifradas em repouso com o mecanismo de segredos da instalação. Nenhuma resposta da API, log, exportação ou tela de diagnóstico inclui o valor ou seu hash reutilizável.
- A credencial é revelada somente no formulário de configuração e nunca pode ser lida de volta; substituição e remoção são ações auditadas.
- Ao trocar o endereço da caixa, o CRM reinicia o cursor no e-mail mais recente e desliga a sincronização até uma ativação explícita. Alterar apenas a senha da mesma caixa preserva o cursor e a escolha de sincronização.
- A interface mostra separadamente autenticação de saída, autenticação de entrada, última sincronização e última falha sanitizada. “Conectado” só aparece após os dois protocolos autenticarem.
- A operação da Zoe não depende do Gmail OAuth. O conector deve aceitar SMTP/IMAP padrão e não exigir uma conta Google.

## 5. Entrada, idempotência e segurança

- O worker percorre a caixa por cursor IMAP `(UIDVALIDITY, UID)`, em ordem crescente, em páginas de até 20. O identificador externo `(connection, UIDVALIDITY, UID)` e o `Message-ID` normalizado deduplicam mensagens por organização e caixa.
- A implementação atual, por decisão de privacidade, pula o histórico da caixa se `UIDVALIDITY` mudar: salva o UID mais recente e registra `email_uid_validity_reset_skipped_history`. Isto não é reconciliação e pode deixar mensagens não importadas; a interface/runbook deve deixar isso visível.
- A leitura não apaga mensagens do servidor. Uma lease por caixa serializa as rodadas e expira automaticamente após falha; o cursor só avança depois que a página foi persistida e passa por compare-and-set com o token da lease. A gravação das mensagens, os efeitos pós-entrada e o cursor não formam uma transação única. Mensagens novas são gravadas com `email_inbound_effects_status = pending`; após o carimbo da conversa e o despacho terminarem, o worker muda o marcador para `completed`. Uma mensagem pendente é retomada na rodada seguinte mesmo que o INSERT já exista. O despacho consulta o `event_log` da mesma mensagem antes de emitir outro turno, e falhas no carimbo ou no despacho mantêm o cursor parado. Linhas anteriores a este marcador não são reproduzidas, para evitar despertar conversas antigas quando o cursor for reprocessado. Efeitos compartilhados que já tratam falhas como best-effort continuam sujeitos à semântica própria; isto recupera o carimbo e o despacho sem alegar uma transação distribuída entre Postgres, runtime e cursor.
- A implementação aceita somente texto simples limitado. E-mail HTML-only aparece como aviso; HTML e anexos não são importados nem convertidos.
- Cada remetente tem uma conversa por caixa e fio RFC. `email_thread_root_id` identifica o tópico; mensagens independentes do mesmo contato abrem conversas distintas, enquanto `In-Reply-To`/`References` recuperam a conversa existente. O `provider_conversation_id` continua apontando para o Message-ID mais recente para que respostas mantenham o encadeamento SMTP. Mensagens antigas recebem uma raiz derivada dos cabeçalhos já guardados; se não houver nenhum, preservam a conversa histórica por contato e caixa.
- A mensagem importada recebe `external_content_untrusted: true`; quando esse é o inbound do turno, o runtime acrescenta uma instrução de sistema para tratar o corpo como conteúdo externo. Isso é uma mitigação de prompt, não uma fronteira determinística: permissões do agente e políticas de envio continuam sendo as barreiras efetivas.
- A resolução limita a busca à organização, contato e caixa antes de considerar os cabeçalhos RFC; referências de outro remetente, sessão ou organização nunca podem ligar conversas. A lista de referências só acumula dentro do fio já resolvido, e a raiz permanece estável mesmo quando a conversa recebe novas mensagens.
- Logs e auditoria registram IDs, estados, datas e contagens. Não registram corpo integral, senha, token de campanha ou conteúdo de anexos.

## 6. Saída, duplicação e opt-out

- Todo envio é persistido no CRM antes da chamada SMTP e recebe um `Message-ID` próprio. O recibo acompanha remetente, destinatário, conversa, campanha e origem da autorização.
- SMTP não oferece uma chave de idempotência de entrega. Se a conexão cair depois de o servidor poder ter aceitado a mensagem, o envio fica como `delivery_unknown`; o worker não reenviará automaticamente. Uma reconciliação explícita tenta localizar o `Message-ID` na pasta de enviados quando o provedor salva cópias; se não houver prova de entrega ou não entrega, encaminha para resolução humana.
- A resposta de uma pessoa encerra os follow-ups da campanha para aquele contato. A resposta é entregue à Zoe somente depois das regras de segurança e consentimento.
- Pedido para parar cria supressão aplicável à organização e bloqueia novos envios de marketing. Reclamação ou abuso pausa o contato e encaminha para uma pessoa. Endereço que devolve erro permanente é marcado como inválido e sai da fila.
- Mensagens de campanha identificam claramente a empresa e oferecem um caminho simples para parar. A supressão é aplicada antes do agendamento e novamente imediatamente antes do envio.
- Envios usam limites, cadência e horário da campanha; nenhum orçamento de anúncio ou serviço pago é autorizado por esta spec.

## 7. Política de campanha e LGPD

- Cada campanha registra: empresa/Brain, oferta aprovada, público, geografia, exclusões, fonte e dados permitidos, fundamento legal e respectiva evidência quando aplicável, critérios de qualificação, limite diário/semanal, cadência, horário, conteúdo de identificação, método de opt-out e regras de escalação.
- Não há política implícita: fundamento legal, público, geografia e limites não têm valores padrão. A campanha permanece pausada até os campos obrigatórios serem preenchidos e confirmados uma vez pelo responsável.
- `marketing` exige o consentimento que as regras existentes do CRM já aplicam. Se a campanha usar interesse legítimo, exige o registro de avaliação de legítimo interesse previsto pelas regras do projeto; a integração não decide nem inventa o fundamento.
- E-mails coletados de páginas públicas continuam sendo dados não verificados. Uma página pública não prova consentimento, autorização de marketing ou precisão do endereço.
- O alcance desta spec não substitui a revisão jurídica da base legal de uma campanha real.

## 8. Arquitetura prevista

1. Adicionar `email` ao contrato fechado de canais e às capacidades de mensagem, preservando a fronteira `lib/channels/`.
2. Criar migration e baseline idempotente para identidade da caixa, credenciais cifradas, cursor de sincronização e metadados RFC necessários às mensagens.
3. Adicionar conexão/configuração no CRM com validação de host, TLS e credenciais; sem permitir destinos arbitrários ou SSRF pelo cadastro.
4. Implementar o worker IMAP por pull e adapter SMTP por conexão, integrados ao `event_log` e ao runtime atual. O caminho inicial está nesta branch; falta tornar efeitos pós-entrada idempotentes e concluir as proteções descritas em §5.
5. Estender a caixa de entrada para exibir o canal e responder com cabeçalhos de tópico corretos.
6. Ligar campanha de prospecção ao canal somente depois de perfil, consentimento/base legal, supressão, cadência e limite estarem prontos.
7. Deixar n8n fora do caminho de persistência: se orquestrar um passo, chama API autenticada do CRM; nunca escreve no Postgres do CRM.

### Primeiro recorte técnico implementado

`lib/email/hostinger.ts` contém o adapter servidor Hostinger para avançar a integração sem depender das credenciais do usuário:

- testa autenticação SMTP com `verify()` e acesso IMAP à INBOX em modo somente leitura; não envia nem lê mensagens durante o teste;
- usa exclusivamente os hosts TLS da Hostinger neste conector inicial, com timeout e resultados sanitizados; senha e erro bruto não voltam ao chamador;
- aceita `Message-ID`, `In-Reply-To` e `References` validados na saída SMTP para manter uma resposta no tópico original;
- cria um cursor inicial no UID mais recente para não importar o histórico pessoal da caixa;
- lê páginas limitadas por UIDVALIDITY e UID, sem alterar flags, apagar e-mails ou incluir anexos/HTML; aceita somente texto simples limitado e o marca como conteúdo externo não confiável;
- informa mensagens grandes ou inválidas como itens sem corpo, para que uma camada futura possa persistir o resultado e avançar o cursor sem repetir indefinidamente.

`app/app/settings/email` e a action `connectHostingerEmail` já permitem que um admin conecte a caixa: testam os dois protocolos sem enviar mensagem, cifram a senha com `fn_encrypt_oauth`, auditam o vínculo e mantêm a sincronização desligada. A action `disconnectHostingerEmail` remove a credencial após confirmação, com MFA e papel de admin, e audita sem registrar endereço ou senha. `supabase/migrations/20261102100000_9084_email_connection_hostinger.sql` cria o registro único por organização, com RLS/ACL fechadas e o mesmo bloco no baseline. O campo de senha é exibido apenas para entrada e não é retornado pela API da tela.

As ações existentes de automação `send_email` e as respostas do canal podem usar a caixa Hostinger saudável da organização. Respostas automáticas exigem opt-in explícito separado; a opção começa desligada. Essa escolha é exclusiva da saída de automações; convites, recuperação de senha, cobrança e outros e-mails de sistema continuam no transporte da plataforma. Sem opt-in ou sem uma conexão, o caminho anterior SMTP/Resend é preservado; uma conexão ativada mas indisponível falha sem trocar de remetente. A autenticação SMTP não envia mensagem de teste. A sincronização IMAP também exige opt-in separado, começa desligada, inicia no UID mais recente e importa apenas texto simples limitado.

O cron `hostinger-email-inbox` lê uma página limitada por rodada, preserva mensagens na caixa e só avança o cursor depois de persistir o conteúdo e concluir o carimbo da conversa e o despacho da Zoe. A chave de deduplicação é organização + sessão + RFC Message-ID, com UIDVALIDITY/UID como identidade do transporte. O marcador `email_inbound_effects_status` registra o trabalho pendente junto com a mensagem; uma repetição retoma linhas pendentes e reconhece um despacho já existente no `event_log`. Uma mensagem sem remetente válido é ignorada e não pode iniciar resposta automática; conteúdo sem texto simples aparece como aviso sem importar anexos ou HTML. Mensagens válidas criam ou reutilizam contato e conversa no mesmo tenant, preservam o fio RFC para resposta e passam pelos efeitos compartilhados de opt-out, lead e despacho da Zoe. Registros anteriores ao marcador são tratados como legado e não têm os efeitos reproduzidos.

O caminho de persistência da Inbox, o worker de sincronização, a retomada de efeitos pendentes, a separação por fio RFC, as respostas com cabeçalhos e opt-ins separados para ler e enviar existem nesta branch. A conexão não foi ativada nesta implementação, nenhuma mensagem foi importada ou enviada e as campanhas continuam dependentes de política própria. A idempotência cobre a retomada do carimbo e do despacho da Zoe; a proteção determinística contra prompt injection e a política da campanha seguem pendentes antes de resposta comercial automática.

## 9. Critérios de aceite

- Uma instalação sem credenciais continua operando e mostra o canal como desconectado.
- Duas organizações com o mesmo endereço ou `Message-ID` não compartilham mensagem, contato, conversa, cursor ou segredo.
- Dois e-mails independentes do mesmo contato e caixa têm conversas diferentes; uma resposta com `In-Reply-To`/`References` volta ao fio original, inclusive após uma resposta enviada pelo CRM.
- Repetir um ciclo IMAP não duplica mensagem nem chama a Zoe duas vezes.
- Uma falha após aceitação SMTP não manda uma segunda cópia automaticamente.
- A resposta mantém o tópico original; qualquer resposta interrompe a cadência pendente.
- Opt-out, reclamação, endereço inválido, pausa de campanha e teto são bloqueados também no limite de envio, não só na interface.
- O conteúdo externo não consegue executar ferramentas, mudar política, escolher Brain/tenant, ou instruir o agente a ignorar regras.
- Migrations, baseline, API, UI e worker funcionam num clone limpo, com RLS, RBAC, auditoria, retenção e rollback conforme a doutrina do CRM.

## 10. Sequência de entrega

1. Fechar o modelo de dados e a spec de migration.
2. Adicionar configuração segura do canal e o estado de saúde.
3. Implementar captura IMAP idempotente e persistência como conversa do CRM.
4. Implementar resposta SMTP e reconciliação de `delivery_unknown`.
5. Implementar stop/opt-out e a integração com o runtime da Zoe.
6. Criar o formulário de política única da campanha e manter execução desativada enquanto faltarem campos.
7. Configurar as credenciais Hostinger no Mac e validar primeiro com mensagens controladas entre caixas sob controle do usuário.
8. Ativar campanhas só depois da confirmação da política e de todos os gates operacionais.
