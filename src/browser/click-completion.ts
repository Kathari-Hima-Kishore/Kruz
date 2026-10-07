import type { BrowserEngine } from './engine.js';
import { readEffect, type ElementEffect } from './inpage-matcher.js';

const snapshot = `({url:location.href,title:document.title,document_id:performance.timeOrigin,ready:document.readyState!=='loading'&&!!document.body&&(!!document.body.innerText.trim()||!!document.querySelector('canvas,svg')),signature:(document.querySelector('main')?.innerText||document.body?.innerText||'').slice(0,2000)})`;
type State = {url:string;title:string;document_id:number;ready:boolean;signature:string};
export async function captureClickState(engine: BrowserEngine) {
  // Speed (goal #2): the tab list and the DOM snapshot are independent — fetch
  // them concurrently instead of serially (saves ~1 CDP round trip per click).
  const [tabs, snap] = await Promise.all([engine.listTabs(), engine.evaluate(snapshot)]);
  return { tabs, state: snap.result as State | undefined };
}

/**
 * Observe completion without ever dispatching a second click or navigating to a guessed href.
 *
 * `effectToken` is the element the click was dispatched on. The manual report's
 * Bug 6 is the reason it exists: dismissing an Oracle cookie banner removed the
 * banner, left the URL, title, document and the first 2000 characters of body
 * text completely unchanged, and was therefore reported as
 * `clicked: true, verified: false` — forcing the model to spend an extra
 * `page.probe` to prove the thing it had just watched disappear.
 *
 * "The element I clicked is gone (or hidden, or changed state)" is an
 * observable browser-level effect and is now a first-class postcondition. It
 * proves the click caused a transition; it does not claim the caller's
 * high-level goal was achieved, which is why it is reported as its own
 * `verification` value rather than being folded into a generic "success".
 */
export async function completeClick(engine: BrowserEngine, before: Awaited<ReturnType<typeof captureClickState>>, options: {wait_for?:'auto'|'navigation'|'none';wait_until?:string;wait_timeout_ms?:number;follow_new_tab?:boolean;effect_token?:string} = {}) {
  if (options.wait_for === 'none') return {clicked:true,verified:false,navigation:'not_waited'};
  const deadline = Date.now() + Math.min(30000, Math.max(500, options.wait_timeout_ms ?? 10000));
  const discoveryDeadline = Math.min(deadline, Date.now()+1500);
  const ids = new Set(before.tabs.map(t=>t.id));
  const activeId = before.tabs.find(t=>t.isActive)?.id;
  let newTabId:string|undefined, navigation=false, previous='', stableSince=0;
  let last:State|undefined;
  const token = options.effect_token;
  // The effect read is independent of the page snapshot, so the first one is
  // free (issued concurrently) and later ones only happen while we are still
  // undecided.
  let pending: Promise<ElementEffect> | null = token ? readEffect(engine, token) : null;
  let effect: ElementEffect | null = null;
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
    if(pending){ try { effect = await pending; } catch { effect = null; } pending = null; }
    if(read.ok && read.result) {
      last=read.result as State;
      navigation ||= !!before.state && (last.url!==before.state.url || last.document_id!==before.state.document_id);
      // A click that changes the page WITHOUT navigating — opening a menu,
      // expanding a panel, revealing a filtered list, toggling a dialog — is a
      // successful click. Previously only navigation (or an explicit predicate)
      // could ever set verified:true, so those clicks reported verified:false and
      // burned the whole discovery window. Compare against the PRE-click
      // snapshot to tell "the page changed" from "the page is static".
      const changed = !!before.state
        && (last.url !== before.state.url
          || last.document_id !== before.state.document_id
          || last.signature !== before.state.signature
          || last.title !== before.state.title);
      const condition = options.wait_until ? (await engine.evaluate(`Boolean(${options.wait_until})`)).result===true : true;
      const signature=JSON.stringify(last);
      if(signature!==previous){previous=signature;stableSince=Date.now();}
      if(last.ready && condition && (navigation||!!options.wait_until) && Date.now()-stableSince>=400) {
        return {clicked:true,verified:true,verification:options.wait_until?'predicate':'rendered_destination',navigation:navigation?'completed':'none_observed',url:last.url,title:last.title,page_id:newTabId??activeId};
      }
      // In-place content change that has settled: verified, no navigation.
      // D1: a real navigation (url or document change) must NEVER report as
      // in_place_change — the rendered_destination branch above owns those.
      if(last.ready && !options.wait_until && options.wait_for!=='navigation' && changed && !navigation && Date.now()-stableSince>=250) {
        return {clicked:true,verified:true,verification:'in_place_change',navigation:'none_observed',url:last.url,title:last.title,page_id:newTabId??activeId};
      }
      // ── target-effect postcondition (Bug 6) ──────────────────────────────
      // The clicked element disappeared, or its overlay/dialog root did. This is
      // the generic dismissal case: no navigation, no body-text change, and yet an
      // unmistakable browser-level effect.
      //
      // `navigation` is reported from the tracked flag rather than hardcoded. A link
      // whose element vanishes BECAUSE the page navigated is a navigation, and
      // claiming `none_observed` for it is exactly what made a successful
      // example.com -> iana.org click look like a no-change click.
      const nav = navigation ? 'completed' : 'none_observed';
      if (token && !options.wait_until && effect && effect.present === false) {
        return {clicked:true,verified:true,verification:'target_disappeared',effect_observed:true,navigation:nav,url:last?.url,title:last?.title,page_id:newTabId??activeId};
      }
      if (token && !options.wait_until && effect && effect.present === true && effect.visible === false) {
        return {clicked:true,verified:true,verification:'target_hidden',effect_observed:true,navigation:nav,url:last?.url,title:last?.title,page_id:newTabId??activeId};
      }
      if (token && !options.wait_until && effect && effect.container_visible === false) {
        return {clicked:true,verified:true,verification:'overlay_disappeared',effect_observed:true,navigation:nav,url:last?.url,title:last?.title,page_id:newTabId??activeId};
      }
      if(!navigation && !options.wait_until && options.wait_for!=='navigation' && Date.now()>=discoveryDeadline) {
        return {clicked:true,verified:false,navigation:'none_observed',url:last?.url,
          ...(token ? {unverified_reason: effect && effect.present ? 'the clicked element and its overlay are still present, and nothing else on the page changed' : 'no observable change was detected within the discovery window'} : {})};
      }
    }
    // Keep watching the clicked element while the decision is still open.
    if (token && !pending && Date.now() < discoveryDeadline) pending = readEffect(engine, token).catch(() => null) as Promise<ElementEffect>;
    await engine.waitMs(100);
  } while(Date.now()<deadline);
  // Deadline reached. If the URL or the document already changed we KNOW the
  // navigation happened — reporting it as "pending" contradicts the evidence
  // already have. What is unverified is the RENDERED destination, which is what
  // verified:false says.
  if (token && effect && effect.present === false) {
    return {clicked:true,verified:true,verification:'target_disappeared',effect_observed:true,navigation:navigation?'completed':'none_observed',url:last?.url,page_id:newTabId??activeId};
  }
  return {clicked:true,verified:false,navigation:navigation?'completed':'none_observed',wait_timed_out:true,url:last?.url,page_id:newTabId??activeId,retry_safe:false};
}
