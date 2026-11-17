---
impacto: nada_mudou
secao: corrigido
titulo: A imagem do catálogo no PDF passa a julgar o endereço que o nome resolve
---

A foto do item de catálogo vai para o PDF e quem a busca é o servidor, no react-pdf, mas a única guarda naquele caminho lia o TEXTO do endereço: um domínio público apontando para a rede interna (ou para o serviço de metadados da nuvem, que entrega credencial de instância) passava por ela e era buscado de dentro do servidor. Agora a imagem também passa pelo julgamento do endereço resolvido, o mesmo que o webhook de saída já usa desde que a dívida foi paga lá — e continua valendo que uma imagem inalcançável só deixa o item sem foto, nunca barra o envio da proposta.

Contribuição de @webtecnica (#4685).
