---
impacto: exige_acao
secao: alterado
titulo: A assinatura do ChatGPT passa a funcionar nos agentes, com login próprio e lista de modelos por empresa
---
A conexão **OpenAI pela assinatura (ChatGPT)** passa a usar o "Sign in with ChatGPT" para apps
instalados no próprio servidor, em vez do login emprestado do Codex. A tela de credenciais mostra
os modelos que a assinatura de cada empresa libera, e o **Publicar** do agente confere o modelo
contra essa lista da empresa — antes ele conferia contra a lista geral e recusava a publicação.
Contribuição de @omayklourenco.

## Requer atenção

Empresas que conectaram a assinatura do ChatGPT antes desta versão precisam conectar de novo:
abra **IA › Credenciais**, use o link de conexão da assinatura e entre com a mesma conta. Até
isso ser feito, a tela avisa que o login anterior ainda não autorizou o uso do plano e o agente
não usa a assinatura (se houver chave de API da empresa configurada como reserva, ela segue
atendendo). Nenhum arquivo precisa ser editado.
