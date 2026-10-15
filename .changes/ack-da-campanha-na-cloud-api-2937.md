---
impacto: nada_mudou
secao: corrigido
titulo: Entregue e lido das campanhas pela API oficial voltam a chegar ao destinatário
---

Campanha enviada por um número da API oficial ficava com os destinatários em
"enviada" para sempre: as taxas de entrega e de leitura seguiam zeradas mesmo
depois de a mensagem ser entregue e lida no celular do contato, porque o banco
só levava o ack da mensagem ao destinatário quando o status da mensagem mudava —
e na API oficial ele não muda (a entrega e a leitura vão para os carimbos).
Agora o entregue e o lido da API oficial alcançam o destinatário e as taxas da
campanha acompanham, igual ao canal não oficial. A atualização aplica a mudança
de banco sozinha.

Contribuição de @webtecnica (#2946), a partir da issue #2937.
