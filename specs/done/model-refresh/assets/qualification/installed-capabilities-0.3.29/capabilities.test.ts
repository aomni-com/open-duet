import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const {Type}=await import('/work/node_modules/typebox');
const base='/work/node_modules/@duetso/agent/dist/src';
const {resolveModelName}=await import(base+'/model-resolution/resolver.js');
const {duetModels}=await import(base+'/model-resolution/models.js');
const {generateStructuredOutput}=await import(base+'/core/structured-output.js');
const {Session}=await import(base+'/session/session.js');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
const image={type:'image',data:png,mimeType:'image/png'};
const schema=Type.Object({sum:Type.Number(),code:Type.String()},{additionalProperties:false});
const tool={name:'submit_solution',description:'Return the checkable solution',parameters:schema};
const solution={sum:42,code:'export function add(a, b) { return a + b; }'};
const receipts=[];
const corrupt=process.env.FALSIFY;
const completion=(api,model,name,args,id='call_capability')=>{
 const json=JSON.stringify(args);let events;
 if(api==='openai-responses'){
  const item={id:'fc_'+id,type:'function_call',call_id:id,name,arguments:json,status:'completed'};
  events=[{type:'response.created',response:{id:'resp_capability',status:'in_progress',model,output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,arguments:'',status:'in_progress'}},{type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:json},{type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:json},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_capability',status:'completed',model,output:[item],usage:{input_tokens:12,output_tokens:8,total_tokens:20,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
 }else if(api==='anthropic-messages'){
  events=[{type:'message_start',message:{id:'msg_capability',type:'message',role:'assistant',model,content:[],stop_reason:null,usage:{input_tokens:12,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id,name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:json}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:8}},{type:'message_stop'}];
 }else{
  events=[{id:'chat_capability',object:'chat.completion.chunk',created:0,model,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:json}}]},finish_reason:null}]},{id:'chat_capability',object:'chat.completion.chunk',created:0,model,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}];
 }
 return new Response(events.map(e=>(e.type?'event: '+e.type+'\n':'')+'data: '+JSON.stringify(e)+'\n\n').join('')+(api==='openai-completions'?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}});
};
function checkPayload(payload,model,effort,withImage,forced=false){
 expect(payload.model).toBe(model.id);
 const api=model.api;const wiredTool=api==='anthropic-messages'?payload.tools?.[0]:api==='openai-responses'?payload.tools?.[0]:payload.tools?.[0]?.function;
 expect(wiredTool?.name).toBe(tool.name);
 const wiredSchema=api==='anthropic-messages'?wiredTool?.input_schema:wiredTool?.parameters;
 expect(wiredSchema?.required).toEqual(['sum','code']);
 expect(wiredSchema?.properties).toEqual({sum:{type:'number'},code:{type:'string'}});
 const content=api==='openai-responses'?payload.input[0].content:payload.messages[0].content;
 if(withImage){
  const block=content.find(x=>x.type===(api==='anthropic-messages'?'image':api==='openai-responses'?'input_image':'image_url'));
  expect(block).toBeDefined();
  if(api==='anthropic-messages')expect(block.source).toMatchObject({type:'base64',media_type:'image/png',data:png});
  else expect(api==='openai-responses'?block.image_url:block.image_url.url).toBe('data:image/png;base64,'+png);
 }
 if(api==='anthropic-messages'){
  expect(payload.thinking).toMatchObject({type:'adaptive'});
  expect(payload.output_config?.effort).toBe(effort==='xhigh'?'max':effort);
 }else if(model.provider==='openrouter'||api==='openai-responses')expect(payload.reasoning?.effort).toBe(effort);
 else expect(payload.reasoning_effort).toBe(effort);
 expect(payload.temperature).toBeUndefined();
 if(forced)expect(payload.tool_choice).toEqual(api==='openai-responses'?{type:'function',name:tool.name}:api==='anthropic-messages'?{type:'tool',name:tool.name}:{type:'function',function:{name:tool.name}});
}
function wirePayload(payload){const p=structuredClone(payload);if(corrupt==='tools')p.tools=[];if(corrupt==='reasoning'){delete p.reasoning;delete p.reasoning_effort;delete p.thinking;delete p.output_config;}if(corrupt==='vision'){for(const m of p.input??p.messages??[])if(Array.isArray(m.content))m.content=m.content.filter(c=>!['image','input_image','image_url'].includes(c.type));}return p;}
const targets=['anthropic/claude-opus-5.5','openai/gpt-6-sol','openai/gpt-6-luna','spacexai/grok-4.7','zai/glm-5.3'];
for(const provider of ['duet-gateway','vercel-ai-gateway','openrouter'])for(const target of targets){
 const id=provider==='openrouter'?target.replace('spacexai/','x-ai/').replace('zai/','z-ai/'):target;
 test(`actor tool/image/effort wire: ${provider}:${id}`,async()=>{
  const model=resolveModelName(provider+':'+id);const effort=target.includes('glm-')&&provider!=='openrouter'?'xhigh':'high';const withImage=!target.includes('glm-');let captured;
  const stream=duetModels().streamSimple(model,{tools:[tool],messages:[{role:'user',content:[{type:'text',text:'Return add(19,23) and exported add(a,b).'},...(withImage?[image]:[])],timestamp:0}]},{apiKey:'controlled-key',reasoning:effort,onPayload:wirePayload,fetch:async(input,init)=>{const body=JSON.parse(init.body);captured={url:String(input),body};if(corrupt)await writeFile('/receipt/falsified-'+corrupt+'-request.json',JSON.stringify(captured,null,2));return completion(model.api,model.id,tool.name,solution);}});
  const result=await stream.result();
  expect(result.stopReason).toBe('toolUse');expect(result.content.find(x=>x.type==='toolCall')?.arguments).toEqual(solution);
  checkPayload(captured.body,model,effort,withImage);
  receipts.push({kind:'actor',selection:provider+':'+id,api:model.api,effort,withImage,result:solution,request:captured});
 });
}
for(const provider of ['duet-gateway','vercel-ai-gateway','openrouter']){
 test(`structured caller exact low reasoning and checked solution: ${provider}:luna`,async()=>{
  const model=resolveModelName(provider+':luna');let captured;
  const result=await generateStructuredOutput({model:provider+':luna',tool,prompt:[{type:'text',text:'Return add(19,23) and exported add(a,b).'},image],callOptions:{apiKey:'controlled-key',reasoningEffort:'low',onPayload:wirePayload,fetch:async(input,init)=>{const body=JSON.parse(init.body);captured={url:String(input),body};if(corrupt)await writeFile('/receipt/falsified-'+corrupt+'-request.json',JSON.stringify(captured,null,2));return completion(model.api,model.id,tool.name,corrupt==='result'?{sum:'wrong',code:solution.code}:solution);}}});
  expect(result).toEqual(solution);checkPayload(captured.body,model,'low',true,true);
  const module=await import('data:text/javascript,'+encodeURIComponent(result.code));expect(module.add(19,23)).toBe(42);expect(module.add(-7,2)).toBe(-5);
  receipts.push({kind:'structured',selection:provider+':luna',api:model.api,effort:'low',result,checkableCodeResults:[42,-5],request:captured});
 });
}
test('ordinary Sol coding task executes write and bash tools and produces checked file output',async()=>{
 const cwd=await mkdtemp('/tmp/coding-capability-');const previous=process.env.DUET_GATEWAY_BASE_URL;const requests=[];let calls=0;
 const server=Bun.serve({port:0,async fetch(request){
  const body=await request.json();requests.push(body);calls++;
  if(calls===1)return completion('openai-responses',body.model,'write',{path:'add.js',content:corrupt==='coding'?'export function add(a, b) { return a - b; }':solution.code},'write_code');
  if(calls===2)return completion('openai-responses',body.model,'bash',{command:'bun -e \"import {add} from \\\"./add.js\\\"; if(add(19,23)!==42 || add(-7,2)!==-5) throw Error(\\\"wrong sum\\\"); console.log(\\\"CHECKED_SUM=42\\\");\"'},'run_code');
  const item={id:'msg_done',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'CHECKED_SUM=42',annotations:[]}]};
  const events=[{type:'response.created',response:{id:'r_done',status:'in_progress',model:body.model,output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:'CHECKED_SUM=42'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'r_done',status:'completed',model:body.model,output:[item],usage:{input_tokens:12,output_tokens:8,total_tokens:20}}}];
  return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }});
 process.env.DUET_GATEWAY_BASE_URL=server.url.toString();
 await mkdir(join(cwd,'session'));
 const session=new Session({cwd,model:'duet-gateway:sol',memoryModel:'duet-gateway:luna',thinkingLevel:'high',incognito:true,mode:'agent',skillDiscovery:{includeDefaults:false}},{id:'coding',sessionPath:join(cwd,'session')});
 try{
  await session.start();await session.prompt({message:'Write add.js exporting add(a,b), then use bash to check add(19,23)=42 and add(-7,2)=-5. Report CHECKED_SUM=42.'});
  const terminal=await session.waitForTerminal();expect(terminal.type).toBe('complete');
  const toolResults=terminal.state.agent.messages.filter(m=>m.role==='toolResult');
  if(corrupt==='coding')await writeFile('/receipt/falsified-coding-result.json',JSON.stringify(toolResults,null,2));
  expect(toolResults.every(m=>m.isError!==true)).toBe(true);
  expect(await readFile(join(cwd,'add.js'),'utf8')).toBe(solution.code);
  expect(JSON.stringify(toolResults)).toContain('CHECKED_SUM=42');
  expect(requests.every(r=>r.model==='openai/gpt-6-sol'&&r.reasoning?.effort==='high')).toBe(true);
  expect(requests[0].tools.map(t=>t.name)).toEqual(expect.arrayContaining(['write','bash']));
  expect(requests[2].input.some(x=>x.type==='function_call_output'&&String(x.output).includes('CHECKED_SUM=42'))).toBe(true);
  receipts.push({kind:'coding-tool-loop',selection:'duet-gateway:sol',model:'openai/gpt-6-sol',effort:'high',requests:requests.map(r=>({model:r.model,reasoning:r.reasoning,tools:r.tools.map(t=>t.name),toolOutputs:r.input.filter(x=>x.type==='function_call_output')})),fileContent:solution.code,checkedOutput:'CHECKED_SUM=42',simulatedModelDecisions:true});
 }finally{await session.dispose();server.stop(true);if(previous===undefined)delete process.env.DUET_GATEWAY_BASE_URL;else process.env.DUET_GATEWAY_BASE_URL=previous;await rm(cwd,{recursive:true,force:true});}
},15000);
test('write durable controlled-request receipt',async()=>{await writeFile('/receipt/capabilities-'+(corrupt??'green')+'.json',JSON.stringify({packageVersion:'0.3.29',simulatedModelResponses:true,liveProviderCalls:false,receipts},null,2));});
