import { createModelGatewayApp } from '../../../../../apps/model-gateway/src/index.ts'
import { createApprovedModelCatalog } from '../../../../../packages/contract/src/approved-models/catalog.ts'
import { APPROVED_MODEL_ENTRIES } from './baseline-data.ts'
const catalog = createApprovedModelCatalog(APPROVED_MODEL_ENTRIES)
const rows=[]
for (const model of ['openai/gpt-5.6-luna','openai/gpt-6-luna']) {
 for (const tier of [undefined,'economy']) {
  let preflights=0, upstreams=0
  const app=createModelGatewayApp({approvedModelCatalog:catalog,aiGatewayApiKey:'fixture',preflight:async()=>{preflights++;return {proceed:true}},fetch:async()=>{upstreams++;return Response.json({choices:[]})}})
  const response=await app.request('/v1/responses',{method:'POST',headers:{authorization:'Bearer [REDACTED]','content-type':'application/json',...(tier?{'x-duet-tier':tier}:{})},body:JSON.stringify({model,input:'fixture'})})
  rows.push({model,tier:tier??null,status:response.status,preflights,upstreams,body:await response.json()})
 }
}
console.log(JSON.stringify({scope:'Current request app with baseline HEAD catalog, controlled preflight and upstream; no network inference',rows},null,2))
