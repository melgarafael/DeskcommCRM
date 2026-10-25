---
impacto: nada_mudou
secao: corrigido
titulo: Funis: o seletor de tipo não corta mais os rótulos longos
---

Em Configurações › Funis, o botão "Tipo do campo" tinha 8rem e cortava "Lista de várias escolhas" e "Lista de varias opciones" sem reticências. A coluna passa a 13rem (18px de folga sobre o maior rótulo em espanhol) e o gatilho ganha o rótulo inteiro no `title`. Abaixo de 1024px os campos da linha empilham, para a Chave e o Rótulo não ficarem espremidos no tablet com a barra lateral aberta.

Contribuição de @Tong-bit-art (#3340), a partir da issue #3099.
