# Site de apresentação escreve.ai

Página estática e responsiva, no mesmo repositório do CRM. Dados do demonstrativo são fictícios. Botões de acesso apontam para `crm.escreve.ai`; o aplicativo Conversa permanece acessível no rodapé.

## Desenvolvimento

Na pasta `website`, execute `npx wrangler dev`. A publicação usa `npx wrangler deploy` com uma sessão Cloudflare autorizada. Nunca commite credenciais.

## Rotas e preservação

O Worker serve somente GET/HEAD `/` e `/_escreve/logo.png`. Outras requisições são encaminhadas à origem existente. DNS, MX, APIs e subdomínios não são substituídos.

As rotas de produção são geridas na Cloudflare. O antigo redirecionamento da raiz para Conversa precisa ficar desativado para que esta página seja exibida. Reativá-lo restaura o comportamento anterior da entrada, sem alterar os aplicativos.

## Verificação

Conferir desktop e mobile, os três botões da demonstração, abertura das perguntas frequentes, links de cadastro/login e acesso ao Conversa. Esta página não coleta formulários nem dispara mensagens.

Verificação automatizada: `node website/check-routing.mjs` cobre 42 combinações de método e caminho, incluindo preservação de corpo e cabeçalhos nas rotas legadas.
