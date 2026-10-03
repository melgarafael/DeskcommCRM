---
impacto: nada_mudou
secao: corrigido
titulo: Suspender uma empresa passa a calar a IA e os envios dela; quem tem acesso só de leitura ao painel deixa de poder alterar dados
---

Até aqui, suspender uma empresa em Admin › Empresas só tirava as pessoas da tela. A IA continuava respondendo aos clientes, o follow-up e as automações seguiam disparando, e o token de API e o MCP da empresa continuavam funcionando. Agora a suspensão suspende: nada que custe dinheiro ou saia para fora roda enquanto ela durar, e o que estava na fila para sair é descartado na hora em vez de sair depois.

As mensagens que chegam continuam gravadas, as páginas de anúncio e o link de rastreio seguem no ar, e pelo MCP a consulta aos pedidos de LGPD continua respondendo — as demais ferramentas do MCP recusam, e a API responde com um erro claro (403 `org_suspended`), pelo token ou pela tela. Quem entra numa empresa suspensa, ou já estava com o CRM aberto na hora, cai numa tela que diz o que fazer. Quem administra vê os pedidos de LGPD dos clientes, que não param durante a suspensão (o link do e-mail de prazo abre o pedido ali mesmo), e o contato do suporte quando o e-mail de suporte da instalação estiver configurado (`SUPPORT_EMAIL`); sem ele, a tela orienta a falar com quem administra o sistema. As demais pessoas leem que devem avisar o administrador, e quem participa de outra empresa ativa volta para ela com um clique.

Ao reativar, nada sai em rajada: a Central mostra um aviso com quantas conversas receberam mensagem durante a suspensão e leva ao Inbox, porque a IA não vai respondê-las sozinha. Os follow-ups em andamento ficam parados enquanto a suspensão durar e, ao reativar, retomam de onde pararam; o passo cujo envio foi descartado na suspensão ganha um envio novo, no ritmo normal da fila. Quem tem acesso só de leitura ao painel da instalação deixa de conseguir suspender, reativar ou alterar o estado de uma empresa, pela tela ou pela API, e também deixa de mudar configurações ou apagar dados de uma empresa em que é só participante. Nenhuma ação é necessária.
