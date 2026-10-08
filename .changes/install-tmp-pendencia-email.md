---
impacto: nada_mudou
secao: corrigido
titulo: O instalador não deixa mais um arquivo temporário em /tmp a cada execução
---

Cada vez que o `install.sh` passava do passo dos e-mails de acesso, ficava em
`/tmp` um arquivo `tmp.*` com o aviso desse passo — um por execução, e nada os apagava.
Agora o arquivo é apagado quando o instalador termina, seja com a instalação
concluída, com o app ainda sem responder ou parando no meio. O aviso continua
aparecendo na tela final como antes. Os arquivos deixados por execuções
anteriores não são apagados: quem quiser pode removê-los à mão.
