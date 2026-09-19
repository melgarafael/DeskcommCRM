---
impacto: capacidade_nova
secao: adicionado
titulo: Telefonia por SIP com atendimento por IA, como módulo que você liga quando quiser
---
O CRM passa a atender e fazer ligações de telefone de verdade, por um tronco SIP, com a IA conduzindo a conversa por voz e a transcrição ficando no histórico do contato. Os números que recebem ligação são cadastrados em Conexões › Telefone, cada um apontando para um agente de voz, e as chamadas aparecem em Chamadas, na mesma lista das ligações por WhatsApp.

Quem não usa telefone não recebe nada disso: o módulo nasce DESLIGADO. São dois contêineres novos num profile do compose que só existe se você escrever `telefonia` em `COMPOSE_PROFILES` no `.env` — sem isso o sistema sobe exatamente como hoje, sem porta nova aberta, sem contêiner extra e sem consumo de memória a mais. Para ligar, o `.env.example` traz o passo a passo, e as credenciais do seu provedor SIP ficam em Configurações › Trunk SIP.

Quando o módulo está ligado, as portas de voz (UDP 5060 e 10000-10200) passam a ser publicadas, porque é o provedor do tronco que precisa alcançá-las; a interface que controla as chamadas continua fechada, só na rede interna do servidor.
