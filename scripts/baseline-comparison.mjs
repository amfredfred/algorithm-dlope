import * as old from '../baseline/feed-original.mjs';
import * as fixed from '../dist/src/feed.js';
const now=1780000000000, c={now,surface:'home'};
const cfg={...structuredClone(fixed.EXPERIMENTAL_CONFIG)};
const v={id:'v',regionId:'local',jurisdiction:'NG',age:26,interests:['news'],hiddenAuthors:[],
 hiddenPosts:[],blockedAuthors:[],blockedBy:[],exposures:{}};
const p=(id,regionId,eligible,satisfied,authorId='author'+id)=>({id,regionId,authorId,
 topics:['news'],createdAt:now-3000,impressions:1000,satisfied,version:1,visibility:'public',
 moderation:'approved',geo:null,expiresAt:null,minAge:null,feedEligible:eligible});
const posts=[...Array.from({length:1200},(_,i)=>p('bad'+i,'local',false,990)),
 ...Array.from({length:100},(_,i)=>p('local'+i,'local',true,20)),
 ...Array.from({length:200},(_,i)=>p('cross'+i,'remote',true,800))];
async function run(mod){
 const store=new mod.MemoryStore(),deps={index:mod.buildIndex(posts,cfg,now),
  authority:mod.buildAuthority(new Map(posts.map(x=>[x.id,x])),new Map([['v',v]])),
  store,gate:mod.createPolicyGate(cfg.futureSkewMs),cfg};
 const s=await mod.openSession(deps,{...v},c,{seed:42});
 return {ranked:s.order.length,local:s.order.filter(x=>x.id.startsWith('local')).length,
   cross:s.order.filter(x=>x.id.startsWith('cross')).length,
   banned:s.order.filter(x=>x.id.startsWith('bad')).length};
}
const badGeo={...p('x','local',true,100),geo:{deny:[1]}};
console.log(JSON.stringify({
 baseline1316:await run(old),hardened:await run(fixed),
 malformedGeo:{baseline:old.createPolicyGate(cfg.futureSkewMs)(v,c)(badGeo),
   hardened:fixed.createPolicyGate(cfg.futureSkewMs)(v,c)(badGeo)}
},null,2));
