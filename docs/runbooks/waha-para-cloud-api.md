# Runbook — Migração WAHA → WhatsApp Cloud API oficial

Data: 2026-09-24. Rascunho (não executado). Para operadores self-host do
Canti CRM.

## Por que migrar

- **WAHA** (serviço `waha` no `docker-compose.prod.yml`) usa o protocolo
  não-oficial do WhatsApp Web. Funciona, mas a Meta pode banir o número sem
  aviso. É o padrão do instalador porque não pede nada à Meta.
- **Cloud API oficial** (`lib/channels/adapters/meta-cloud.ts`) é o caminho
  sancionado pela Meta: sem risco de banimento do número, mas exige verificação
  do negócio, templates aprovados fora da janela de 24h e custo por mensagem
  conforme a tabela da Meta.

Regra: número de produção real → Cloud API. O WAHA fica como opção para
testes ou mercados onde o operador aceita o risco.

## Pré-requisitos (Meta)

1. **Meta Business Manager** com negócio verificado (documentos da empresa).
2. **WhatsApp Business Account (WABA)** criada dentro desse Business.
3. **Número de telefone registrado na WABA.** Se o número está hoje no WAHA,
   é preciso liberá-lo/migrá-lo no painel da Meta antes de registrá-lo na WABA
   (um número não pode estar nos dois lugares ao mesmo tempo).
4. **System User com token permanente** (não o token temporário de 24h do painel).
5. `phone_number_id` do número (aparece no painel da WABA).

> ⚠️ Criar o app da Meta / verificar o negócio é feito pelo dono do negócio
> com os documentos dele. Não está autorizado fazer por ele sem aprovação
> explícita.

## Passo a passo

### 1. Credenciais no CRM
No CRM: canal WhatsApp → conectar → **Cloud API oficial**. Informar
`phone_number_id` + token permanente pelo fluxo seguro do conector
(nunca colar o token no chat nem em arquivos).

Verificação: se a validação de credenciais falhar, o CRM avisa antes de salvar.

### 2. Webhook da Meta → CRM
No painel do app da Meta (WhatsApp → Configuração):
- **Callback URL**: `https://<dominio-do-crm>/api/v1/webhooks/meta/<token>`
  (o `<token>` é gerado pelo CRM ao conectar o canal — é o path token que
  autentica o webhook).
- **Verify token**: o que o CRM mostra na mesma tela.
- Assinar os campos `messages` (o ingest processa `messages` e status de template).

Testar com o botão "Testar" da Meta: tem de devolver 200.

### 3. Templates
Fora da janela de 24h desde a última mensagem do cliente, a Cloud API **só**
permite templates aprovados pela Meta. Criar no painel da Meta os templates que
os follow-ups e campanhas usam (o CRM lista via `template-sync.ts`). Sem
template aprovado, a mensagem fora de janela falha — isso não é bug do CRM, é
regra da Meta (a janela de 24h vive na cadeia `before_send`, não no adapter).

### 4. Trocar o canal do tenant
No CRM, na configuração do canal do tenant: trocar de WAHA para
**Cloud API oficial**. É por tenant — dá para migrar um tenant de cada vez.

### 5. Testes reais (nesta ordem)
1. **Inbound**: escrever para o número de um celular → tem de chegar ao inbox.
2. **Outbound dentro da janela**: responder pelo inbox → tem de chegar.
3. **Outbound fora da janela**: com template aprovado → tem de chegar.
4. **Mídia**: enviar imagem e nota de voz. Atenção: na Cloud API o áudio só
   chega como nota de voz com `voice: true` (documentado em `meta-cloud.ts`);
   o adapter já trata, mas verificar no telefone real.
5. **Número em formato**: o adapter envia E.164 só dígitos sem `+`
   (`toE164Digits`); um `+` sobrevivente dá erro `#131009` da Meta.

### 6. Desligar o WAHA (só quando tudo acima estiver verde)
- Remover o serviço `waha` do compose de produção ou deixá-lo parado.
- Revogar a API key do WAHA.
- O webhook `app/api/v1/webhooks/waha/[token]/route.ts` fica no código
  (outros tenants podem continuar no WAHA); não precisa apagar nada.

## Rollback

Se algo falhar em produção: voltar o canal do tenant para WAHA pela UI do CRM
e subir o serviço `waha`. Os webhooks do WAHA continuam funcionando — não se
apaga configuração ao migrar, só se troca o canal ativo.

## Diferenças que mordem (do código, não da teoria)

| Tema | WAHA | Cloud API oficial |
|---|---|---|
| Sessão | `sessionRef` = nome da sessão | `sessionRef` = `phone_number_id`, vai na **URL**, não no corpo |
| Destinatário | aceita `@c.us` | só dígitos E.164, sem `+` |
| Áudio | o adapter converte para nota de voz | exige `voice: true`, a Meta **não** converte |
| Janela 24h | o WhatsApp impõe igual | igual, mas com templates obrigatórios fora da janela |
| Webhook | `/api/v1/webhooks/waha/<token>` | `/api/v1/webhooks/meta/<token>` |
| Risco de banimento | sim (não-oficial) | não |

## Não fazer

- Não registrar o mesmo número no WAHA e na WABA ao mesmo tempo.
- Não usar token temporário de 24h em produção (morre no dia seguinte).
- Não prometer ao cliente que "as mensagens são grátis": a Cloud API fatura
  por mensagem conforme a categoria (marketing / utilidade / autenticação).
