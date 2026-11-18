import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EXPERIMENTAL_CONFIG as BASE,buildIndex,buildAuthority,MemoryStore,createPolicyGate,openSession,nextPage} from '../dist/src/feed.js';
const data=JSON.parse(readFileSync(new URL('../fixtures/dummies.json',import.meta.url),'utf8'));
const now=data.now,cfg=structuredClone(BASE);
const posts=data.posts.map(p=>({id:p.id,authorId:p.authorId,regionId:p.regionId,topics:p.topics,
  createdAt:p.createdAt,impressions:p.impressions,satisfied:p.satisfied,version:1,
  moderation:p.eligible?'approved':'removed',visibility:'public',geo:null,expiresAt:null,
  minAge:null,feedEligible:true}));
const ctx={now,surface:'home'};
const viewer=(region)=>({id:'library-viewer',regionId:region,jurisdiction:'NG',age:26,
 interests:data.viewer.interests,hiddenAuthors:data.viewer.hiddenAuthors,hiddenPosts:[],
 blockedAuthors:[],blockedBy:[],exposures:Object.fromEntries(Object.entries(data.viewer.exposures)
 .map(([id,count])=>[id,{count,lastViewedAt:now}]))});
const setup=(region)=>{
 const v=viewer(region),store=new MemoryStore();store.seedExposures(v.id,v.exposures);
 const policy={jurisdiction:v.jurisdiction,age:v.age,hiddenAuthors:v.hiddenAuthors,hiddenPosts:[],blockedAuthors:[],blockedBy:[]};
 const deps={index:buildIndex(posts,cfg,now),authority:buildAuthority(new Map(posts.map(p=>[p.id,p])),new Map([[v.id,policy]])),
  store,gate:createPolicyGate(cfg.futureSkewMs),cfg};return {v,deps};
};
test('original library dataset consists of 2000 unique records',()=>{
 assert.equal(data.posts.length,2000);assert.equal(new Set(data.posts.map(p=>p.id)).size,2000);
 assert(data.posts.some(p=>!p.eligible));assert.equal(data.posts.filter(p=>p.regionId==='o').length,0);
});
test('original intentionally nonexistent viewer region receives cross-region results without a boundary',async()=>{
 const f=setup(data.viewer.regionId);const s=await openSession(f.deps,f.v,ctx,{seed:43});
 assert(s.order.length>0);assert(s.order.every(x=>posts.find(p=>p.id===x.id).regionId!=='o'));
 const page=await nextPage(f.deps,s,f.v,ctx,20);
 assert.equal(page.length,20);assert(page.every(x=>x.post.moderation==='approved' && x.post.feedEligible));
});
test('original library dataset all actual regions: local/cross mix, no duplicates and eligible only',async()=>{
 const regions=[...new Set(posts.map(p=>p.regionId))];
 for(const region of regions){
   const f=setup(region);const s=await openSession(f.deps,f.v,ctx,{seed:101});
   assert(s.order.length>0 && s.order.length<=cfg.maxOrder);
   assert.equal(s.order.length,new Set(s.order.map(x=>x.id)).size);
   assert(s.order.every(x=>posts.find(p=>p.id===x.id).moderation==='approved'));
   const page=await nextPage(f.deps,s,f.v,ctx,20);
   assert.equal(page.length,20);
   assert(page.some(x=>x.post.regionId===region),`local posts missing for ${region}`);
 }
});
