import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 buildIndex, buildRanking, nextPage, openSession, rankDlopeFeed,
 type Post, type Index, type Context,
} from '../src/index.js';
import {NOW,CTX,H,cfg,post,posts,rig,seeded,viewer} from './helpers.js';

for(const seed of [1,2,3,4,10,11,22,33,44,55,99,101,202,303,404,505]) for(const limit of [0,1,3,5,10,20,50,100]) {
 test(`index query ordering/dedup seed=${seed} limit=${limit}`,async()=>{
  const r=seeded(seed);
  const data=Array.from({length:120},(_,i)=>post(i,{
   regionId:i%3===0?'local':i%3===1?'r2':'r3',
   topics:[`t${Math.floor(r()*5)}`,`t${Math.floor(r()*5)}`],
   impressions:Math.floor(r()*1000),satisfied:Math.floor(r()*100),
   createdAt:NOW-Math.floor(r()*20)*H,
  }));
  const index=buildIndex(data,cfg(),NOW);
  const region=await index.region('local',limit);
  assert.ok(region.length<=limit&&region.every(p=>p.regionId==='local'));
  const cross=await index.crossRegion('local',limit);
  assert.ok(cross.length<=limit&&cross.every(p=>p.regionId!=='local'));
  assert.equal(new Set(cross.map(p=>p.id)).size,cross.length);
  const trending=await index.trending(limit);
  assert.ok(trending.length<=limit);
  const newest=await index.newest(limit);
  for(let j=1;j<newest.length;j++) assert.ok(newest[j-1].createdAt>=newest[j].createdAt);
  const unproven=await index.unproven(limit);
  assert.ok(unproven.every(p=>p.impressions<cfg().unprovenMaxImpressions));
  const topic=await index.topic('t1',limit);
  assert.ok(topic.every(p=>p.topics.includes('t1')));
  assert.equal(new Set(topic.map(p=>p.id)).size,topic.length);
  const subset=await index.byIds(['p-1','p-2','unknown']);
  assert.deepEqual(subset.map(p=>p.id),['p-1','p-2']);
 });
}
for(const topicCount of [0,1,2,3,5,10,14])for(const maxTopics of [0,1,2,5,10]) {
 test(`retrieval topic budget topicCount=${topicCount}, maxTopics=${maxTopics}`,async()=>{
  const interests=Array.from({length:topicCount},(_,i)=>`t${i}`);
  const r=rig(posts(50),viewer({interests}),cfg({maxTopics}));
  const hit:string[]=[];const orig=r.deps.index;
  r.deps.index={...orig,topic:async(t,n)=>{hit.push(t);return orig.topic(t,n)}};
  await openSession(r.deps,r.viewer,CTX,{seed:1});
  assert.deepEqual(hit,interests.slice(0,maxTopics));
 });
}
for(const surface of ['home','local','explore'] as const)for(const seed of [1,2,3,4,10,20,33,44,55,99]) for(const mixture of [0,1,2,3]) {
 test(`ranking eligibility ${surface} seed=${seed} mix=${mixture}`,async()=>{
  const rng=seeded(seed*17+mixture);
  const data=Array.from({length:110},(_,i)=>post(i,{
    regionId: i%4===0?'local':`r${i%4}`,
    topics: i%3===0?['a']:['b'],
    createdAt:i%13===0?NOW+H:NOW-Math.floor(rng()*300)*H,
    moderation:i%17===0?'removed':'approved',
    feedEligible:i%19!==0,
    minAge:i%23===0?35:null,
    geo:i%29===0?{deny:['NG']}:null,
    expiresAt:i%31===0?NOW-1:null,
   }));
  const v=viewer({interests:['a','b']});
  const r=rig(data,v);
  const context:Context={surface,now:NOW};
  const expected=new Set(data.filter(p=>r.deps.gate(v,context)(p)==='ok').map(p=>p.id));
  const rank=rankDlopeFeed(data,v,context,r.deps);
  const s=await openSession(r.deps,v,context,{seed});
  for(const item of rank)assert.ok(expected.has(item.id));
  for(const item of s.order)assert.ok(expected.has(item.id));
  assert.equal(new Set(rank.map(p=>p.id)).size,rank.length);
  assert.equal(new Set(s.order.map(p=>p.id)).size,s.order.length);
 });
}
for (const surface of ['home','local','explore'] as const)for(const seed of [0,1,2,3,5,11,23,97]) {
 test(`reference ranking stability surface=${surface}, seed=${seed}`,()=>{
  const rnd=seeded(seed);
  const data=Array.from({length:100},(_,i)=>post(i,{
   regionId:i%2===0?'local':'foreign', topics: i%5===0?['b']:['a'],
   impressions:100+i, satisfied:10+Math.floor(rnd()*100),createdAt:NOW-Math.floor(rnd()*50)*H,
  }));
  const v=viewer(); const r=rig(data,v);
  const context={...CTX,surface};
  assert.deepEqual(rankDlopeFeed(data,v,context,r.deps).map(p=>p.id),
                   rankDlopeFeed(data,v,context,r.deps).map(p=>p.id));
 });
}
test('indices are only candidates; authoritative content is returned at delivery, never stale index values',async()=>{
 const r=rig(posts(40));const s=await openSession(r.deps,r.viewer,CTX,{seed:1});
 const changed=s.order[0].id;r.records.get(changed)!.satisfied=999;
 r.records.get(changed)!.version=3;
 const page=await nextPage(r.deps,s,r.viewer,CTX,1);
 assert.equal(page[0].post.satisfied,999);
 assert.equal(page[0].post.version,3);
});
test('retrieval deduplicates across all overlapping buckets',async()=>{
 const data=posts(30);const r=rig(data,viewer({interests:['a','a','a']}));
 const s=await openSession(r.deps,r.viewer,CTX,{seed:1});
 assert.equal(s.order.length,data.length);
 assert.equal(new Set(s.order.map(p=>p.id)).size,data.length);
});
test('widening accumulates first-pass candidates instead of losing them',async()=>{
 const data=[...posts(5),...Array.from({length:5},(_,i)=>post(i+100,{regionId:'foreign'}))];
 const r=rig(data);
 const s=await openSession(r.deps,r.viewer,CTX,{seed:1});
 assert.equal(s.order.length,10);
 assert.equal(new Set(s.order.map(p=>p.id)).size,10);
 assert.deepEqual(s.order.map(e=>e.id).sort(),data.map(p=>p.id).sort());
});
test('cross-region discovery continues when the viewer region is empty',async()=>{
 const r=rig(posts(80,{regionId:'elsewhere'}));
 const s=await openSession(r.deps,r.viewer,CTX,{seed:1});
 const page=await nextPage(r.deps,s,r.viewer,CTX,15);
 assert.equal(page.length,15);
 assert.ok(page.every(p=>p.post.regionId==='elsewhere'));
});
test('round robin cross-region retrieval takes from several source regions',async()=>{
 const data=[...posts(35,{regionId:'r2'}),...Array.from({length:35},(_,i)=>post(100+i,{regionId:'r3'})),
  ...Array.from({length:35},(_,i)=>post(200+i,{regionId:'r4'}))];
 const index=buildIndex(data,cfg(),NOW);
 const chosen=await index.crossRegion('local',12);
 assert.equal(new Set(chosen.map(p=>p.regionId)).size,3);
 const counts=new Map<string,number>();
 for(const p of chosen)counts.set(p.regionId,(counts.get(p.regionId)??0)+1);
 assert.deepEqual([...counts.values()].sort((a,b)=>a-b),[4,4,4]);
});
test('newer post wins deterministic reference ranking when all other signals tie',()=>{
 const older=post('old',{createdAt:NOW-10*H});
 const newer=post('new',{createdAt:NOW-H});
 const r=rig([older,newer],viewer(),cfg({localShare:{home:0,local:0,explore:0}}));
 assert.deepEqual(rankDlopeFeed([older,newer],r.viewer,CTX,r.deps).map(p=>p.id),['p-new','p-old']);
});
test('home/reference relevance rewards matching interests when all other signals tie',()=>{
 const target=post('yes',{topics:['a']});
 const other=post('no',{topics:['b']});
 const r=rig([other,target],viewer(),cfg({localShare:{home:0,local:0,explore:0}}));
 assert.equal(rankDlopeFeed([other,target],r.viewer,CTX,r.deps)[0].id,target.id);
});
test('ranking excludes hidden and blocked authors even when their score would have won',()=>{
 const target=post('hidden',{topics:['a'],impressions:100,satisfied:100});
 const fallback=post('fallback',{topics:['b'],impressions:100,satisfied:0});
 const v=viewer({hiddenAuthors:[target.authorId]});const r=rig([target,fallback],v);
 assert.deepEqual(rankDlopeFeed([target,fallback],v,CTX,r.deps).map(p=>p.id),[fallback.id]);
});
for(const n of [100,500,1000,5000]){
 test(`retrieval stress inventory=${n} produces bounded unique order`,async()=>{
  const rng=seeded(n);
  const data=Array.from({length:n},(_,i)=>post(i,{authorId:`a${i%250}`,regionId:i%5===0?'local':`r${i%5}`,
   topics:[`t${Math.floor(rng()*50)}`],createdAt:NOW-Math.floor(rng()*24*20)*H,
   impressions:Math.floor(rng()*500),satisfied:Math.floor(rng()*100)}));
  const r=rig(data,viewer({interests:Array.from({length:10},(_,i)=>`t${i}`)}));
  const s=await openSession(r.deps,r.viewer,CTX,{seed:5});
  assert.ok(s.order.length<=r.cfg.maxOrder);
  assert.equal(new Set(s.order.map(p=>p.id)).size,s.order.length);
 });
}
// Outside the 12:41 implementation, but essential production expectations.
test.todo('sparse-region retrieval stops widening when the local bucket is definitively exhausted');
test.todo('fresh tier cannot be reordered behind recycled tier by the global diversity step');
test.todo('local share quota is met under per-author diversity when a feasible alternative exists');
