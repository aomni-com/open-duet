#!/usr/bin/env python3
"""Pinned-image extension-native tab freeze/discard experiment."""

from __future__ import annotations

import http.server
import json
import os
import pathlib
import subprocess
import threading
import time
import urllib.request
from typing import Any

BROKER = "http://127.0.0.1:18766"
SAMPLE_SECONDS = 4.0
COUNT = 3

HTML = """<!doctype html><meta charset=utf-8><title>Duet suspension candidate</title>
<div id=marker>dom-initial</div><script>
const navigationCount = Number(sessionStorage.getItem('navigationCount') || 0) + 1;
sessionStorage.setItem('navigationCount', String(navigationCount));
const loadToken = crypto.randomUUID();
window.__duetProbe = {ticks: 0, navigationCount, memoryMarker: 'memory-'+loadToken};
document.querySelector('#marker').textContent='dom-'+loadToken;
if (!sessionStorage.getItem('sessionMarker')) sessionStorage.setItem('sessionMarker','session-persistent');
if (!localStorage.getItem('localMarker')) localStorage.setItem('localMarker','local-persistent');
const workerSource = `for (;;) { const end = performance.now() + 36; while (performance.now() < end) Math.sqrt(Math.random()); }`;
window.__duetBusyWorker = new Worker(URL.createObjectURL(new Blob([workerSource], {type:'text/javascript'})));
document.title='DUET_SUSPENSION_TICK_0';
setInterval(() => { window.__duetProbe.ticks++; document.title='DUET_SUSPENSION_TICK_'+window.__duetProbe.ticks; const end=performance.now()+36;
while(performance.now()<end) Math.sqrt(Math.random()); }, 50);
</script>"""
CONTROL = "<!doctype html><title>Duet protected control</title><h1>protected</h1>"

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = (CONTROL if self.path.startswith('/control') else HTML).encode()
        self.send_response(200); self.send_header('content-type','text/html')
        self.send_header('content-length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *_args): pass

def command(body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(BROKER + '/command', data=json.dumps(body).encode(), headers={'content-type':'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response: return json.load(response)

def snapshot() -> dict[str, Any]: return command({'command':'snapshot'})['result']

def tab(snapshot_value: dict[str, Any], tab_id: int) -> dict[str, Any]:
    return next(t for w in snapshot_value['windows'] for t in w['tabs'] if t['id'] == tab_id)

def maybe_tab(snapshot_value: dict[str, Any], tab_id: int):
    return next((t for w in snapshot_value['windows'] for t in w['tabs'] if t['id'] == tab_id), None)

def proc_snapshot():
    processes={}
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit(): continue
        try:
            f=(entry/'stat').read_text().split(); cmd=(entry/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace')
            processes[int(f[0])] = (int(f[3]), int(f[13])+int(f[14]), int(f[23])*os.sysconf('SC_PAGE_SIZE'), cmd)
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError): pass
    roots={pid for pid,v in processes.items() if '--remote-debugging-port=9222' in v[3] and '--type=' not in v[3]}
    selected=set(roots)
    while True:
        before=len(selected); selected.update(pid for pid,v in processes.items() if v[0] in selected)
        if len(selected)==before: break
    return {pid:(processes[pid][1],processes[pid][2],'--type=renderer' in processes[pid][3]) for pid in selected}

def sample():
    start=proc_snapshot(); began=time.monotonic(); time.sleep(SAMPLE_SECONDS); elapsed=time.monotonic()-began; end=proc_snapshot()
    common=set(start)&set(end); hz=os.sysconf('SC_CLK_TCK')
    return {'rendererCpuCores':sum(max(0,end[p][0]-start[p][0]) for p in common if end[p][2])/hz/elapsed,
      'totalChromeCpuCores':sum(max(0,end[p][0]-start[p][0]) for p in common)/hz/elapsed,
      'rendererRssBytes':sum(v[1] for v in end.values() if v[2]),'totalChromeRssBytes':sum(v[1] for v in end.values())}

def extension_state(tab_id):
    deadline=time.monotonic()+10; last=None
    while time.monotonic()<deadline:
        response=command({'command':'readState','tabId':tab_id}); last=response
        result=response.get('result')
        if isinstance(result,dict) and result.get('timer') is not None: return result
        time.sleep(.05)
    raise RuntimeError(f'extension could not read restored tab {tab_id}: {last}')

def evidence(before, after, original, frozen_or_discarded, mode):
    common={'tabId':original['id'],'windowId':original['windowId'],'url':original['url'],'targetIdBefore':original['targetId'],
      'targetIdAfter':after['targetId'],'timerBefore':before['timer'],'timerAfterActivation':after['state']['timer'],
      'navigationBefore':before['navigation'],'navigationAfter':after['state']['navigation'],'memoryMarkerBefore':before['memory'],
      'memoryMarkerAfter':after['state']['memory'],'domMarkerBefore':before['dom'],'domMarkerAfter':after['state']['dom'],
      'sessionStorageBefore':before['session'],'sessionStorageAfter':after['state']['session'],'localStorageBefore':before['local'],'localStorageAfter':after['state']['local']}
    if mode=='freeze': common.update({'targetIdFrozen':frozen_or_discarded['targetId'],'frozenObserved':frozen_or_discarded['frozen'], 'frozenAfterActivation':after['frozen'], 'timerAfter':int(frozen_or_discarded['title'].removeprefix('DUET_SUSPENSION_TICK_'))})
    else: common.update({'replacementTabId':frozen_or_discarded['id'],'tabRetained':frozen_or_discarded.get('present',True) and frozen_or_discarded['windowId']==original['windowId'] and frozen_or_discarded['url']==original['url'],'targetIdDiscarded':frozen_or_discarded.get('targetId'),'discardedObserved':frozen_or_discarded['discarded'],'discardedAfterActivation':after['discarded']})
    return common

def main():
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler); threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}'
    try:
      control_info=command({'command':'createControl','url':base+'/control'})['result']; command({'command':'createLanding','windowId':control_info['windowId']})
      created=[]
      for index in range(COUNT):
          url=f'{base}/candidate?index={index}'; item=command({'command':'createWindow','url':url})['result']; created.append(item)
      for item in created: extension_state(item['tabId'])
      command({'command':'activateTab','tabId':control_info['tabId'],'windowId':control_info['windowId']})
      precondition=snapshot(); originals=[tab(precondition,i['tabId']) for i in created]; landings=[tab(precondition,i['landingTabId']) for i in created]
      if any(item['active'] for item in originals) or any(not item['active'] for item in landings): raise RuntimeError(f'candidate/landing active precondition failed: candidates={originals}, landings={landings}')
      before=[extension_state(i['tabId']) for i in created]
      active=sample()
      active_freeze=command({'command':'freezeTab','tabId':control_info['tabId']})
      protected_freeze=maybe_tab(snapshot(),control_info['tabId'])
      freeze_commands=[command({'command':'freezeTab','tabId':item['tabId']}) for item in created]
      frozen_snap=snapshot(); frozen_tabs=[tab(frozen_snap,i['tabId']) for i in created]; frozen=sample()
      for item in created: command({'command':'activateTab','tabId':item['tabId'],'windowId':item['windowId']})
      freeze_after=[]
      for item in created:
          state=extension_state(item['tabId']); now=tab(snapshot(),item['tabId']); now['state']=state; freeze_after.append(now)
      freeze_evidence=[evidence(b,a,o,f,'freeze') for b,a,o,f in zip(before,freeze_after,originals,frozen_tabs)]
      command({'command':'activateTab','tabId':control_info['tabId'],'windowId':control_info['windowId']}); time.sleep(.5)
      for item in created: command({'command':'selectTab','tabId':item['landingTabId']})
      discard_precondition=snapshot(); discard_before=[extension_state(i['tabId']) for i in created]; discard_originals=[tab(discard_precondition,i['tabId']) for i in created]; discard_landings=[tab(discard_precondition,i['landingTabId']) for i in created]
      if any(item['active'] for item in discard_originals) or any(not item['active'] for item in discard_landings): raise RuntimeError(f'discard candidate/landing active precondition failed: candidates={discard_originals}, landings={discard_landings}')
      protected_discard=maybe_tab(snapshot(),control_info['tabId'])
      discard_commands=[command({'command':'discardTab','tabId':item['tabId']}) for item in created]
      discarded_snap=snapshot(); discarded_tabs=[]
      for original,response in zip(discard_originals,discard_commands):
          replacement_id=response.get('result',{}).get('tabId',original['id']); found=maybe_tab(discarded_snap,replacement_id)
          discarded_tabs.append(found if found else {**original,'id':replacement_id,'present':False,'discarded':False,'targetId':None})
      discarded=sample()
      for item,discarded_tab in zip(created,discarded_tabs):
          if discarded_tab.get('present',True): command({'command':'activateTab','tabId':discarded_tab['id'],'windowId':item['windowId']})
      discard_after=[]
      for item,discarded_tab,before_state in zip(created,discarded_tabs,discard_before):
          if not discarded_tab.get('present',True):
            discard_after.append({**discarded_tab,'targetId':'','discarded':False,'state':{**before_state,'memory':None,'navigation':before_state['navigation'],'timer':before_state['timer']}}); continue
          state=extension_state(discarded_tab['id']); now=tab(snapshot(),discarded_tab['id']); now['state']=state; discard_after.append(now)
      discard_evidence=[evidence(b,a,o,d,'discard') for b,a,o,d in zip(discard_before,discard_after,discard_originals,discarded_tabs)]
      return {'schemaVersion':1,'imageRef':os.environ['IMAGE_REF'],'chromeVersion':subprocess.check_output(['google-chrome-stable','--version'],text=True).strip(),
          'workload':{'candidateCount':COUNT,'sampleDurationMs':int(SAMPLE_SECONDS*1000)},'active':active,'frozen':frozen,
          'freeze':{'commands':freeze_commands,'candidates':freeze_evidence,'activeTab':{'tabId':control_info['tabId'],'updateRejected':bool(active_freeze.get('result',{}).get('error')),'remainedActive':bool(protected_freeze and protected_freeze['active']),'remainedUnfrozen':bool(protected_freeze and not protected_freeze['frozen'])}},
          'discarded':discarded,'discard':{'commands':discard_commands,'candidates':discard_evidence,'activeTab':{'tabId':control_info['tabId'],'policySkipped':True,'remainedActive':bool(protected_discard and protected_discard['active']),'remainedUndiscarded':bool(protected_discard and not protected_discard['discarded'])}}}
    finally: server.shutdown()

print(json.dumps(main(),sort_keys=True))
