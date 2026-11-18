import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const files = [
  ...readdirSync('dist/tests').filter(n => n.endsWith('.test.js')).map(n => join('dist/tests',n)),
  ...readdirSync('test').filter(n => n.endsWith('.test.mjs')).map(n => join('test',n)),
];
const result = spawnSync(process.execPath, ['--test','--test-reporter=tap',...files], {
  cwd: process.cwd(), encoding:'utf8', maxBuffer: 40*1024*1024,
});
const report=(result.stdout??'') + (result.stderr??'');
mkdirSync('reports',{recursive:true});
writeFileSync('reports/regression.tap',report,'utf8');
const count=k=>Number(report.match(new RegExp(`^# ${k} (\\d+)$`,'m'))?.[1]??NaN);
console.log('Dlope unified regression suite (12:41 + 13:16 hardening)');
for(const k of ['tests','pass','fail','cancelled','skipped','todo']) console.log(`${k.padEnd(10)} ${count(k)}`);
console.log('Full TAP report: reports/regression.tap');
if(result.error)console.error(result.error);
if(result.status!==0 || count('fail')!==0 || count('tests')!==4570 || count('todo')!==2){
 console.error(report.split('\n').filter(l=>/^not ok |^\s+error:|^\s+code:/.test(l)).slice(0,80).join('\n'));
 process.exitCode=result.status||1;
}
