import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import baseline from './baseline-routing.json'
const require=createRequire(new URL('../../../../../package.json', import.meta.url))
const root=dirname(require.resolve('@duetso/agent/package.json'))
const {validateRoutingTable}=await import(root+'/dist/src/model-routing/table.js')
const {routingCatalogAdapter,resolveModelName}=await import(root+'/dist/src/model-resolution/resolver.js')
const rows=[]
for(const name of ['gpt-6-sol','sol','gpt-6-luna','luna','opus-5.5','opus']) {
 const table=structuredClone(baseline.table)
 const target={modelName:name,thinkingLevel:'medium'}
 table.tiers['fixture-provider']={routes:{general:{description:'fixture',target}},advisor:{enabled:false,target,minStepsBetween:5}}
 rows.push({name,issues:validateRoutingTable(table,routingCatalogAdapter),resolved:resolveModelName('duet-gateway:'+name)?.id})
}
console.log(JSON.stringify({agentVersion:require('@duetso/agent/package.json').version,rows},null,2))
