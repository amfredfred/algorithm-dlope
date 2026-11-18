import test from 'node:test';
import assert from 'node:assert/strict';
import {
 EXPERIMENTAL_CONFIG as BASE, buildIndex, buildAuthority, MemoryStore, createPolicyGate,
 openSession, nextPage, recordViews, advanceSession, refreshSession, invalidateRankings,
 rebuildTail, rankDlopeFeed, diversify, diversifyWithLocalQuota, withLocalShare, buildRanking,
 StoreConflict, SessionAccessError, mulberry32
} from '../dist/src/feed.js';

const NOW = 1795000000000; // deterministic server clock
const CTX = {now: NOW, surface:'home'};
const cfg = (changes={}) => ({...structuredClone(BASE), ...changes});
const viewer = (changes={}) => ({ id:'viewer-1',regionId:'lagos',jurisdiction:'NG',age:26,
    interests:['news','events'],hiddenAuthors:[],hiddenPosts:[],blockedAuthors:[],blockedBy:[],exposures:{},...changes });
const post=(id,changes={})=>({id,authorId:`user-${id}`,regionId:'lagos',topics:['news'],createdAt:NOW-5000,
   impressions:100,satisfied:40,version:1,moderation:'approved',visibility:'public',geo:null,
   expiresAt:null,minAge:null,feedEligible:true,...changes});
const fixture=(posts, v=viewer(), conf=cfg())=>{
  const store=new MemoryStore(), records=new Map(posts.map(p=>[p.id,structuredClone(p)]));
  const policy=new Map([[v.id,{jurisdiction:v.jurisdiction,age:v.age,hiddenAuthors:v.hiddenAuthors,
    hiddenPosts:v.hiddenPosts,blockedAuthors:v.blockedAuthors,blockedBy:v.blockedBy}]]);
  store.seedExposures(v.id,v.exposures);
  const deps={index:buildIndex(posts,conf,NOW),authority:buildAuthority(records,policy),store,
    gate:createPolicyGate(conf.futureSkewMs),cfg:conf};
  return {v,deps,store,records,policy};
};
const ids=p=>p.map(x=>x.post?.id??x.id);
const open=async fx=>openSession(fx.deps,fx.v,CTX,{seed:58});

// Policy: security, moderation, scheduling, privacy, visibility, geo, age.
test('gate allows valid public Square root',()=>assert.equal(createPolicyGate(BASE.futureSkewMs)(viewer(),CTX)(post('a')),'ok'));
test('gate denies Square-only chat from discovery',()=>assert.equal(createPolicyGate(BASE.futureSkewMs)(viewer(),CTX)(post('a',{feedEligible:false})),'not_feed'));
test('gate denies pending/restricted/removed moderation',()=>{
 for(const m of ['pending','restricted','removed'])assert.equal(createPolicyGate(60000)(viewer(),CTX)(post('a',{moderation:m})),'moderation');
});
test('gate blocks both directions and hides authors and posts',()=>{
 for(const key of ['blockedAuthors','blockedBy','hiddenAuthors']){
   const value = createPolicyGate(60000)(viewer({[key]:['user-a']}),CTX)(post('a'));
   assert.equal(value,key.startsWith('blocked')?'blocked':'hidden');
 }
 assert.equal(createPolicyGate(60000)(viewer({hiddenPosts:['a']}),CTX)(post('a')),'hidden');
});
test('gate allows own private posts but hides them from other viewers',()=>{
 assert.equal(createPolicyGate(60000)(viewer({id:'user-a'}),CTX)(post('a',{visibility:'private'})),'ok');
 assert.equal(createPolicyGate(60000)(viewer({id:'viewer-1'}),CTX)(post('a',{visibility:'private'})),'privacy');
});
test('gate filters expiration and future publication',()=>{
 const gate=createPolicyGate(60000)(viewer(),CTX);
 assert.equal(gate(post('a',{expiresAt:NOW})),'expired');
 assert.equal(gate(post('a',{createdAt:NOW+60001})),'scheduled');
 assert.equal(gate(post('a',{createdAt:NOW+60000})),'ok');
});
test('gate denies age restrictions with missing age',()=>{
 const p=post('a',{minAge:18});
 assert.equal(createPolicyGate(60000)(viewer({age:null}),CTX)(p),'age');
 assert.equal(createPolicyGate(60000)(viewer({age:17}),CTX)(p),'age');
 assert.equal(createPolicyGate(60000)(viewer({age:18}),CTX)(p),'ok');
});
test('geo permit/deny checks',()=>{
 const gate=createPolicyGate(60000)(viewer(),CTX);
 assert.equal(gate(post('a',{geo:{allow:['NG']}})),'ok');
 assert.equal(gate(post('a',{geo:{deny:['NG']}})),'geo');
 assert.equal(gate(post('a',{geo:{allow:['US']}})),'geo');
 assert.equal(gate(post('a',{geo:{allow:['NG'],deny:['NG']}})),'geo');
 assert.equal(createPolicyGate(60000)(viewer({jurisdiction:''}),CTX)(post('a',{geo:{allow:['NG']}})),'geo');
});
test('malformed geo arrays fail closed (reported regression)',()=>{
 const gate=createPolicyGate(60000)(viewer(),CTX);
 for(const geo of [{deny:[1]},{allow:[null]},{deny:['NG',3]},{allow:[] ,deny:'NG'},
      {allow:null},{deny:[{}]},{deny:[' ']},[],{},'NG']) {
  assert.equal(gate(post('a',{geo})),'incomplete',`geo=${JSON.stringify(geo)}`);
 }
});
test('malformed viewer and policy denied',()=>{
 const p=post('a');
 for(const changes of [{blockedBy:null},{hiddenPosts:[1]},{age:-1},{age:Infinity},{age:22.5},
       {id:''},{blockedAuthors:['']},{hiddenAuthors:[null]}]){
    assert.equal(createPolicyGate(60000)(viewer(changes),CTX)(p),'incomplete',JSON.stringify(changes));
 }
 for(const changes of [{geo:undefined},{expiresAt:undefined},{minAge:undefined},{feedEligible:undefined},
       {createdAt:NaN},{minAge:NaN},{minAge:18.5},{expiresAt:NaN}]){
    assert.equal(createPolicyGate(60000)(viewer(),CTX)(post('a',changes)),'incomplete');
 }
});

test('index filters 1200 ineligible local before candidate limits (reported regression)',async()=>{
 const posts=[...Array.from({length:1200},(_,i)=>post('bad'+i,{feedEligible:false,impressions:1000,satisfied:990})),
 ...Array.from({length:100},(_,i)=>post('local'+i,{impressions:1000,satisfied:20})),
 ...Array.from({length:200},(_,i)=>post('remote'+i,{regionId:'abuja',impressions:1000,satisfied:800}))];
 const fx=fixture(posts); const s=await open(fx);
 assert(s.order.length>0);
 assert(s.order.some(e=>e.id.startsWith('local')),'eligible local posts must survive retrieval');
 assert(s.order.every(e=>!e.id.startsWith('bad')),'Square-only content must not enter feed');
});
test('index filters expired, private, removed and scheduled before budget',async()=>{
 const bad=[{expiresAt:NOW},{moderation:'removed'},{visibility:'private'},{createdAt:NOW+1000000}];
 const posts=[...Array.from({length:350},(_,i)=>post('bad'+i,bad[i%4])),post('good')];
 const fx=fixture(posts); const s=await open(fx);
 assert.deepEqual(s.order.map(e=>e.id),['good']);
});
test('index round-robins across other regions',async()=>{
 const posts=['L','R1','R2','R3'].flatMap(r=>Array.from({length:10},(_,i)=>post(r+i,{regionId:r})));
 const v=viewer({regionId:'L'}), c=cfg();const index=buildIndex(posts,c,NOW);
 const result=await index.crossRegion('L',9);
 assert.equal(new Set(result.map(p=>p.regionId)).size,3);
 assert(result.every(p=>p.regionId!=='L'));
});
test('feed deduplicates same post ID even if index lists duplicates',()=>{
 const p=post('dup');const fx=fixture([p,p,p]);
 assert.deepEqual(ids(rankDlopeFeed([p,p,p],fx.v,CTX,fx.deps)),['dup']);
});
test('malformed score rows do not poison ranking',async()=>{
 const posts=[post('bad',{topics:null}),post('bad2',{impressions:NaN}),post('bad3',{satisfied:200}),post('good')];
 const fx=fixture(posts);
 assert.deepEqual(ids(rankDlopeFeed(posts,fx.v,CTX,fx.deps)),['good']);
 assert.deepEqual((await open(fx)).order.map(e=>e.id),['good']);
});
test('configuration validation blocks zero temperature and bad budgets',async()=>{
 for (const c of [cfg({temperature:0}),cfg({priorStrength:0}),cfg({exposureHalfLifeH:0}),
      cfg({maxOrder:-1}),cfg({localShare:{...BASE.localShare,home:1.1}}),
      cfg({view:{...BASE.view,viewportCapacity:0}}),cfg({budget:{...BASE.budget,region:-20}})]){
   const f=fixture([post('x')],viewer(),c);
   await assert.rejects(()=>open(f),/invalid experimental feed configuration/);
 }
});
test('local share guaranteed when independent authors permit it',()=>{
 const posts=[...Array.from({length:100},(_,i)=>post('remote'+i,{regionId:'foreign'})),
 ...Array.from({length:100},(_,i)=>post('local'+i))];
 const ranked=diversifyWithLocalQuota(posts,2,10,'lagos',.8).order;
 for(let n=1;n<=100;n++)assert(ranked.slice(0,n).filter(p=>p.regionId==='lagos').length>=Math.floor(n*.8));
 assert.equal(ranked.length,200);
});
test('author cap has precedence over infeasible local quota',()=>{
 const posts=[...Array.from({length:5},(_,i)=>post('loc'+i,{authorId:'single'})),
 ...Array.from({length:12},(_,i)=>post('other'+i,{regionId:'cross',authorId:'out'+i}))];
 const result=diversifyWithLocalQuota(posts,2,10,'lagos',.8);
 assert(result.order.length===posts.length);
 assert(result.order.slice(0,10).filter(p=>p.authorId==='single').length<=2);
 assert.equal(new Set(result.order.map(p=>p.id)).size,posts.length);
});
test('diversify respects author cap for feasible author distribution',()=>{
 const posts=Array.from({length:50},(_,i)=>post('p'+i,{authorId:'user'+(i%10)}));
 const result=diversifyWithLocalQuota(posts,2,10,'lagos',.5).order;
 for(let i=0;i<result.length;i++){
    const win=result.slice(Math.max(0,i-9),i+1);
    assert(win.filter(p=>p.authorId===result[i].authorId).length<=2);
 }
});
test('same seed produces same sessions and order',async()=>{
 const posts=Array.from({length:100},(_,i)=>post('p'+i,{regionId:i%2?'other':'lagos'}));
 const a=fixture(posts),b=fixture(posts);
 assert.deepEqual((await open(a)).order,(await open(b)).order);
});
test('client session cannot read another user session',async()=>{
 const fx=fixture([post('x')]);let s=await open(fx);
 await assert.rejects(()=>nextPage(fx.deps,s,viewer({id:'attacker'}),CTX,1),SessionAccessError);
 await assert.rejects(()=>advanceSession(fx.deps,s,viewer({id:'attacker'}),CTX),SessionAccessError);
});
test('page size rejected if not positive integer',async()=>{
 const fx=fixture([post('x')]);let s=await open(fx);
 for(const n of [0,-1,1.5,NaN,Infinity]) await assert.rejects(()=>nextPage(fx.deps,s,fx.v,CTX,n),RangeError);
});
test('authoritative removed/hidden/block state rechecked at delivery',async()=>{
 const fx=fixture(Array.from({length:20},(_,i)=>post('p'+i)));
 const s=await open(fx);
 const choice=s.order[s.cursor].id;
 fx.records.get(choice).moderation='removed';
 const page=await nextPage(fx.deps,s,fx.v,CTX,5);
 assert(!page.some(x=>x.post.id===choice));
 const choice2=s.order[s.cursor].id;
 fx.policy.get(fx.v.id).hiddenPosts=[choice2];
 const page2=await nextPage(fx.deps,s,fx.v,CTX,5);
 assert(!page2.some(x=>x.post.id===choice2));
});
test('authority mapping cannot return mismatched post ID',async()=>{
 const fx=fixture([post('a'),post('b')]);const s=await open(fx);
 const original=fx.deps.authority.posts;
 fx.deps.authority.posts=async ids=>new Map(ids.map(id=>[id,post('wrong')]));
 assert.deepEqual(await nextPage(fx.deps,s,fx.v,CTX,2),[]);
 fx.deps.authority.posts=original;
});
test('concurrent nextPage CAS allows one winner and no duplicate delivery',async()=>{
 const fx=fixture(Array.from({length:20},(_,i)=>post('p'+i)));
 const a=await open(fx),b=structuredClone(a);
 const outcomes=await Promise.allSettled([nextPage(fx.deps,a,fx.v,CTX,3),nextPage(fx.deps,b,fx.v,CTX,3)]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert(outcomes.some(x=>x.status==='rejected' && x.reason instanceof StoreConflict));
});
test('authoritative edits trigger tail rebuild preserving served prefix',async()=>{
 const fx=fixture(Array.from({length:30},(_,i)=>post('p'+i)));
 const s=await open(fx);const page=await nextPage(fx.deps,s,fx.v,CTX,3);
 const old=s.order.slice(0,s.cursor).map(x=>x.id);
 const toEdit=s.order[s.cursor];fx.records.get(toEdit.id).version=2;
 assert.equal(await invalidateRankings(fx.deps,s,fx.v,CTX,[toEdit.id]),true);
 assert.equal(s.rev,1);
 assert.deepEqual(s.order.slice(0,s.cursor).map(x=>x.id),old);
 assert.equal(s.order.find(x=>x.id===toEdit.id).version,2);
});
test('views: accepted qualified, duplicate, unknown, below threshold',async()=>{
 const fx=fixture(Array.from({length:4},(_,i)=>post('p'+i)));const s=await open(fx);
 const page=await nextPage(fx.deps,s,fx.v,CTX,3);
 const x=page[0].serveId,y=page[1].serveId,z=page[2].serveId;
 const a=await recordViews(fx.deps,s,fx.v,[{serveId:x,visibleMs:1300,visibleFraction:1},
   {serveId:y,visibleMs:120,visibleFraction:1},{serveId:z,visibleMs:1800,visibleFraction:1}],NOW+8000);
 assert.deepEqual(a.accepted.sort(),[page[0].post.id,page[2].post.id].sort());
 assert.equal(a.rejected.below_threshold,1);
 const b=await recordViews(fx.deps,s,fx.v,[{serveId:x,visibleMs:1400,visibleFraction:1},
   {serveId:'nonsense',visibleMs:1800,visibleFraction:1}],NOW+9000);
 assert.equal(b.rejected.duplicate,1); assert.equal(b.rejected.unknown,1);
 assert.equal(fx.store.claimLog().length,3);
});
test('views: too early, implausible fractions, null times, expired claims',async()=>{
 const fx=fixture(Array.from({length:5},(_,i)=>post('p'+i)));const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,5);
 const ev=p.map((x,i)=>({serveId:x.serveId,visibleMs: i===0?10000:i===1?1200:i===2?null:i===3?1200:100,
   visibleFraction:i===1?4:1}));
 const x=await recordViews(fx.deps,s,fx.v,ev,NOW+2000);
 assert((x.rejected.implausible??0)>=3);
 const f=fixture([post('one')]);const z=await open(f);const page=await nextPage(f.deps,z,f.v,CTX,1);
 const b=await recordViews(f.deps,z,f.v,[{serveId:page[0].serveId,visibleMs:1000,visibleFraction:1}],NOW+f.deps.cfg.view.receiptTtlMs+1);
 assert.equal(b.rejected.expired,1);
});
test('views: no cross-user receipt redemption',async()=>{
 const fx=fixture([post('a')]);const s=await open(fx);const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 const bad=await recordViews(fx.deps,s,viewer({id:'other'}),[{serveId:p[0].serveId,visibleMs:1200,visibleFraction:1}],NOW+2000);
 assert.equal(bad.rejected.wrong_viewer,1);
});
test('views: time budget is cumulative across separate calls',async()=>{
 const fx=fixture(Array.from({length:6},(_,i)=>post('p'+i)));const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,6);
 const a=await recordViews(fx.deps,s,fx.v,[{serveId:p[0].serveId,visibleMs:3200,visibleFraction:1}],NOW+4000);
 const b=await recordViews(fx.deps,s,fx.v,[{serveId:p[1].serveId,visibleMs:3100,visibleFraction:1}],NOW+4000);
 assert.equal(a.accepted.length,1);
 assert.equal(b.rejected.implausible,1);
 assert.equal(b.accepted.length,0);
});
test('views: persisted session start time resists caller-forged startedAt',async()=>{
 const fx=fixture(Array.from({length:3},(_,i)=>post('p'+i)));const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,3);
 // Simulate already-consumed 5s of cumulative session budget (forged session copies must not reset it).
 const db=JSON.parse(fx.store.dump());db.spent[s.id]=5000;
 fx.deps.store=new MemoryStore(JSON.stringify(db));
 const fake={...s,startedAt:NOW-1000000};
 const a=await recordViews(fx.deps,fake,fx.v,[{serveId:p[0].serveId,visibleMs:2000,visibleFraction:1}],NOW+3000);
 assert.equal(a.rejected.implausible,1);
});
test('views: concurrent same receipt credited exactly once',async()=>{
 const fx=fixture([post('a')]);const s=await open(fx);const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 const claim={serveId:p[0].serveId,visibleMs:1200,visibleFraction:1};
 const results=await Promise.all([recordViews(fx.deps,s,fx.v,[claim],NOW+2000),recordViews(fx.deps,s,fx.v,[claim],NOW+2000)]);
 assert.equal(results.flatMap(x=>x.accepted).length,1);
 assert.equal(results.reduce((n,x)=>n+(x.rejected.duplicate??0),0),1);
});
test('refresh excludes claimed posts when there is sufficient fresh content',async()=>{
 const fx=fixture(Array.from({length:150},(_,i)=>post('p'+i)));
 let s=await open(fx);let page=await nextPage(fx.deps,s,fx.v,CTX,3);
 const result=await refreshSession(fx.deps,s,fx.v,{...CTX,now:NOW+5000},page.map(x=>({serveId:x.serveId,visibleMs:1200,visibleFraction:1})));
 assert.equal(result.accepted.length,3);
 assert(result.session.order.every(x=>!result.accepted.includes(x.id)));
});
test('memory store survives JSON persistence with view budgets and claims',async()=>{
 const fx=fixture([post('p0'),post('p1')]);const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 await recordViews(fx.deps,s,fx.v,[{serveId:p[0].serveId,visibleMs:1200,visibleFraction:1}],NOW+2000);
 const restored=new MemoryStore(fx.store.dump());
 assert.equal((await restored.history(s.id)).claimed.size,1);
 assert((await restored.viewSpent(s.id))>=1200);
 assert.equal((await restored.load(s.id)).id,s.id);
});
test('failed store writes are fail-closed without phantom serve records',async()=>{
 const fx=fixture([post('a')]);const s=await open(fx);fx.store.faults=1;
 await assert.rejects(()=>nextPage(fx.deps,s,fx.v,CTX,1),/store unavailable/);
 assert.equal((await fx.store.history(s.id)).served.size,0);
 assert.equal((await nextPage(fx.deps,s,fx.v,CTX,1)).length,1);
});
test('onStale observer failure cannot undo successful page',async()=>{
 const fx=fixture(Array.from({length:5},(_,i)=>post('p'+i)));
 const s=await open(fx);
 const first=s.order[0].id;fx.records.get(first).version=2;
 fx.deps.onStale=()=>{throw Error('observer failed')};
 fx.deps.onError=()=>{};
 const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 assert.equal(p.length,1);assert.equal(p[0].stale,true);
});
test('combinations of local shares, distinct authors and priorities preserve size and IDs',()=>{
 let scenarios=0;
 for(const share of [0,.1,.25,.5,.8,1])for(const window of [1,2,5,10,20])for(const max of [1,2,3]){
   const posts=Array.from({length:75},(_,i)=>post('p'+i,{authorId:'u'+i,regionId:i%3===0?'lagos':'remote'}));
   const x=diversifyWithLocalQuota(posts,max,window,'lagos',share);
   assert.equal(x.order.length,75);assert.equal(new Set(ids(x.order)).size,75);
   scenarios++;
 }
 console.log(`Property scenarios: ${scenarios}`);
});
test('randomized policy fuzz 5000 cases always produces valid verdict and never admits malformed geo',()=>{
 const rng=mulberry32(83);const choices=[null,undefined,0,1,'',[],{},['NG'],[1],[''],{deny:['NG']},{allow:[1]},
 {allow:['NG']},{allow:null},{deny:null},{deny:[]},false,NaN,Infinity];
 const verdicts=['ok','incomplete','moderation','not_feed','scheduled','expired','blocked','hidden','privacy','age','geo'];
 const gate=createPolicyGate(BASE.futureSkewMs)(viewer(),CTX);
 for(let k=0;k<5000;k++){
  const p=post('p'+k);
  const key=['geo','minAge','expiresAt','feedEligible','visibility','moderation'][Math.floor(rng()*6)];
  const value=choices[Math.floor(rng()*choices.length)];p[key]=value;
  const v=gate(p);assert(verdicts.includes(v),`k=${k}: ${v}`);
  if(key==='geo' && value && typeof value==='object' &&
    ((value.deny!==undefined && (!Array.isArray(value.deny)||value.deny.some(x=>typeof x!=='string'||!x.trim())))||
     (value.allow!==undefined && (!Array.isArray(value.allow)||value.allow.some(x=>typeof x!=='string'||!x.trim())))))
      assert.notEqual(v,'ok',`malformed geo accepted ${JSON.stringify(value)}`);
 }
});
test('randomized locality/diversity fuzz 2000 cases never drops or duplicates eligible post',()=>{
 const rng=mulberry32(724);for(let k=0;k<2000;k++){
  const n=1+Math.floor(rng()*120),share=rng(),max=1+Math.floor(rng()*4),window=1+Math.floor(rng()*20);
  const posts=Array.from({length:n},(_,i)=>post('p'+i,{regionId:rng()<.45?'lagos':'other',authorId:'a'+Math.floor(rng()*35)}));
  const {order,relaxedFrom}=diversifyWithLocalQuota(posts,max,window,'lagos',share);
  assert.equal(order.length,posts.length);
  assert.equal(new Set(ids(order)).size,order.length);
  assert.deepEqual(new Set(ids(order)),new Set(ids(posts)));
  if(relaxedFrom!==null) assert(relaxedFrom>=0 && relaxedFrom<order.length);
 }
});
test('randomized ranking + policy fuzz 1000 seeds only returns unique eligible posts',()=>{
 const rng=mulberry32(119);for(let k=0;k<1000;k++){
  const n=10+Math.floor(rng()*80),posts=[];
  for(let i=0;i<n;i++)posts.push(post('p'+i,{regionId:rng()<.55?'lagos':'remote',
    authorId:'user'+Math.floor(rng()*12),feedEligible:rng()<.85,
    moderation:rng()<.9?'approved':'removed',createdAt:NOW-Math.floor(rng()*1e7),
    satisfied:Math.floor(rng()*100)}));
  const fx=fixture(posts); const result=rankDlopeFeed(posts,fx.v,CTX,fx.deps);
  assert.equal(result.length,new Set(ids(result)).size);
  assert(result.every(p=>p.feedEligible && p.moderation==='approved' && p.visibility==='public'));
 }
});
test('3000 randomized view plausibility and threshold evaluations',async()=>{
 const fx=fixture(Array.from({length:40},(_,i)=>post('p'+i)));const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,40);
 const rng=mulberry32(12);
 let tested=0;
 for(let k=0;k<3000;k++){
   const x=p[k%p.length],fraction=rng()*1.5,visibleMs=Math.floor(rng()*5000);
   const f=fixture([post('x')]); const session=await open(f);const page=await nextPage(f.deps,session,f.v,CTX,1);
   const outcome=await recordViews(f.deps,session,f.v,[{serveId:page[0].serveId,visibleFraction:fraction,visibleMs}],NOW+2500);
   assert.equal(outcome.accepted.length+(outcome.rejected.below_threshold??0)+(outcome.rejected.implausible??0),1);
   tested++;
 }
 console.log(`Independent session view trials: ${tested}`);
});

test('viewer-specific blocked/hidden authors are filtered before index limit',async()=>{
 const posts=[...Array.from({length:1200},(_,i)=>post('blocked'+i,{authorId:'blocked-one',
    impressions:1000,satisfied:995})),
  ...Array.from({length:60},(_,i)=>post('allowed'+i,{impressions:1000,satisfied:10})),
  ...Array.from({length:100},(_,i)=>post('cross'+i,{regionId:'abuja',impressions:1000,satisfied:900}))];
 const v=viewer({blockedAuthors:['blocked-one']}), fx=fixture(posts,v); const s=await open(fx);
 assert(s.order.some(x=>x.id.startsWith('allowed')));
 assert(s.order.every(x=>!x.id.startsWith('blocked')));
});

test('viewer-specific geographic restrictions are filtered before index limit',async()=>{
 const posts=[...Array.from({length:1000},(_,i)=>post('us'+i,{geo:{allow:['US']},
    impressions:1000,satisfied:990})),
  ...Array.from({length:45},(_,i)=>post('ng'+i,{geo:{allow:['NG']},impressions:1000,satisfied:10}))];
 const fx=fixture(posts); const s=await open(fx);
 assert(s.order.some(x=>x.id.startsWith('ng')));
 assert(s.order.every(x=>!x.id.startsWith('us')));
});

test('delayed index calls cannot perturb deterministic seeded ranking',async()=>{
 const posts=Array.from({length:260},(_,i)=>post('post'+i,{regionId:i%3===0?'lagos':'abuja',
    authorId:'u'+i,topics:i%4?['news']:['events']}));
 const runs=[];
 for (const delays of [[0,4,7,1,5,2],[8,1,0,5,3,7],[3,5,0,9,1,2]]) {
  const fx=fixture(posts);
  const names=['region','crossRegion','trending','newest','unproven','topic'];
  names.forEach((name,i)=>{
   const fn=fx.deps.index[name];
   fx.deps.index[name]=async (...args)=>{
    await new Promise(resolve=>setTimeout(resolve,delays[i]));
    return fn(...args);
   };
  });
  runs.push((await open(fx)).order);
 }
 assert.deepEqual(runs[0],runs[1]);assert.deepEqual(runs[0],runs[2]);
});

test('same post offered by multiple index buckets uses highest content version',async()=>{
 const old=post('x',{version:1}),fresh=post('x',{version:8});
 const fx=fixture([old,post('y')]);
 const idx=fx.deps.index;
 idx.region=async()=>[old];idx.topic=async()=>[fresh];
 idx.crossRegion=async()=>[];idx.trending=async()=>[];idx.newest=async()=>[];idx.unproven=async()=>[];
 const s=await open(fx);
 assert.equal(s.order.find(p=>p.id==='x').version,8);
});

test('store refuses forged serves or overstepping cursor without partial writes',async()=>{
 const fx=fixture([post('a'),post('b')]);const s=await open(fx);
 const base={viewerId:fx.v.id,expected:{refresh:s.refresh,cursor:s.cursor,rev:s.rev},cursor:1};
 await assert.rejects(()=>fx.store.recordServes(s.id,{...base,serves:[{
   serveId:'fabricated',postId:'not-in-session',version:1,servedAt:NOW}]}),RangeError);
 await assert.rejects(()=>fx.store.recordServes(s.id,{...base,cursor:200,serves:[]}),RangeError);
 await assert.rejects(()=>fx.store.recordServes(s.id,{...base,serves:[
 {serveId:'x1',postId:s.order[0].id,version:1,servedAt:NOW},
 {serveId:'x2',postId:s.order[0].id,version:1,servedAt:NOW}]}),RangeError);
 assert.equal((await fx.store.load(s.id)).cursor,0);
 assert.equal((await fx.store.history(s.id)).served.size,0);
});

test('empty index creates exhausted session and nextPage returns empty',async()=>{
 const fx=fixture([]);const s=await open(fx);
 assert.equal(s.tier,'exhausted');assert.equal(s.order.length,0);
 assert.deepEqual(await nextPage(fx.deps,s,fx.v,CTX,5),[]);
});

test('maxOrder is enforced and maxServeScan prevents unbounded authority scanning',async()=>{
 const conf=cfg({maxOrder:25,maxServeScan:3}),posts=Array.from({length:100},(_,i)=>post('p'+i));
 const fx=fixture(posts,viewer(),conf); const s=await open(fx);
 assert.equal(s.order.length,25);
 for(let i=0;i<10;i++)fx.records.get(s.order[i].id).moderation='removed';
 const first=await nextPage(fx.deps,s,fx.v,CTX,10);
 assert.equal(first.length,0);assert.equal(s.cursor,3);
 const second=await nextPage(fx.deps,s,fx.v,CTX,10);
 assert.equal(second.length,0);assert.equal(s.cursor,6);
});

test('recycled posts remain behind fresh and include seen-block exposures',async()=>{
 const p=post('previous');const q=post('new');const v=viewer({exposures:{previous:{count:2,lastViewedAt:NOW}}});
 const fx=fixture([p,q],v,cfg({minPool:20,minLocalPool:0}));const s=await open(fx);
 assert.equal(s.tier,'recycled');
 assert(s.order.find(x=>x.id==='previous').rank>0);
 assert.equal(s.order[0].id,'new');
});

test('unclaimed re-show is allowed only up to capped per-session count',async()=>{
 const fx=fixture([post('a')],viewer(),cfg({minPool:20,minLocalPool:0,maxServesPerSession:2}));
 const s=await open(fx);const first=await nextPage(fx.deps,s,fx.v,CTX,1);
 assert.equal(first.length,1);
 let next=await advanceSession(fx.deps,s,fx.v,{...CTX,now:NOW+2000});
 assert.equal(next.tier,'reshown');
 assert.equal(next.order[0].id,'a');
 const second=await nextPage(fx.deps,next,fx.v,{...CTX,now:NOW+2000},1);
 assert.equal(second.length,1);
 const third=await advanceSession(fx.deps,next,fx.v,{...CTX,now:NOW+4000});
 assert.equal(third.tier,'exhausted');
 assert.equal(third.order.length,0);
});

test('qualified claim prevents subsequent re-show in the same session',async()=>{
 const fx=fixture([post('a')],viewer(),cfg({minPool:20,minLocalPool:0}));
 let s=await open(fx);const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 await recordViews(fx.deps,s,fx.v,[{serveId:p[0].serveId,visibleMs:1200,visibleFraction:1}],NOW+2000);
 s=await advanceSession(fx.deps,s,fx.v,{...CTX,now:NOW+2500});
 assert.equal(s.tier,'exhausted');assert.equal(s.order.length,0);
});

test('failed view-commit write can be retried without losing receipt',async()=>{
 const fx=fixture([post('a')]);const s=await open(fx);const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 const ev=[{serveId:p[0].serveId,visibleMs:1200,visibleFraction:1}];
 fx.store.faults=1;
 await assert.rejects(()=>recordViews(fx.deps,s,fx.v,ev,NOW+2000),/store unavailable/);
 const retry=await recordViews(fx.deps,s,fx.v,ev,NOW+2000);
 assert.equal(retry.accepted.length,1);
});

test('large deterministic 2000-post fixture has cross-region fallback and safe ranking',async()=>{
 const posts=Array.from({length:2000},(_,i)=>post('p'+i,{
  regionId:i%4===0?'lagos':i%4===1?'abuja':i%4===2?'delta':'kano',
  topics:['t'+(i%421)],authorId:'u'+(i%180),
  satisfied:i%101,impressions:100,createdAt:NOW-1000-(i%70)*10000
 }));
 const v=viewer({interests:['t1','t2','t3','t4']});
 const f=fixture(posts,v);const s=await open(f);
 assert(s.order.length>0 && s.order.length<=BASE.maxOrder);
 assert(s.order.some(x=>posts.find(p=>p.id===x.id).regionId!=='lagos'));
 const p=await nextPage(f.deps,s,v,CTX,20);
 assert.equal(p.length,20);
 assert.equal(new Set(ids(p)).size,20);
});

test('production mode refuses experimental config',async()=>{
 const fx=fixture([post('a')]);const before=process.env.NODE_ENV;
 process.env.NODE_ENV='production';
 try{await assert.rejects(()=>open(fx),/ranking config is experimental/);}finally{
   if(before===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=before;
 }
});

test('randomized multi-refresh session flows: no served-after-claimed',async()=>{
 const rng=mulberry32(5913);
 for(let k=0;k<300;k++){
  const posts=Array.from({length:25},(_,i)=>post('p'+i,{regionId:i%3?'lagos':'other',
    authorId:'u'+(i%7),topics:i%2?['news']:['events']}));
  const fx=fixture(posts);let s=await open(fx);
  const claimed=new Set();
  for(let r=0;r<3;r++){
   const page=await nextPage(fx.deps,s,fx.v,{...CTX,now:NOW+r*20000},5);
   assert(page.every(x=>!claimed.has(x.post.id)));
   const ev=page.filter(()=>rng()<.75).map(x=>({serveId:x.serveId,visibleMs:1500,visibleFraction:1}));
   const resp=await refreshSession(fx.deps,s,fx.v,{...CTX,now:NOW+r*20000+10000},ev);
   resp.accepted.forEach(x=>claimed.add(x));s=resp.session;
  }
 }
});

test('store denies duplicate receipt IDs before writing a delivery batch',async()=>{
 const fx=fixture([post('a'),post('b')]);const s=await open(fx);
 await assert.rejects(()=>fx.store.recordServes(s.id,{
  viewerId:fx.v.id,expected:{refresh:s.refresh,cursor:s.cursor,rev:s.rev},cursor:2,serves:[
  {serveId:'same',postId:s.order[0].id,version:1,servedAt:NOW},
  {serveId:'same',postId:s.order[1].id,version:1,servedAt:NOW}
 ]}),RangeError);
 assert.equal((await fx.store.history(s.id)).served.size,0);
});

test('store denies claim exposure misattribution and retains unredeemed receipt',async()=>{
 const fx=fixture([post('a'),post('b')]);const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,1);
 const bad={sessionId:s.id,viewerId:fx.v.id,consume:[p[0].serveId],
  accept:[{serveId:p[0].serveId,postId:'another-post'}],claims:[],receivedAt:NOW+2000,
  halfLifeH:168,ttlMs:1800000,expectedSpentMs:0};
 await assert.rejects(()=>fx.store.commitViews(bad),RangeError);
 const good=await recordViews(fx.deps,s,fx.v,[{serveId:p[0].serveId,visibleMs:1200,visibleFraction:1}],NOW+2000);
 assert.equal(good.accepted.length,1);
 assert.equal((await fx.store.exposures(fx.v.id))['another-post'],undefined);
});

test('store denies invalid or negative view-cost writes',async()=>{
 const fx=fixture([post('a')]);const s=await open(fx);
 const p=await nextPage(fx.deps,s,fx.v,CTX,1);const sid=p[0].serveId;
 const invalid={sessionId:s.id,viewerId:fx.v.id,consume:[sid],accept:[],
  claims:[{serveId:sid,viewerId:fx.v.id,postId:p[0].post.id,version:1,
  servedAt:NOW,receivedAt:NOW+2000,visibleMs:0,visibleFraction:1,costMs:-10,outcome:'below_threshold'}],
  receivedAt:NOW+2000,halfLifeH:168,ttlMs:1800000,expectedSpentMs:0};
 await assert.rejects(()=>fx.store.commitViews(invalid),RangeError);
 assert.equal((await fx.store.receipts(s.id,[sid])).get(sid).redeemed,false);
});

test('opaque post IDs cannot cause prototype pollution or corrupt exposure records',async()=>{
 for(const id of ['__proto__','constructor','toString','hasOwnProperty','normal-id']){
  const p=post(id),fx=fixture([p]);const s=await open(fx);
  const page=await nextPage(fx.deps,s,fx.v,CTX,1);
  assert.equal(page[0].post.id,id);
  const v=await recordViews(fx.deps,s,fx.v,[{serveId:page[0].serveId,visibleMs:1200,visibleFraction:1}],NOW+2000);
  assert.deepEqual(v.accepted,[id]);
  const e=await fx.store.exposures(fx.v.id);
  assert(Object.hasOwn(e,id));
  assert.equal(e[id].count,1);
  assert(Object.hasOwn(fx.v.exposures,id));
  const restored=new MemoryStore(fx.store.dump());
  assert(Object.hasOwn(await restored.exposures(fx.v.id),id));
 }
});
