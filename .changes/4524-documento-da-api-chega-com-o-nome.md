---
impacto: capacidade_nova
secao: corrigido
titulo: Documento enviado pela API chega no WhatsApp com o nome do arquivo, não com "file"
---

Pela API (`POST /api/v1/messages` com `media_url`), um documento chegava ao
WhatsApp chamado `file`: o envio não levava nome nenhum, e o nome era escolhido
pelo canal. No celular, um PDF chamado `file` parece arquivo suspeito, e quem
recebe hesita em abrir.

Agora o nome que o destinatário vê é, nesta ordem: o campo novo e opcional
`media_filename`; na falta dele, o `metadata.media_filename` — a mesma chave que
a ingestão já grava e que o cartão do Inbox já mostra; na falta dos dois, o
último segmento da `media_url`, quando ele tem extensão (`.pdf`, `.docx`); e por
fim um nome de reserva legível, como `documento.pdf`. O nome é limpo antes de
sair: acento e espaço passam, `../` não atravessa, caractere que o sistema de
arquivos recusa sai, nome vazio ou gigante vira a reserva (a extensão sobrevive
ao corte), e nada disso vira erro de envio. O arquivo no armazenamento continua
onde estava, com a mesma chave — muda só o rótulo.

O campo é **aditivo**: quem já chama a API sem ele não precisa mudar nada, e a
requisição antiga continua entrando e saindo como antes. Se a sua integração
quiser controlar o nome, é só mandar `media_filename` no corpo.

O envio manual de documento pelo Inbox (o anexo escolhido na tela) é outro
caminho, tratado na #4457 por outra pessoa, e não foi tocado aqui.
