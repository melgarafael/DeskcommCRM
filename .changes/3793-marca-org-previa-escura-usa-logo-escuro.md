---
impacto: nada_mudou
secao: corrigido
titulo: A tela de Marca da organização mostra o logo escuro na prévia e deixa removê-lo
---

Com o logo claro e o logo escuro da organização salvos, a tela de Marca (`/app/settings/marca`) mostrava o logo claro na prévia "Aparência escura" e não oferecia "Remover logo escuro", como se não houvesse logo escuro gravado. A barra lateral no modo escuro já mostrava o logo certo — o problema era só na tela de configuração, e deixava o administrador sem ver nem remover o logo escuro que gravou.

A prévia da organização montava a camada com o `logo_path` mas sem o `logo_dark_path`; como um logo próprio encerra a herança do par, a arte escura desaparecia da tela. Agora a camada recebe os dois caminhos, igual à tela da instalação (`/admin/marca`), e a prévia escura usa o logo escuro gravado. Nada muda no que já está no banco nem na VPS.
