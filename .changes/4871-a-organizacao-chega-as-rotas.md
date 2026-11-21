---
impacto: capacidade_nova
secao: adicionado
titulo: Desligar um módulo para uma empresa passa a valer em Configurações › Propostas, na rota de propostas e na tela de Empresas
---
A tela `/admin/sistema` › "Por empresa" já deixava o administrador da instalação desligar um módulo só para um cliente, mas a decisão só aparecia no menu: a lista de propostas em Configurações, a rota `/api/v1/settings/proposals` e a tela de Empresas (pessoas e importação) continuavam respondendo como se o módulo estivesse disponível, porque decidiam apenas pela chave da instalação. Agora essas três portas consultam também a linha da empresa: módulo desligado para ela responde 404, como se não existisse; módulo ligado (ou sem linha nenhuma, que é o caso de quem nunca configurou por empresa) segue exatamente como antes. A instalação continua sendo o teto — desligada lá, nada é liberado pela linha da empresa. Nenhum cliente precisa fazer nada: quem nunca usou o desligamento por empresa não vê diferença nenhuma.
