import {performance} from 'node:perf_hooks';
import {EXPERIMENTAL_CONFIG,buildIndex,buildAuthority,MemoryStore,createPolicyGate,openSession,nextPage,mulberry32} from '../dist/src/feed.js';
const NOW=1795000000000;
const rng=mulberry32(81);
const percentile=(arr,q)=>{const s=[...arr].sort((a,b)=>a-b);return Number(s[Math.floor((s.length-1)*q)].toFixed(2));};
const out=[];
for(const size of [2000,10000,30000]){
 const posts=Array.from({length:size},(_,i)=>({
   id:'p'+i,authorId:'a'+(i%1500),regionId:['lagos','abuja','kano','delta','enugu'][i%5],
   topics:['t'+(i%421),'news'],createdAt:NOW-Math.floor(rng()*86_400_000),
   impressions:100,satisfied:Math.floor(rng()*100),version:1,moderation:'approved',visibility:'public',
   feedEligible:rng()>.1,geo:null,expiresAt:null,minAge:null
 }));
 const cfg=structuredClone(EXPERIMENTAL_CONFIG);
 const viewer={id:'user',regionId:'lagos',age:25,jurisdiction:'NG',interests:['news','t3','t5','t8'],
   hiddenAuthors:[],hiddenPosts:[],blockedAuthors:[],blockedBy:[],exposures:{}};
 const ts=performance.now();const index=buildIndex(posts,cfg,NOW);const indexMs=performance.now()-ts;
 const records=new Map(posts.map(p=>[p.id,p]));const policies=new Map([['user',viewer]]);
 const auth=buildAuthority(records,policies);const store=new MemoryStore();const deps={index,authority:auth,store,gate:createPolicyGate(cfg.futureSkewMs),cfg};
 const opening=[],page=[];let localServed=0,remoteServed=0;
 for(let i=0;i<20;i++){
   const v={...viewer,id:'user'};
   const time=performance.now();const s=await openSession(deps,v,{surface:'home',now:NOW},{seed:i+1});opening.push(performance.now()-time);
   const t=performance.now();const result=await nextPage(deps,s,v,{surface:'home',now:NOW},20);page.push(performance.now()-t);
   localServed+=result.filter(x=>x.post.regionId===v.regionId).length;
   remoteServed+=result.filter(x=>x.post.regionId!==v.regionId).length;
 }
 out.push({posts:size,indicesMs:Number(indexMs.toFixed(2)),openP50Ms:percentile(opening,.5),openP95Ms:percentile(opening,.95),pageP50Ms:percentile(page,.5),pageP95Ms:percentile(page,.95),localServed,remoteServed});
}
console.log(JSON.stringify({environment:{runtime:process.version,store:'in-memory reference',samplesPerSize:20},results:out},null,2));
