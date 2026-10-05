import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error('Rode via pnpm test:db.');
function sql(script: string): string {
  return execFileSync('docker', ['exec','-i',container!, 'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-tA','-f','-'],
    { input: script, encoding: 'utf8' }).trim();
}
const ultima = (s: string) => s.split('\n').pop() ?? '';
const A = '05010501-0000-4000-8000-00000000000a';
const B = '05010501-0000-4000-8000-00000000000b';
const UA = '05010501-1111-4000-8000-00000000000a';
const UB = '05010501-1111-4000-8000-00000000000b';
const RA = '05010501-2222-4000-8000-00000000000a';
const RB = '05010501-2222-4000-8000-00000000000b';

beforeAll(() => sql(`
  insert into auth.users(id,email) values ('${UA}','jev-dec-a@invariant.test'),('${UB}','jev-dec-b@invariant.test') on conflict do nothing;
  insert into public.organizations(id,slug,legal_name,display_name) values
    ('${A}','jev-dec-a','Jev decisões A','Decisões A'),('${B}','jev-dec-b','Jev decisões B','Decisões B') on conflict(id) do nothing;
  insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
    ('${UA}','${A}','agent',now()),('${UB}','${B}','agent',now()) on conflict do nothing;
  insert into public.jev_router_decisions(organization_id,router_id,modo,context_message_count,origem,tempo_total_ms)
    select '${A}','${RA}','jev_sob_demanda',8,'jev',100 where not exists
      (select 1 from public.jev_router_decisions where organization_id='${A}');
  insert into public.jev_router_decisions(organization_id,router_id,modo,context_message_count,origem,tempo_total_ms)
    select '${B}','${RB}','jev_comparacao',4,'jev',200 where not exists
      (select 1 from public.jev_router_decisions where organization_id='${B}');
`));

describe('decisões do roteador JEV no banco instalado', () => {
  it.each([[UA,A,B],[UB,B,A]])('um membro lê somente a própria organização', (usuario, propria, outra) => {
    const leitura = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${usuario}"}',false);
      select count(*) from public.jev_router_decisions where organization_id='${propria}';
      select count(*) from public.jev_router_decisions where organization_id='${outra}';
      select count(*) from public.jev_router_decisions;`);
    expect(leitura.split('\n').slice(-3)).toEqual(['1','0','1']);
  });

  it('sessão autenticada não forja revisão nem decisão', () => {
    expect(ultima(sql(`select has_table_privilege('authenticated','public.jev_router_decisions','INSERT')::int::text ||
      has_table_privilege('authenticated','public.jev_router_decisions','UPDATE')::int::text ||
      has_table_privilege('authenticated','public.jev_router_decisions','DELETE')::int::text;`))).toBe('000');
    expect(ultima(sql(`select has_table_privilege('anon','public.jev_router_decisions','SELECT')::int;`))).toBe('0');
  });

  it('poda compartilhada respeita o piso de 30 dias', () => {
    sql(`insert into public.jev_router_decisions(organization_id,router_id,modo,context_message_count,origem,tempo_total_ms,created_at)
      values ('${A}','${RA}','jev_sob_demanda',8,'jev',100,now()-interval '40 days'),
             ('${A}','${RA}','jev_sob_demanda',8,'jev',100,now()-interval '10 days');`);
    sql('select public.fn_expurgar_observacoes_do_jev(1,1000);');
    expect(ultima(sql(`select count(*) from public.jev_router_decisions where organization_id='${A}' and created_at < now()-interval '30 days';`))).toBe('0');
    expect(Number(ultima(sql(`select count(*) from public.jev_router_decisions where organization_id='${A}';`)))).toBeGreaterThanOrEqual(2);
  });
});
