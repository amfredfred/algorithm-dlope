import {
  EXPERIMENTAL_CONFIG, MemoryStore, buildAuthority, buildIndex, createPolicyGate,
  type Config, type Context, type Deps, type Index, type Post, type Viewer, type ViewerPolicy,
} from '../src/index.js';

export const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const H = 3_600_000;
export const CTX: Context = {surface:'home', now: NOW};
export function cfg(over: Partial<Config> = {}): Config {
  return {...structuredClone(EXPERIMENTAL_CONFIG), ...over};
}
export function post(i: number|string, over: Partial<Post> = {}): Post {
  const id = `p-${i}`;
  return {
    id, authorId: `author-${i}`, regionId:'local', topics:['a'], createdAt: NOW-H,
    impressions:100, satisfied:20, version:1, moderation:'approved',
    visibility:'public', geo:null, expiresAt:null, minAge:null, feedEligible:true, ...over,
  };
}
export function viewer(over: Partial<Viewer> = {}): Viewer {
  return { id:'viewer', regionId:'local', jurisdiction:'NG', age:30, interests:['a'],
           hiddenAuthors:[],hiddenPosts:[],blockedAuthors:[],blockedBy:[],exposures:{},...over };
}
export function policy(v: Viewer): ViewerPolicy {
  return {jurisdiction:v.jurisdiction,age:v.age,hiddenAuthors:v.hiddenAuthors,hiddenPosts:v.hiddenPosts,
    blockedAuthors:v.blockedAuthors,blockedBy:v.blockedBy};
}
export function rig(posts:Post[], v:Viewer=viewer(), c:Config=cfg(), wrap?:(index:Index)=>Index) {
  const store = new MemoryStore();
  store.seedExposures(v.id,v.exposures);
  const records = new Map(posts.map(p=>[p.id,structuredClone(p)]));
  const policies = new Map([[v.id, policy(v)]]);
  const index = buildIndex(posts,c,NOW);
  const errors: {where:string,error:unknown}[]=[];
  const deps: Deps = {
     cfg:c, index:wrap?.(index)??index, authority:buildAuthority(records,policies),
     store, gate:createPolicyGate(c.futureSkewMs),onError:(where,error)=>{errors.push({where,error});}
  };
  return {deps,store,records,policies,errors,viewer:v,cfg:c};
}
export function posts(n:number,over:Partial<Post>={}):Post[]{return Array.from({length:n},(_,i)=>post(i,over));}
export function seeded(n:number){let s=n>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/2**32;};}
export const isPermutation=(a:readonly string[],b:readonly string[])=>a.length===b.length&&
 a.slice().sort().every((v,i)=>v===b.slice().sort()[i]);
