# Como conectar um servidor MCP com OAuth (cada cliente autoriza a própria conta)

> Para quem administra a organização. Recurso entregue na migration 9095.
> Mapa do fluxo: [`docs/architecture/mcp-por-agente-oauth.architecture.json`](../architecture/mcp-por-agente-oauth.architecture.json).

## Para que serve

Alguns sistemas guardam dados **do próprio cliente final**: a casa automatizada dele, a conta
no banco, os pedidos, o prontuário. Uma chave única da organização não serve nesse caso, porque
quem precisa dar o acesso é **o cliente**, e só ao dado **dele**.

Com o modo **OAuth por contato**, o agente envia na conversa um link curto. O cliente abre, entra
com o login dele no sistema do terceiro e autoriza. A partir daí o agente consulta (e, se você
permitir, age) na conta daquele cliente, e só nela. Outro cliente recebe o próprio link e nunca vê
os dados do primeiro.

O protocolo é o aberto da [especificação de autorização do MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):
OAuth 2.1 com PKCE S256, descoberta por RFC 9728 e RFC 8414, registro dinâmico de cliente
(RFC 7591), indicador de recurso (RFC 8707) e revogação (RFC 7009). Qualquer servidor MCP que
siga a especificação funciona, sem integração escrita para ele.

## Passo a passo

0. O recurso é um **módulo opcional, desligado de fábrica** (doc 252). Quem administra o servidor
   liga em **Admin › Sistema › Ferramentas externas por agente**. Desligado, a seção do agente e a
   lista da ficha do contato não aparecem, o agente não usa os servidores cadastrados e os dois
   endereços públicos (`/api/v1/mcp-oauth/iniciar/…` e `/callback/…`) respondem 404. A revogação
   no terceiro continua rodando: desligar para de usar o acesso, não deixa de devolvê-lo.
1. Abra **IA › Agentes**, escolha o agente e role até **Servidores MCP do agente**.
2. **Adicionar servidor**. Preencha o nome que vai aparecer (ex.: "Minha Casa") e o endereço do
   servidor MCP (Streamable HTTP, `https://…/mcp`). O endereço não pode ter senha, `?parâmetros`
   nem `#fragmento`, nem apontar para rede interna.
3. Em **Autenticação**, escolha **OAuth — cada cliente autoriza com o login dele**.
4. **Testar conexão**. A tela mostra o servidor de autorização encontrado, se ele aceita registro
   automático do cliente, se aceita revogação, os escopos disponíveis e os hosts que este servidor
   alcança. Se o servidor de autorização não aceitar PKCE S256, o cadastro é recusado.
5. Marque os **escopos** que serão pedidos ao cliente (peça só o necessário).
6. Se o servidor **não** aceita registro automático, abra **Cliente OAuth manual**, cadastre no
   terceiro o endereço de retorno mostrado ali e preencha o `client_id` (e o `client_secret`, se o
   terceiro exigir). O endereço é **um por servidor**
   (`https://<sua-instalação>/api/v1/mcp-oauth/callback/<id-do-servidor>`) e aparece depois do
   **Testar conexão**: a volta de um servidor nunca é aceita no endereço de outro.
7. **Manter o acesso depois que a conversa encerra**: `0` (padrão) revoga assim que a conversa é
   encerrada. Até 720 horas.
8. **Permitir ações (escrita) durante a conversa**: desligado por padrão. Leia o risco na tela
   antes de ligar.
9. **Salvar servidor**. Depois, em **Ferramentas**, marque o que o agente pode usar. Um servidor
   OAuth só lista as ferramentas com o acesso de um cliente: a lista mostra o que já apareceu em
   conversas, e você pode escrever o nome de uma ferramenta à mão.
10. **Salve o rascunho e publique** o agente: a escolha das ferramentas fica na versão.

O limite é de 5 servidores por agente.

## O que acontece na conversa

- **Cliente ainda sem acesso**: as ferramentas daquele servidor não aparecem para o agente. No
  lugar delas aparece uma só, `solicitar_acesso_<servidor>`. O agente a usa, recebe o link
  (`https://<sua-instalação>/api/v1/mcp-oauth/iniciar/…`, válido por 10 minutos e de uso único) e o
  envia ao cliente pelo fluxo normal de resposta.
- **Cliente autorizou**: a página "Acesso autorizado, pode voltar à conversa" aparece. **A conversa
  não continua sozinha nesta versão**: a próxima mensagem do cliente já encontra o acesso. (O
  próximo passo é o callback reabrir o turno por `event_log`.)
- **Acesso expirando**: o sistema renova sozinho, sem o cliente perceber.
- **Acesso caiu** (o cliente revogou no terceiro, o refresh foi recusado): o agente volta a ter só
  `solicitar_acesso_<servidor>` e pode pedir de novo.
- **Ação pede mais permissão** (o servidor responde `insufficient_scope`): o agente é orientado a
  gerar um link pedindo o escopo que faltou, sempre dentro dos escopos que você marcou.
- **Turno sem cliente** (Operador, automação): servidores OAuth por contato não são usados.

## Escrita (ações) durante a conversa

Desligada, toda ferramenta marcada como **Escrita** é recusada durante a conversa com o cliente,
como sempre foi. Ligada, ela roda **com o acesso do próprio cliente**, dentro do que ele autorizou,
e só para ferramentas que você marcou como Escrita. Toda chamada fica na auditoria
(`mcp.tool_called`, com agente, contato e ferramenta; argumentos com campos sensíveis redigidos).
Ligue só para ações que o cliente pediria a um atendente.

## Acessos na ficha do contato

Em **Contatos › (o contato) › LGPD**, a seção **Acessos a sistemas externos** lista o servidor, os
escopos, desde quando e o último uso. **Revogar** chama a revogação do terceiro (quando ele
oferece) e apaga o acesso daqui. O token nunca aparece em tela, log ou auditoria.

## Ciclo de vida do acesso

| Evento | O que acontece |
|---|---|
| Conversa encerrada | Revogação agendada para agora + a retenção do servidor; o cron `mcp-oauth-revogacao` (a cada 5 min) revoga no terceiro e esvazia o acesso |
| Autorização concluída depois de a conversa encerrar | O acesso já nasce com a revogação agendada (agora + a retenção) |
| Contato anonimizado (LGPD) | Pedidos pendentes apagados; revogação imediata; a linha é apagada — inclusive a de um acesso já revogado |
| Contato excluído | Acessos revogados no terceiro antes; depois tudo apagado em cascata |
| Servidor removido | Todos os acessos dele revogados no terceiro e apagados |
| Endereço, modo ou `client_id` do servidor trocado | Os acessos emitidos pela configuração antiga são revogados nela e apagados; os clientes autorizam de novo |
| Nova autorização do mesmo cliente | Substitui e revoga a anterior |

## Os outros dois modos

- **Sem autenticação** e **Chave fixa (Bearer)**: o comportamento do servidor da organização,
  agora por servidor do agente. Num turno com cliente, só funcionam com **Usar o servidor de
  ferramentas externo durante o atendimento** ligado, e então o servidor recebe os cabeçalhos
  `X-Deskcomm-Contato-Id`, `X-Deskcomm-Contato-Telefone` e `X-Deskcomm-Canal`.
- O servidor da organização (**Configurações › Servidor MCP externo**) continua funcionando sem
  ação nenhuma, como servidor compartilhado por todos os agentes.

## Evidência

A prova pela tela, numa instalação fresca contra um servidor MCP real com OAuth:

- `evidence/mcp-por-agente-oauth/01-descoberta-oauth-staging-beyond.png`: o cadastro com o resultado da descoberta (authorization server, registro automático, revogação, hosts e escopos)
- `evidence/mcp-por-agente-oauth/02-acesso-na-ficha-do-contato.png`: o acesso autorizado na ficha do contato, com o botão Revogar

## Para quem opera a VPS

Nada a fazer: a migration entra pelo `update.sh` de sempre, o cron entra no `scheduler` e o
endereço de retorno sai do `NEXT_PUBLIC_APP_URL` que a instalação já tem. Nenhuma variável nova.
