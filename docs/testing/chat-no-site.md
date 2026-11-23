# Roteiro de prova pela tela — Chat no site (F2-A)

> Prova dirigida pelo navegador (Playwright), banco fresco do `supabase/baseline.sql`,
> variáveis opcionais ausentes, estado real de uma instalação nova. Cada caso mede o
> que a tela mostra, não o que o código afirma.

## Contexto

O módulo `canal_webchat` nasce desligado. A prova precisa, portanto, de um administrador
que o ligue em Administração › Recursos opcionais antes de criar a conexão em Conexões.

## Casos

| # | Caso | Expectativa |
|---|------|-------------|
| C1 | Módulo desligado → nenhuma diferença | Sem aba "Chat no site" em Conexões; `/chat/<chave>` e `/api/v1/webchat/*` respondem 404; nenhum script servido |
| C2 | Ligar o módulo e criar a conexão | A aba "Chat no site" aparece em Conexões; cadastrar domínio de um servidor de teste gera a chave `wck_...` |
| C3 | Colar o script numa página local | A bolha aparece no canto da página; abrir a janela carrega `/chat/<chave>` |
| C4 | Conversar como visitante | Aceitar o aviso de LGPD (com controlador e link de política), digitar nome/telefone se a coleta exigir, enviar uma mensagem; a conversa aparece no Inbox com o selo "Chat no site" |
| C5 | Responder pela Inbox | A resposta do atendente chega à janela do visitante pelo stream de eventos |
| C6 | Site fora da lista de domínios | O iframe não carrega (`frame-ancestors` não inclui a origem); só o link direto abre |
| C7 | Girar a chave | Páginas com o código antigo recebem "chat indisponível" ao abrir uma conversa nova; quem já está conversando segue até a sessão expirar |
| C8 | Pausar o chat | Pela rota de administração (PATCH `config.pausado: true`); as três rotas públicas (`/sessao`, `/mensagens`, `/eventos`) dão o mesmo 404; a janela mostra "chat indisponível" |
| C9 | Retomar o chat | PATCH `config.pausado: false` volta a funcionar: sessão, mensagens e eventos respondem normalmente |

## Evidência

Capturas em `evidence/chat-no-site/` (não versionadas neste PR): bolha fechada, bolha aberta,
janela com aviso de LGPD, conversa no Inbox com selo, resposta na janela, 404 com chat pausado.

## O que não está neste roteiro

- Formatos da janela (painel, embutido, página inteira) — F2-B (Tarefa 9)
- Horário de atendimento (janela por dia, feriado, fora do expediente) — F3 da issue #1333
- Teto do visitante anônimo — F4 da issue #1333
