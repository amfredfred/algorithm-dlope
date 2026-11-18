import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const result=spawnSync(process.execPath,['--test','--test-reporter=tap'],{
  cwd:process.cwd(),encoding:'utf8',maxBuffer:32*1024*1024,
});
const report=(result.stdout??'')+(result.stderr??'');
writeFileSync('test-report.tap',report,'utf8');
const count=(name)=>Number(report.match(new RegExp(`^# ${name} (\\d+)$`,'m'))?.[1]??NaN);
const keys=['tests','pass','fail','cancelled','skipped','todo'];
console.log('\nDLOPE — 12:41 TYPE-CORRECTED BASELINE\n');
for(const k of keys)console.log(`${k.padEnd(10)} ${count(k)}`);
console.log('\nFull output: test-report.tap');
if(result.error)console.error(result.error);
if(result.status!==0||count('fail')!==0){
 console.error('\nFailure excerpts:');
 console.error(report.split('\n').filter(l=>/^not ok |^\s+error:|^\s+code:|^\s+message:/.test(l)).slice(0,60).join('\n'));
 process.exitCode=result.status??1;
}
