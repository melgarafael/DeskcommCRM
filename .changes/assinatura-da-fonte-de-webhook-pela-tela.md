---
impacto: capacidade_nova
secao: adicionado
titulo: A assinatura (HMAC) de uma fonte de captação agora se liga pela tela
---

Cada fonte de captação (Automações › Fontes) tem um endereço próprio, e até agora
era só esse endereço que protegia a entrada de contatos: quem o descobrisse — num
log do proxy, no histórico do navegador, num print — conseguia criar leads na sua
conta. O produto já sabia exigir assinatura nesse endereço, mas não havia onde
configurá-la, então nenhuma fonte criada pela tela nascia protegida.

No painel da fonte há agora a seção "Assinatura (HMAC)". Quem administra gera um
segredo com um clique, vê o valor uma única vez para copiar e guardar, e a partir
daí o endereço passa a recusar qualquer envio que não venha assinado por quem tem
esse segredo. Dá para trocar o segredo (avisando que as integrações antigas param
até serem atualizadas) e para removê-lo, voltando ao estado anterior. O valor
aparece uma vez e não é mostrado de novo: o sistema guarda apenas uma versão
cifrada dele, que serve para conferir os envios e não para exibir — nem para
quem opera o servidor. Perdeu o segredo, o caminho é gerar outro.

Quem envia os dados assina o corpo da requisição com HMAC-SHA256 e manda o
resultado em hexadecimal no cabeçalho `X-Deskcomm-Signature`. Com a assinatura
ligada, o botão "Enviar lead de teste" sai de cena: o teste passa a ser feito do
sistema que envia os dados, que é quem tem o segredo.

Contribuição de @maclevison.
