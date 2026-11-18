import {readFileSync,writeFileSync} from 'node:fs';
import {EXPERIMENTAL_CONFIG as BASE,buildIndex,buildAuthority,MemoryStore,createPolicyGate,openSession,nextPage} from '../dist/src/feed.js';
const data=JSON.parse(readFileSync(new URL('../fixtures/dummies.json',import.meta.url),'utf8'));
const now=data.now,cfg=structuredClone(BASE);
const posts=data.posts.map(p=>({...p,version:1,moderation:p.eligible?'approved':'removed',
 visibility:'public',geo:null,expiresAt:null,minAge:null,feedEligible:true}));
const result={fixture:{posts:posts.length,eligible:posts.filter(p=>p.moderation==='approved').length,
  topics:new Set(posts.flatMap(p=>p.topics)).size,regions:new Set(posts.map(p=>p.regionId)).size,
  originalViewerRegion:data.viewer.regionId},byViewerRegion:[]};
const regions=[data.viewer.regionId,...new Set(posts.map(p=>p.regionId))];
for(const region of regions){
 const v={id:'v',regionId:region,jurisdiction:'NG',age:26,interests:data.viewer.interests,
  hiddenAuthors:data.viewer.hiddenAuthors,hiddenPosts:[],blockedAuthors:[],blockedBy:[],
  exposures:Object.fromEntries(Object.entries(data.viewer.exposures).map(([id,count])=>[id,{count,lastViewedAt:now}]))};
 const store=new MemoryStore();store.seedExposures(v.id,v.exposures);
 const deps={index:buildIndex(posts,cfg,now),authority:buildAuthority(new Map(posts.map(p=>[p.id,p])),
  new Map([[v.id,{jurisdiction:v.jurisdiction,age:v.age,hiddenAuthors:v.hiddenAuthors,hiddenPosts:[],blockedAuthors:[],blockedBy:[]}]])),
  store,gate:createPolicyGate(cfg.futureSkewMs),cfg};
 const ctx={surface:'home',now};
 const s=await openSession(deps,v,ctx,{seed:42});
 const page=await nextPage(deps,s,v,ctx,20);
 const local=page.filter(x=>x.post.regionId===region).length;
 result.byViewerRegion.push({viewerRegion:region,ranked:s.order.length,first20Local:local,
   first20Cross:page.length-local,localPct:Math.round(local/Math.max(1,page.length)*100),tier:s.tier,
   uniqueServed:new Set(page.map(x=>x.post.id)).size});
}
console.log(JSON.stringify(result,null,2));
