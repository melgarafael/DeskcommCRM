---
impacto: capacidade_nova
secao: adicionado
titulo: O prazo para o cliente abrir o link de autorização do servidor MCP é configurável
---

O cadastro do servidor MCP do agente ganhou o campo **Prazo para abrir o link de autorização (minutos)**, ao lado da retenção: de 10 a 1440 minutos, com 10 como padrão. Quem não mexer no campo fica exatamente como estava — o link vale 10 minutos. Quem aumentar (por exemplo 1440, um dia) resolve os dois casos da issue: quem lê a mensagem horas depois e caía em "Link expirado", e quem abre o link no 8º minuto e era recusado na volta, depois de preencher tudo, porque o prazo antigo já tinha estourado.

Nada mais do fluxo mudou: o `state` continua de uso único e 256 bits, o PKCE S256, o endereço de retorno fixo por servidor e a revogação depois do encerramento da conversa seguem iguais, e pedido vencido continua sendo recusado tanto na abertura quanto no retorno — o prazo maior só aumenta a janela em que o link pode ser aberto. Não há migration: a preferência fica no `oauth_metadados` que já existia no cadastro.
