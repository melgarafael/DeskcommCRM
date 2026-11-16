---
impacto: nada_mudou
secao: corrigido
titulo: O anexo do card criado em outro funil não duplica, e a automação repõe o que faltou
---

Quando um negócio ganho abria o card de pós-venda em outro funil, os anexos da
origem (o voucher, a apólice) eram copiados uma vez só. Se o armazenamento de
arquivos falhasse naquele instante, o card novo ficava sem o documento para
sempre: a regra rodava de novo, via que o card já existia e não tentava copiar.
E, quando a cópia era repetida, o mesmo anexo entrava duas vezes.

Agora cada cópia guarda de qual anexo da origem ela veio. A regra que encontra o
card já criado volta a copiar só o que falta, e o que já está lá não entra de
novo, nem quando duas execuções correm ao mesmo tempo. Essa reposição só acontece
quando o card novo tem o mesmo responsável do card de origem: assim ninguém passa
a ver um documento que não via. Apagar o anexo da origem não apaga a cópia do
card novo. As cópias feitas antes desta versão são reconhecidas na atualização e
também não entram de novo. Nenhuma ação é necessária na atualização.
Contribuição de @webtecnica (#4646).
