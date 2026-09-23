---
impacto: nada_mudou
secao: corrigido
titulo: Duas bibliotecas internas sobem de versão para fechar avisos de segurança
---

O aviso automático de segurança do repositório apontou quatro problemas em bibliotecas que o sistema usa por dentro. Três são da `hono` (que atende chamadas HTTP internas): um pedido malformado podia fazer o serviço consumir memória sem limite, um endereço com fragmento podia confundir cache e proxy, e uma função de exportação ainda escrevia fora da pasta de destino. O quarto é da `js-yaml`, usada só no desenvolvimento do projeto, que podia gastar processador à toa.

As duas subiram para as versões que corrigem tudo isso (`hono` 4.13.8 e `js-yaml` 4.3.2). Nenhuma tela, nenhuma configuração e nenhum comando mudam: quem opera uma VPS só precisa atualizar como de costume.
