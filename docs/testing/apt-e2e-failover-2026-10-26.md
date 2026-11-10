# Preparo APT do E2E — troca do espelho lento

Correção própria de CI desenvolvida na triagem de 26/10/2026. Base:
`6c3ec346476cb1fae260dd2ce85d707b2a0e2d87`.

**CONFIRMADO nos logs:** três tentativas de 180 s do ffmpeg podiam consumir
nove minutos baixando do Azure sem completar. O rerun seletivo do #3462 instalou
o mesmo preparo em 12 s; a recorrência em outros heads mostrou que repetir a
mesma fonte não resolvia a causa. O laço limitava o prejuízo, mas não trocava
o transporte que falhou.

O helper compartilhado pelos dois preparos troca a fonte somente depois da
primeira falha APT medida, no runner descartável do GitHub. Reconhece a URL
Azure exata e o `mirror+file:/etc/apt/apt-mirrors.txt` conhecido do runner,
desde que a lista contenha Azure. O destino é o arquivo oficial Ubuntu;
campos de assinatura, suites, componentes, snapshot e preferências permanecem.
Não reescreve comentários, fontes desabilitadas ou endereços desconhecidos.

Erros de assinatura, hash, pacote e dpkg continuam vermelhos imediatamente.
Timeout depois de começar o download do browser é atribuído ao CDN, sem troca
de fonte nem limpeza APT. Fora de `GITHUB_ACTIONS=true` e
`RUNNER_ENVIRONMENT=github-hosted`, não mata processos nem altera fontes.
Após a troca, o próximo orçamento inclui `apt-get update --error-on=any` e a
instalação; não se aceita índice parcialmente atualizado como sucesso.

**Prova local:** corpos reais do workflow com fontes temporárias e shims de
APT/sudo/timeout; nenhum apt da máquina de teste é executado. Antes do ajuste,
o cenário inicial teve 8 falhas e 3 controles verdes. Desativar somente a chamada
de failover tornou os dois cenários positivos vermelhos; o helper foi restaurado
byte a byte. A rodada final passou em seis arquivos de cercas: 62 casos em
23,04 s, um worker, incluindo os 23 casos dos dois arquivos de preparo.
Os casos incluem falha dos dois espelhos, fatal que também parece erro de
download, índice de destino inválido, CDN, executor próprio, Deb822/legado,
mirrorlist, fonte desabilitada, host parecido e preservação do pino/mtime.

ESLint dos testes, Bash dos dois passos/helper, parse do Python e diff check
passaram. Comparação estrutural confirmou que o workflow fora dos dois corpos
`run` é idêntico à base: sete partes, tetos de 30 min por job e 12 min por passo,
três tentativas de 180 s, caches, versões e agregadores permanecem.

**Limite:** a bancada prova o mecanismo e as recusas, não a velocidade futura
de nenhum espelho. Não se rodaram typecheck, build, Docker, banco ou E2E local.
Esta medição não substitui a revisão nem os checks do head publicado.

Referências primárias: [fontes APT no Ubuntu](https://ubuntu.com/server/docs/how-to/software/package-management/),
[sources.list(5)](https://manpages.ubuntu.com/manpages/noble/man5/sources.list.5.html),
[apt-get(8)](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html),
[integridade do arquivo Ubuntu](https://documentation.ubuntu.com/security/software-integrity/archive-verification/)
e [configuração do runner](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-apt-sources.sh).
