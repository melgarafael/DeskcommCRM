---
impacto: capacidade_nova
secao: adicionado
titulo: Aviso escrito pelo admin vira push para a equipe
---

O administrador da empresa agora escreve um aviso com título e corpo e o aviso chega como push para os aparelhos da organização, com um toque que abre a caixa de entrada. É um módulo opcional da instalação, **desligado por padrão**: quem administra o servidor liga no painel do administrador, em Recursos opcionais › Módulos opcionais (“Avisos para a equipe”). Desligado, a rota responde 404. Cada aviso criado fica no registro de auditoria (`aviso.created`), com a janela de publicação e sem o texto.

O aviso respeita a janela: `publicar_em` no passado ou ausente publica na hora (ausente grava o relógio do servidor), e `expira_em` no passado é gravado sem tocar em ninguém. O título vai até 120 caracteres e o corpo até 2.000; no push, o corpo sai truncado.

Não há agendamento nesta fatia: nada publica o aviso depois da criação, então um `publicar_em` no futuro é recusado com 400 e a mensagem diz o que fazer — publicar agora ou enviar sem data. Alguns segundos de relógio adiantado no navegador são absorvidos como "agora", e o valor gravado nunca fica à frente do relógio do servidor. A tela de escrever o aviso entra na fatia seguinte; por enquanto a porta é a API (`POST /api/v1/avisos`).

Contribuição de @webtecnica (#1418, fatia 1).
