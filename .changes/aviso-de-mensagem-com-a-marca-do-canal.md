---
impacto: capacidade_nova
secao: adicionado
titulo: O aviso de mensagem nova mostra de qual canal a mensagem veio
---

Quando a mensagem chegava, o aviso da esquina era sempre o mesmo bloco neutro:
para saber se o cliente escreveu pelo WhatsApp, pelo Instagram ou pelo Messenger
era preciso abrir a conversa. Agora o aviso leva a **marca do canal** — o logo da rede e uma
faixa de 3px na borda esquerda, na cor daquele canal — para que a origem se
reconheça de relance.

A faixa é uma marca, não um fundo pintado: o toast continua com o fundo do tema,
então o texto não perde contraste no modo escuro e dez avisos seguidos não viram
dez blocos coloridos. As cores de cada rede são tokens do produto, desenhados
separadamente para o tema claro e o escuro, e todos passam no piso de contraste
para elementos de interface.

Para quem não enxerga cor, o canal também vai em texto: o leitor de tela anuncia
"Canal: WhatsApp" (ou o nome da rede que veio) junto com o título da mensagem.
Canal que o produto ainda não sabe desenhar não inventa logo: o aviso sai com a
faixa neutra e o rótulo genérico, e os demais avisos do sistema (lead, menção,
exportação) continuam exatamente como eram.
