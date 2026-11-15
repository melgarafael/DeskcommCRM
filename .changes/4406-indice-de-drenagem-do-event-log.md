---
impacto: nada_mudou
secao: alterado
titulo: A fila de eventos pendentes é lida por um índice próprio
---

O worker que processa a fila de eventos lê os pendentes em ordem de chegada.
Agora essa leitura tem um índice só para ela, e o banco deixa de ordenar a fila
inteira em memória a cada passada, o que pesa em instalações com muitos eventos.
A atualização cria o índice sozinha e não pede nenhuma ação de quem opera a
instalação. Contribuição de @jlom2024 (#4406).
