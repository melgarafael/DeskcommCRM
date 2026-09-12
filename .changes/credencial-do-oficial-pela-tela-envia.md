---
impacto: nada_mudou
secao: corrigido
titulo: O WhatsApp oficial conectado pela tela volta a enviar — sem depender do .env
---

Uma instalação que conectou o número oficial pela **Central de Conexões** guarda a credencial **cifrada no banco** e não escreve nada no `.env` — e as mensagens ficavam paradas na fila, sem erro, com o canal conectado e funcionando na tela.

A pergunta "dá para tentar enviar?" era respondida só pelo `.env`, num ponto que não consegue consultar o banco. Agora quem decide é o próprio envio, que resolve a credencial da sessão primeiro — e o `.env` continua valendo como fallback para instalações antigas de número único. Sem credencial nenhuma, a mensagem fica na fila com o motivo nomeado (em vez de nunca ser tentada); falha na consulta da credencial vira erro visível na mensagem, em vez de silêncio.

Quem já tinha a chave no `.env` não vê diferença nenhuma.
