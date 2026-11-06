---
impacto: nada_mudou
secao: alterado
titulo: Os guias escolhem a região do Supabase pela distância até a VPS
---

Os guias de instalação mandavam criar o projeto Supabase em **São Paulo** sem
dizer por quê. Quem hospeda o CRM numa VPS nos EUA ou na Europa seguia a
orientação e ficava com cada consulta atravessando o continente — em toda tela e
em todo turno do agente, porque um projeto Supabase não se muda de região depois
de criado.

Agora os quatro guias pedem a região **mais próxima da VPS**, avisam que a
escolha é definitiva e mostram como fazê-la pelo kit (`SUPABASE_REGION` ou o
segundo argumento do `supabase-provision.sh`, como em
`bash supabase-provision.sh "Nome" us-east-1`).

Nada muda no produto: só a documentação de instalação.
