# Agenda do Outlook (Microsoft 365 e conta pessoal)

O horário ocupado no Outlook de cada pessoa deixa de ser oferecido no CRM. Vem desligado.

## O que faz e o que não faz

| Faz | Não faz (ainda) |
|---|---|
| cada pessoa conecta a própria conta | escrever compromisso no Outlook |
| lê o ocupado das agendas marcadas, de ontem a 90 dias | link do Teams |
| relê cada agenda a cada 5 minutos | aviso imediato de mudança (webhook do Graph) |
| desconectar apaga tokens, agendas e ocupação lida | agendas compartilhadas por outra pessoa |

O assunto, o corpo e os convidados dos eventos não são lidos nem guardados.

## Ligar (quem administra a instalação, uma vez)

1. Em <https://entra.microsoft.com> › Registros de aplicativo › Novo registro.
2. Tipos de conta: "qualquer diretório organizacional e contas pessoais" (ou só o seu diretório).
3. Autenticação › adicionar plataforma **Web** com o endereço mostrado em **Administração › Agenda do Outlook**
   (`https://SEU-DOMINIO/api/v1/agenda/microsoft/callback`).
4. Permissões de API › Microsoft Graph › delegadas: `User.Read`, `Calendars.Read`, `offline_access`.
5. Certificados e segredos › novo segredo do cliente. Copie o **Valor** (não o ID do segredo).
6. Na tela do CRM, cole o ID do aplicativo, o valor do segredo e, se o app for de um diretório só,
   o ID do diretório.

## Conectar (cada pessoa)

Agenda › **Conectar Outlook** › entrar com a própria conta › aceitar. A agenda principal passa a contar;
as outras se marcam em Configurações › Agenda › Contas e calendários do Outlook.

## Quando algo não funciona

| Sintoma | Causa provável |
|---|---|
| "o administrador de TI aprove o aplicativo" | o diretório da empresa bloqueia consentimento do usuário. A TI precisa conceder |
| pessoas de **outras** empresas não conseguem autorizar | app multilocatário sem verificação de editor |
| `redirect_uri` recusado | o endereço registrado difere do mostrado na tela, byte a byte |
| todas as contas pedem reconexão | o segredo do cliente venceu; gere outro e salve na tela |
| "precisa ser reconectada" numa conta só | senha trocada ou acesso revogado; a pessoa reconecta. O que já foi lido continua bloqueando |
