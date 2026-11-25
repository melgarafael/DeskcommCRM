---
impacto: nada_mudou
secao: corrigido
titulo: A leitura da agenda não trava mais quando um evento cancelado do produto ficou sem compromisso
---

Quando o compromisso que publicou um evento no Google é excluído, o Google continua devolvendo esse evento como cancelado, só que sem par no banco. A leitura da agenda tratava isso como erro e derrubava a página inteira: a conexão ficava com "A leitura não terminou" para sempre, inclusive na leitura completa e depois de reconectar. Agora esse evento cancelado é descartado e a leitura segue normalmente; evento do produto que ainda ocupa horário e ficou sem compromisso continua sendo recusado, mas a tela diz o dia e a hora do evento e pede para corrigir ou remover no Google Agenda, em vez da frase genérica. O log da leitura também passa a levar essa frase.
Contribuição de @yunshu0909, a partir da issue #5109.
