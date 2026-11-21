---
impacto: nada_mudou
secao: corrigido
titulo: A publicação recusa imagem cujo servidor e estáticos venham de builds diferentes
---

A imagem `1.118.0` do serviço principal foi publicada com dois builds dentro dela: o servidor Next dizia que o build era `L0Ae8OxIf-v2KzwJoCU0E` e os arquivos estáticos eram de `K2qYwFMofIRXoOdBpIUbx`. O Next embute o identificador do build no caminho de cada chunk que o HTML carrega, então as telas pediam arquivos que não existiam naquela imagem. O login, a caixa de entrada e os Funis quebravam com erro de carregamento de chunk, com o contêiner de pé e o `/health` respondendo normalmente — nenhum gate do pipeline olhava para isso.

A causa foi medida no log da publicação: o cache de build do GitHub veio incompleto (`blob … not found`), o `pnpm build` foi reexecutado do zero e as duas cópias do artefato — o servidor e os estáticos — foram servidas de momentos diferentes do cache. Uma de cada build, a imagem com as duas.

Agora os estáticos viajam dentro do mesmo diretório que o servidor, copiado uma vez só, e a esteira confere os dois identificadores dentro da imagem antes de deixar a publicação seguir: se não baterem, a esteira reprova, a versão pública e o canal `stable` não são criados e a imagem não chega a quem instala. A verificação também roda no PR, quando a imagem é construída sem ser publicada.

Nada muda para quem já tem o produto instalado: a `1.117.0` está íntegra e a atualização não exige passo nenhum. Republicar a `1.118.0` é ato do mantenedor no registro de imagens dele.
