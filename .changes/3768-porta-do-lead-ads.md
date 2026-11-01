---
impacto: capacidade_nova
secao: adicionado
titulo: Formulário instantâneo da Meta ganha endereço de recebimento, com as respostas buscadas na origem
---

Uma fonte de captação cadastrada em Webhooks ganhou um endereço próprio para receber o aviso de formulário preenchido da Meta, aceito só com a assinatura do App da Meta da instalação (comparada por tempo constante) e verificado pelo `GET` de desafio que a Meta usa para aprovar a URL.

O aviso da Meta chega sem as respostas: traz o `leadgen_id` e os ids de página, formulário e anúncio. Por isso a fonte tem uma opção — **desligada por padrão** — de buscar as respostas na Graph API, com um token de página guardado cifrado (nunca devolvido pela API, só o fato de existir), colado por quem administra a organização. Desligada, o aviso sem respostas é registrado como ignorado com motivo nomeado; ligada e sem token, o mesmo. Em nenhum dos casos o lead entra com dado inventado.

Com as respostas na mão, o lead vira contato (reaproveitando a ficha que já existe, pelo telefone normalizado) e card na etapa configurada da fonte, com nome, telefone, e-mail e as demais respostas nos campos do negócio, e a origem "Meta_ads" marcada no card.

O dono do lead é a **página**: a Meta tem uma URL de destino só para o objeto `page`, então o aviso é roteado pelo `page_id` para a fonte que reivindica aquela página, e não pelo token do endereço. Aviso de página que nenhuma fonte reivindica é registrado como ignorado, e não entra na fonte errada.

Entrega que chega atrasada **entra**, com a idade marcada no rastro da captação: a Meta reentrega por horas, e recusar uma reentrega assinada perdia o lead de vez. O mesmo aviso entregue duas vezes responde como duplicado e não cria segundo contato nem segundo card.

Ainda fora: conectar a conta por tela, listar os formulários e sincronizar campanhas. Contribuição de @webtecnica (#3768).
