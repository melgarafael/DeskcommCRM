---
impacto: nada_mudou
secao: corrigido
titulo: Build de produção recebe a mesma memória já usada na validação de tela
---
Os builds de produção, da imagem e da conferência MySQL passam a usar o mesmo
teto de heap de 6 GB do build e2e. A checagem de tipos continua completa; o ajuste
evita que o crescimento do projeto interrompa a publicação ao atingir o teto
anterior de 4 GB. Nenhuma configuração da instalação precisa mudar.

Contribuição de @ararquitetura.
