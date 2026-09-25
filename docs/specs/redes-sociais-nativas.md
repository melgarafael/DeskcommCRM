# Redes sociais nativas

## Escopo

`Conexões → Redes sociais` conecta um perfil Zernio à organização. Contas e
redes são lidas da API; autorização usa o fluxo hospedado do provedor e retorna
à mesma aba. Instagram e Facebook recebem DMs na caixa de entrada existente.
Outras redes podem ser autorizadas e verificadas, mas não são apresentadas como
canais de atendimento. Publicação, anúncios e comentários não fazem parte desta
entrega. Contas de anúncios são filtradas da lista.

## Segurança e dados

- `channel_integrations` guarda a credencial cifrada e o perfil por organização.
  Só `service_role` acessa a tabela; API exige administrador e MFA quando cadastrado.
- As chamadas externas usam timeout, resposta sem cache e recusa de redirects.
- Sessões de atendimento usam `zernio_social`, sem mudar o transporte WhatsApp.
- `contacts.social_identity` é rede/conta/participante; nunca vira telefone ou LID.
- Webhook exige assinatura antes de arquivar ou ingerir. Conta e rede precisam
  corresponder à sessão. IDs de mensagem incluem a conta para deduplicação.
- A API não devolve a chave; auditoria registra apenas a operação, sem credenciais.
- Cada sessão recebe um webhook próprio. Uma tentativa incerta é reconciliada
  por URL antes de criar outra assinatura. Falha deixa o canal visível para retentar.

## Entrada e saída

`webhooks/channel/[token] → social/ingest → zernio/ingest → pos-entrada` reutiliza
mensagens, lead, opt-out, fila de agentes e pausa por atendimento externo.
`socialAdapter → inbox/conversations/{id}/messages` exige a thread do provedor;
confirmação sem `messageId` é falha, nunca um envio declarado como concluído.

Instagram/Facebook respeitam a janela de 24 horas existente. Não têm templates
WhatsApp. Anexos do provedor recebem Bearer apenas no domínio e caminho da API;
CDNs nunca recebem essa chave e redirects de mídia são recusados.

## Operação

Canais novos ficam com IA pausada (`pre_go_live`, lista vazia). O administrador
pode liberar ou pausar pela tela, depois de vincular um agente e avaliar se outra
automação já responde à conta. Nenhum webhook externo é desativado pela conexão.
Histórico anterior não é importado nem reprocessado automaticamente.

## Sistema vivo

Entrada: contas autorizadas e webhook assinado. Saída: Inbox, mensagens e motor
existente de atendimento. Porta: aba em Conexões. Registro: auditoria de mudança,
arquivo de webhook, ledger de mensagens. Recuperação: falha visível e retentativa
com reconciliação. Retorno: erro do provedor impede declarar envio; mensagens
externas pausam a IA, opt-out impede novas respostas. Saúde passa pelo vigia existente.

## Fontes verificadas

- https://docs.zernio.com/accounts/list-accounts
- https://docs.zernio.com/connect/get-connect-url
- https://docs.zernio.com/webhooks/create-webhook-settings
- https://docs.zernio.com/messages/list-inbox-conversations

## Validação de 2026-09-15

- Suíte unitária completa: 858 arquivos, 8.807 testes aprovados e uma falha esperada.
- Banco: instalação e atualização do baseline; 55 invariantes dirigidos aprovados
  (incluindo RLS e isolamento da nova tabela), após a varredura completa.
- QA com Postgres/Supabase e HTTP locais: configurar perfil, ativar conta, verificar
  saúde, ingerir mensagem assinada, repetir evento, recusar assinatura inválida e
  ignorar outra conta antes de arquivar. Resposta humana passou pelo handler real
  e chegou ao servidor de transporte de teste com a thread correta.
- Navegador real: aba Redes sociais, diagnóstico de conexão, permissões de IA e
  conversa com entrada/saída no Inbox. Identificador numérico permaneceu sem telefone.
- Publicação e entrega real no provedor são verificações separadas do QA local.
