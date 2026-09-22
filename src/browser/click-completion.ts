import type { BrowserEngine } from './engine.js';

const snapshot = `({url:location.href,title:document.title,document_id:performance.timeOrigin,ready:document.readyState!=='loading'&&!!document.body&&(!!document.body.innerText.trim()||!!document.querySelector('canvas,svg')),signature:(document.querySelector('main')?.innerText||document.body?.innerText||'').slice(0,2000)})`;
type State = {url:string;title:string;document_id:number;ready:boolean;signature:string};
export async function captureClickState(engine: BrowserEngine) {
  const tabs = await engine.listTabs();
  const state = await engine.evaluate(snapshot);
  return {tabs, state:state.result as State|undefined};
}

/** Observe completion without ever dispatching a second click or navigating to a guessed href. */
export async function completeClick(engine: BrowserEngine, before: Awaited<ReturnType<typeof captureClickState>>, options: {wait_for?:'auto'|'navigation'|'none';wait_until?:string;wait_timeout_ms?:number;follow_new_tab?:boolean} = {}) {
  if (options.wait_for === 'none') return {clicked:true,verified:false,navigation:'not_waited'};
  const deadline = Date.now() + Math.min(30000, Math.max(500, options.wait_timeout_ms ?? 10000));
  const discoveryDeadline = Math.min(deadline, Date.now()+1500);
  const ids = new Set(before.tabs.map(t=>t.id));
  const activeId = before.tabs.find(t=>t.isActive)?.id;
  let newTabId:string|undefined, navigation=false, previous='', stableSince=0;
  let last:State|undefined;
  do {
    if (await engine.nextDialog()) return {clicked:true,verified:false,dialog_pending:true,navigation:'pending_dialog'};
    const tabs = await engine.listTabs();
    const opened = tabs.filter(t=>!ids.has(t.id) && t.openerId===activeId);
    if (!newTabId && opened.length) {
      if (opened.length!==1 || options.follow_new_tab===false) return {clicked:true,verified:false,navigation:'new_tabs',new_tabs:opened};
      newTabId=opened[0].id;
      await engine.switchTab(newTabId);
      navigation=true;
    }
    const read=await engine.evaluate(snapshot);
    if(read.ok && read.result) {
      last=read.result as State;
      navigation ||= !!before.state && (last.url!==before.state.url || last.document_id!==before.state.document_id);
      const condition = options.wait_until ? (await engine.evaluate(`Boolean(${options.wait_until})`)).result===true : true;
      const signature=JSON.stringify(last);
      if(signature!==previous){previous=signature;stableSince=Date.now();}
      if(last.ready && condition && (navigation||!!options.wait_until) && Date.now()-stableSince>=400) {
        return {clicked:true,verified:true,verification:options.wait_until?'predicate':'rendered_destination',navigation:navigation?'completed':'none_observed',url:last.url,title:last.title,page_id:newTabId??activeId};
      }
      if(!navigation && !options.wait_until && options.wait_for!=='navigation' && Date.now()>=discoveryDeadline) return {clicked:true,verified:false,navigation:'none_observed',url:last.url};
    }
    await engine.waitMs(100);
  } while(Date.now()<deadline);
  return {clicked:true,verified:false,navigation:navigation?'pending':'none_observed',wait_timed_out:true,url:last?.url,page_id:newTabId??activeId,retry_safe:false};
}
