---
impacto: nada_mudou
secao: corrigido
titulo: A pasta de backups da instalação fica fora do contexto de build das imagens
---

O `backup.sh` do kit grava por padrão em `backups/`, ao lado do código. Essa
pasta agora está no `.dockerignore`, então quem constrói a imagem na própria
VPS (o caminho de emergência) não leva os backups para dentro dela. Quem só
puxa as imagens publicadas não percebe diferença. Contribuição de @World2576
(#4547).
