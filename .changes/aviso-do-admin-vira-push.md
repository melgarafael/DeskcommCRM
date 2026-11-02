---
impacto: capacidade_nova
secao: adicionado
titulo: Aviso escrito pelo admin vira push para a equipe
---

O administrador da empresa agora escreve um aviso com título e corpo e o aviso chega como push para os aparelhos da organização, com um toque que abre a caixa de entrada. O aviso respeita a janela: `publicar_em` no passado ou ausente publica na hora, e `expira_em` no passado é gravado sem tocar em ninguém.

Não há agendamento nesta fatia: nada publica o aviso depois da criação, então um `publicar_em` no futuro é recusado com 400 e a mensagem diz o que fazer — publicar agora ou enviar sem data. Alguns segundos de relógio adiantado no navegador são absorvidos como "agora", e o valor gravado nunca fica à frente do relógio do servidor. A tela de escrever o aviso entra na fatia seguinte; por enquanto a porta é a API (`POST /api/v1/admin/avisos`).

Contribuição de @webtecnica (#1418, fatia 1).
