---
impacto: nada_mudou
secao: corrigido
titulo: Janelas (Dialog) com conteúdo alto rolam por dentro, e os botões ficam alcançáveis
---

O `DialogContent` base ganhou `max-h-[calc(100dvh-2rem)]` e `overflow-y-auto`:
qualquer janela que cresça com dados do usuário (ex.: campos personalizados de um
contato) passa a rolar por dentro em vez de deixar o rodapé da tela. Quem já
passava um `max-h` próprio continua com ele prevalecendo (o `cn()` usa
`twMerge`). Sem ação necessária.