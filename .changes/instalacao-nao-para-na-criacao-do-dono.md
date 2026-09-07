---
impacto: nada_mudou
secao: corrigido
titulo: A instalação não para mais no passo de criar o primeiro administrador
---

Instalar numa VPS podia falhar bem no fim, ao criar o primeiro administrador,
com uma mensagem de erro do banco de dados. Quando acontecia, o banco já estava
montado e as configurações já estavam gravadas — a instalação parava com tudo
quase pronto e a tela oferecendo recomeçar do zero.

O passo foi corrigido e o instalador passa a verificar isso sozinho antes de
publicar uma versão nova, para que a falha não volte.
