import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 advanceSession, buildRanking, invalidateRankings, loadSession, nextPage, openSession,
 rebuildTail, recordViews, refreshSession, SessionAccessError, StoreConflict, MemoryStore,
 type Served, type Viewer,
} from '../src/index.js';
import {CTX,NOW,H,cfg,post,posts,rig,viewer} from './helpers.js';

for (const n of [0,1,2,3,5,10,20,60,120,250]) for(const size of [1,2,3,5,10,17,40,100]){
 test(`pagination: no duplicates/misses, count=${n}, page=${size}`,async()=>{
  const r=rig(posts(n));
  const s=await openSession(r.deps,r.viewer,CTX,{seed:71});
  const ids:string[]=[];
  for(let i=0;i<Math.ceil(n/Math.max(1,size))+2;i++){
   const page=await nextPage(r.deps,s,r.viewer,CTX,size);
   ids.push(...page.map(p=>p.post.id));
  }
  assert.equal(ids.length,Math.min(n,r.cfg.maxOrder));
  assert.equal(new Set(ids).size,ids.length);
  assert.deepEqual(ids.sort(),s.order.map(p=>p.id).sort());
  assert.equal(s.cursor,s.order.length);
  assert.equal((await r.store.load(s.id))?.cursor,s.cursor);
 });
}
for (const n of [0,1,4,10,20,60,100,201,400]) for (const cap of [1,2,3,10,25,50,200]) {
 test(`session order cap input=${n} cap=${cap}`,async()=>{
  const r=rig(posts(n),viewer(),cfg({maxOrder:cap}));
  const s=await openSession(r.deps,r.viewer,CTX,{seed:4});
  assert.ok(s.order.length<=cap);
  assert.equal(new Set(s.order.map(p=>p.id)).size,s.order.length);
 });
}
for (const seed of [0,1,2,3,5,10,20,21,100,4294967295]) for (const surface of ['home','local','explore'] as const){
 test(`seed reproducibility seed=${seed} surface=${surface}`,async()=>{
  const r=rig(posts(70));
  const context={...CTX,surface};
  const a=await openSession(r.deps,r.viewer,context,{seed});
  const b=await openSession(r.deps,r.viewer,context,{seed});
  assert.notEqual(a.id,b.id);
  assert.deepEqual(a.order,b.order);
  assert.equal(a.refresh,0);assert.equal(a.rev,0);assert.equal(a.cursor,0);
  assert.equal(a.startedAt,context.now);
 });
}
test('session ownership prevents access, delivery, refresh, recording and invalidation',async()=>{
 const r=rig(posts(50));const s=await openSession(r.deps,r.viewer,CTX,{seed:3});
 const adversary:Viewer=viewer({id:'attacker'});
 await assert.rejects(loadSession(r.deps,s.id,adversary),SessionAccessError);
 await assert.rejects(nextPage(r.deps,s,adversary,CTX,3),SessionAccessError);
 await assert.rejects(advanceSession(r.deps,s,adversary,CTX),SessionAccessError);
 await assert.rejects(invalidateRankings(r.deps,s,adversary,CTX,[s.order[0].id]),SessionAccessError);
 // recordViews has its own viewer-id check (server-issued receipts cannot be redeemed by a different viewer).
 const page=await nextPage(r.deps,s,r.viewer,CTX,1);
 const denied=await recordViews(r.deps,s,adversary,[{serveId:page[0].serveId,visibleMs:2000,visibleFraction:1}],NOW+3000);
 assert.deepEqual(denied.accepted,[]);assert.equal(denied.rejected.wrong_viewer,1);
 assert.equal((await r.store.load(s.id))?.cursor,1);
});
test('missing session and owner-mismatched ids share the same access error',async()=>{
 const r=rig(posts(30));const s=await openSession(r.deps,r.viewer,CTX,{seed:1});
 for(const id of ['missing',s.id]){
  await assert.rejects(loadSession(r.deps,id,viewer({id:'stranger'})),{name:'Error',message:'session not found'});
 }
});
test('one of two concurrent next-page requests succeeds; the other conflicts (CAS)',async()=>{
 const r=rig(posts(50));const s=await openSession(r.deps,r.viewer,CTX,{seed:2});
 const [a,b]=await Promise.allSettled([nextPage(r.deps,structuredClone(s),r.viewer,CTX,4),nextPage(r.deps,structuredClone(s),r.viewer,CTX,4)]);
 assert.equal([a,b].filter(x=>x.status==='fulfilled').length,1);
 assert.ok([a,b].filter(x=>x.status==='rejected').every(x=>x.reason instanceof StoreConflict));
 assert.equal((await r.store.load(s.id))?.cursor,4);
});
test('a failed recordServes write changes neither cursor nor receipt count',async()=>{
 const r=rig(posts(40));const s=await openSession(r.deps,r.viewer,CTX,{seed:2});
 r.store.faults=1;
 await assert.rejects(nextPage(r.deps,s,r.viewer,CTX,4),/store unavailable/);
 assert.equal(s.cursor,0);
 assert.equal((await r.store.load(s.id))?.cursor,0);
 const successful=await nextPage(r.deps,s,r.viewer,CTX,4);
 assert.equal(successful.length,4);
});
test('stale edit returns latest content and re-ranks remaining tail',async()=>{
 const r=rig(posts(50));const s=await openSession(r.deps,r.viewer,CTX,{seed:7});
 const id=s.order[0].id;r.records.get(id)!.version=2;
 r.records.get(id)!.topics=['new-topic'];
 const beforeRev=s.rev;
 const page=await nextPage(r.deps,s,r.viewer,CTX,3);
 assert.equal(page[0].post.version,2);
 assert.equal(page[0].stale,true);
 assert.ok(page.some(x=>x.post.id===id&&x.post.topics.includes('new-topic')));
 assert.equal(s.rev,beforeRev+1);
 assert.equal((await r.store.load(s.id))?.rev,s.rev);
});
test('invalidating an unrelated post returns false without changing the session',async()=>{
 const r=rig(posts(40));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const before=structuredClone(s);
 assert.equal(await invalidateRankings(r.deps,s,r.viewer,CTX,['unknown-id']),false);
 assert.deepEqual(s,before);
});
test('invalidating a ranked post prunes content that became ineligible',async()=>{
 const r=rig(posts(40));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const id=s.order[4].id;r.records.get(id)!.feedEligible=false;
 assert.equal(await invalidateRankings(r.deps,s,r.viewer,CTX,[id]),true);
 assert.ok(!s.order.some(p=>p.id===id));
});
test('authoritative viewer policy change takes effect on the very next delivery',async()=>{
 const r=rig(posts(50));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const chosen=s.order[0].id;
 r.policies.get(r.viewer.id)!.hiddenPosts.push(chosen);
 const page=await nextPage(r.deps,s,r.viewer,CTX,2);
 assert.ok(page.every(p=>p.post.id!==chosen));
});
test('authoritative deletion skips missing cached posts',async()=>{
 const r=rig(posts(30));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const chosen=s.order[0].id;r.records.delete(chosen);
 const page=await nextPage(r.deps,s,r.viewer,CTX,29);
 assert.equal(page.length,29);assert.ok(page.every(p=>p.post.id!==chosen));
});
test('authoritative expiry skips cached posts',async()=>{
 const r=rig(posts(30));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const chosen=s.order[0].id;r.records.get(chosen)!.expiresAt=NOW;
 const page=await nextPage(r.deps,s,r.viewer,CTX,29);
 assert.equal(page.length,29);assert.ok(page.every(p=>p.post.id!==chosen));
});
test('bounded scan prevents unbounded authority probes',async()=>{
 const r=rig(posts(50),viewer(),cfg({maxServeScan:5}));
 const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 for(const [i,entry] of s.order.entries()) if(i<20) r.records.get(entry.id)!.moderation='removed';
 const first=await nextPage(r.deps,s,r.viewer,CTX,5);
 assert.equal(first.length,0);assert.equal(s.cursor,5);
 const second=await nextPage(r.deps,s,r.viewer,CTX,5);
 assert.equal(second.length,0);assert.equal(s.cursor,10);
});
test('refresh invalidates the old generation and restarts its cursor',async()=>{
 const r=rig(posts(60));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 await nextPage(r.deps,s,r.viewer,CTX,8);
 const next=await advanceSession(r.deps,s,r.viewer,{...CTX,now:NOW+60_000});
 assert.equal(next.refresh,1);assert.equal(next.rev,0);assert.equal(next.cursor,0);
 assert.equal((await r.store.load(s.id))?.refresh,1);
 await assert.rejects(nextPage(r.deps,s,r.viewer,CTX,2),StoreConflict);
});
test('two refreshes starting at the same generation cannot both win',async()=>{
 const r=rig(posts(60));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const settled=await Promise.allSettled([advanceSession(r.deps,structuredClone(s),r.viewer,CTX),advanceSession(r.deps,structuredClone(s),r.viewer,CTX)]);
 assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
 assert.ok(settled.some(x=>x.status==='rejected'&&x.reason instanceof StoreConflict));
});
test('store restart retains session cursor and receipts',async()=>{
 const r=rig(posts(30));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const page=await nextPage(r.deps,s,r.viewer,CTX,3);
 const fromDisk=new MemoryStore(r.store.dump());
 assert.equal((await fromDisk.load(s.id))?.cursor,3);
 assert.equal((await fromDisk.receipts(s.id,page.map(p=>p.serveId))).size,3);
});
test('view reports and refresh conserve claimed history',async()=>{
 const r=rig(posts(50));const s=await openSession(r.deps,r.viewer,CTX,{seed:8});
 const page=await nextPage(r.deps,s,r.viewer,CTX,4);
 const result=await refreshSession(r.deps,s,r.viewer,{...CTX,now:NOW+10_000},page.map(p=>({serveId:p.serveId,visibleMs:1000,visibleFraction:1})));
 assert.equal(result.accepted.length,4);
 const hist=await r.store.history(s.id);
 for(const id of result.accepted)assert.ok(hist.claimed.has(id));
 assert.equal(result.session.refresh,1);
 assert.ok(result.session.order.every(e=>!hist.claimed.has(e.id)));
});
// Explicitly track contractual properties not yet guaranteed by the frozen implementation.
test('tier isolation: recycled inventory never overtakes fresh inventory under author-diversity constraints',async()=>{
 const data=Array.from({length:20},(_,i)=>post(i,{authorId:i%2===0?'one':'two'}));
 const exposed=Object.fromEntries(data.slice(5).map(p=>[p.id,{count:10,lastViewedAt:NOW}]));
 const r=rig(data,viewer({exposures:exposed}),cfg({minPool:30,maxPerAuthor:1,diversityWindow:5}));
 const s=await openSession(r.deps,r.viewer,CTX,{seed:12});
 const firstOld=s.order.findIndex(e=>e.rank>0);
 assert(firstOld>0);
 assert(s.order.slice(0,firstOld).every(e=>e.rank===0));
 assert(s.order.slice(firstOld).every(e=>e.rank>0));
 // A stale edit cannot pull recycled inventory ahead of fresh inventory.
 const target=s.order[0].id; r.records.get(target)!.version++;
 assert.equal(await invalidateRankings(r.deps,s,r.viewer,CTX,[target]),true);
 const k=s.order.findIndex(e=>e.rank>0);
 assert(s.order.slice(0,k).every(e=>e.rank===0));
 assert(s.order.slice(k).every(e=>e.rank>0));
});
test.todo('session order never delivers the same post twice through concurrent independent sessions after a qualified view');
test('server rejects nonpositive or noninteger requested page sizes before issuing receipts',async()=>{
 const r=rig(posts(30)); const s=await openSession(r.deps,r.viewer,CTX,{seed:3});
 for(const n of [0,-1,1.5,NaN,Infinity,-Infinity]){
  await assert.rejects(nextPage(r.deps,s,r.viewer,CTX,n),RangeError);
  assert.equal((await r.store.load(s.id))!.cursor,0);
  assert.equal((await r.store.history(s.id)).served.size,0);
 }
});
