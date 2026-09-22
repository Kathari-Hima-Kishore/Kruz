import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {PuppeteerEngine} from '../../src/browser/engines/puppeteer-engine.js';
import {BrowserController} from '../../src/browser/controller.js';
import {Observer} from '../../src/extractor/observer.js';
import {loadConfig} from '../../src/config.js';
import {parseMaxYears,POSTING_EXTRACT_SCRIPT} from '../../src/browser/ats-tools.js';
import {captureClickState,completeClick} from '../../src/browser/click-completion.js';

describe('runtime comparison regressions',()=>{
 let engine:PuppeteerEngine,ctrl:BrowserController,profile:string;
 beforeAll(async()=>{profile=await mkdtemp(join(tmpdir(),'kruz-comparison-'));engine=new PuppeteerEngine(true);await engine.boot({...loadConfig(),headless:false},profile);ctrl=new BrowserController({getActiveEngine:()=>engine,getActive:()=>({engine,status:'active',observer:{bumpMutation(){},getRefMap:()=>new Map()}})} as any)});
 afterAll(async()=>{await engine?.shutdown();if(profile&&resolve(profile).startsWith(resolve(tmpdir())+sep)&&profile.includes('kruz-comparison-'))await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})});
 it('resolves actual wrapping labels to input and select controls',async()=>{
  await engine.page.setContent('<label>Keyword<input oninput="window.changed=this.value"></label><label>Location<select><option>All</option><option value="blr">Bangalore</option></select></label>');
  expect((await ctrl.fill({label:'Keyword'},'engineer')).ok).toBe(true);
  expect((await ctrl.select({label:'Location'},{label:'Bangalore'})).ok).toBe(true);
  expect((await engine.evaluate('({input:window.changed,location:document.querySelector("select").value})')).result).toEqual({input:'engineer',location:'blr'});
 });
 it('dismisses a cookie alert and a shadow announcement without clicking page controls',async()=>{
  await engine.page.setContent(`<button onclick="window.wrong=true">No, thanks</button><div id="system-ialert"><p>Cookies</p><button onclick="window.accepted=true;this.parentElement.remove()">Accept</button><button onclick="this.parentElement.remove()">Decline</button></div><div id="shadow"></div>`);
  await engine.page.evaluate(()=>{document.querySelector('#shadow')!.attachShadow({mode:'open'}).innerHTML='<div role="dialog"><button onclick="this.parentElement.remove()">No, thanks</button></div>'});
  const r=await ctrl.handleOverlays();expect(r.ok).toBe(true);expect((r.result as any).dismissed).toHaveLength(2);
  expect((await engine.evaluate('!!window.wrong||!!window.accepted||!!document.querySelector("#system-ialert")')).result).toBe(false);
 });
 it('selects scoped radio menu options and does not toggle an already selected item',async()=>{
  await engine.page.setContent(`<button id="trigger" aria-controls="menu" aria-expanded="true">main</button><div id="menu" role="menu"><button role="menuitemradio" aria-checked="false" onclick="window.selectionClicks=(window.selectionClicks||0)+1;this.setAttribute('aria-checked','true');document.querySelector('#trigger').textContent='release'">release</button></div><div role="option" onclick="window.wrong=true">release</div>`);
  expect((await ctrl.select({css:'#trigger'},{label:'release'})).ok).toBe(true);
  expect((await ctrl.select({css:'#trigger'},{label:'release'})).ok).toBe(true);
  expect((await engine.evaluate('window.selectionClicks')).result).toBe(1);
  expect((await engine.evaluate('!!window.wrong')).result).toBe(false);
 });
 it('waits for delayed content after a click without changing to an existing tab',async()=>{
  const original=(await engine.listTabs()).find(t=>t.isActive)!.id;
  const other=await engine.newTab();await engine.switchTab(original);
  await engine.page.setContent(`<button onclick="setTimeout(()=>document.body.innerHTML='<h1>Ready destination</h1>',500)">Go</button>`);
  const before=await captureClickState(engine);expect((await ctrl.click({text:'Go'})).ok).toBe(true);
  const result=await completeClick(engine,before,{wait_until:"document.querySelector('h1')?.textContent==='Ready destination'",wait_timeout_ms:3000});
  expect(result.verified).toBe(true);expect((await engine.listTabs()).find(t=>t.isActive)!.id).toBe(original);
  await engine.closeTab(other.id);
 });
 it('reports a timed-out postcondition without replaying the click',async()=>{
  await engine.page.setContent('<button onclick="window.once=(window.once||0)+1">Once</button>');
  const before=await captureClickState(engine);await ctrl.click({text:'Once'});
  expect(await completeClick(engine,before,{wait_until:'false',wait_timeout_ms:500})).toMatchObject({clicked:true,verified:false,wait_timed_out:true,retry_safe:false});
  expect((await engine.evaluate('window.once')).result).toBe(1);
 });
 it('uses instant scrolling inside smooth shadow panels',async()=>{
  await engine.page.setContent('<div id="panelhost"></div>');
  await engine.page.evaluate(()=>{document.querySelector('#panelhost')!.attachShadow({mode:'open'}).innerHTML='<div id="panel" style="height:100px;overflow:auto;scroll-behavior:smooth"><div style="height:1000px"><span id="child">Scrollable</span></div></div>'});
const child=await engine.queryOne({css:'#child'});expect(child).toBeTruthy();await engine.scrollElement(child!,'down',250);
  // Chrome snaps scrollTop to physical device pixels, so on a fractional-DPR display
  // (e.g. 1.25) a 250px instant scroll settles at 250.4. Assert the value reached the
  // requested offset, not an exact integer that only holds at DPR 1.
  const scrollTop=(await engine.evaluate('document.querySelector("#panelhost").shadowRoot.querySelector("#panel").scrollTop')).result as number;
  expect(scrollTop).toBeGreaterThanOrEqual(250);expect(scrollTop).toBeLessThan(251);
 });
 it('rejects hidden and disabled targets without dispatching clicks',async()=>{
  await engine.page.setContent('<button id="h" style="display:none" onclick="window.bad=true">Hidden</button><button id="d" disabled>Disabled</button>');
  expect((await ctrl.click({css:'#h'})).error?.code).toBe('ELEMENT_NOT_VISIBLE');
  expect((await ctrl.click({css:'#d'})).error?.code).toBe('ELEMENT_DISABLED');
  expect((await engine.evaluate('window.bad===true')).result).toBe(false);
 });
 it('rejects an obscured button rather than clicking the covering control',async()=>{
  await engine.page.setContent('<button id="save" onclick="window.saved=true">Save</button><div style="position:fixed;inset:0;background:white;z-index:99" onclick="window.wrong=true">Overlay</div>');
  expect((await ctrl.click({css:'#save'})).ok).toBe(false);
  expect((await engine.evaluate('!!(window.saved||window.wrong)')).result).toBe(false);
 });
 it('returns a pending dialog from the click and leaves response explicit',async()=>{
  await engine.page.setContent('<button onclick="window.answer=confirm(\'Confirm?\')">Confirm</button>');
  const started=Date.now();const result=await ctrl.click({role:'button',name:'Confirm'});
  expect(result.result).toMatchObject({dialog_pending:true});expect(Date.now()-started).toBeLessThan(5000);
  await ctrl.dialog('dismiss');expect((await engine.evaluate('window.answer')).result).toBe(false);
 });
 it('resolves and clicks a unique srcdoc frame control',async()=>{
  await engine.page.setContent('<iframe srcdoc="<button onclick=\"this.textContent=\'Clicked\'\">Frame</button>"></iframe>');
  // Set srcdoc through the DOM to avoid HTML attribute quoting ambiguity in the fixture.
  await engine.page.evaluate(()=>{document.querySelector('iframe')!.srcdoc='<button onclick="this.textContent=\'Clicked\'">Frame</button>'});
  await engine.waitFor('document.querySelector("iframe").contentDocument?.body.innerText.includes("Frame")',3000,100);
  expect((await ctrl.click({role:'button',name:'Frame'})).ok).toBe(true);
  expect((await engine.evaluate('document.querySelector("iframe").contentDocument.body.innerText')).result).toBe('Clicked');
 });
 it('clicks a slotted control through a shadow host without declaring it obscured',async()=>{
  await engine.page.setContent('<div id="host"><button onclick="window.slotted=true">Slotted action</button></div>');
  await engine.page.evaluate(()=>{document.querySelector('#host')!.attachShadow({mode:'open'}).innerHTML='<div style="padding:20px"><slot></slot></div>'});
  expect((await ctrl.click({role:'button',name:'Slotted action'})).ok).toBe(true);
  expect((await engine.evaluate('window.slotted')).result).toBe(true);
 });
 it('clicks a shadow button whose label is slotted light-DOM text',async()=>{
  await engine.page.setContent('<div id="host">Slotted label</div>');
  await engine.page.evaluate(()=>{document.querySelector('#host')!.attachShadow({mode:'open'}).innerHTML='<button onclick="window.slottedLabel=true"><slot></slot></button>'});
  expect((await ctrl.click({role:'button',name:'Slotted label'})).ok).toBe(true);
  expect((await engine.evaluate('window.slottedLabel')).result).toBe(true);
 });
 it('tracks dialogs in a site-created popup after switching tabs',async()=>{
  const original=(await engine.listTabs()).find(t=>t.isActive)!.id;
  await engine.page.evaluate(()=>window.open('about:blank'));
  const popup=(await engine.listTabs()).find(t=>t.id!==original)!;
  await engine.switchTab(popup.id);
  await engine.page.setContent('<button onclick="window.answer=confirm(\'Popup confirm?\')">Popup confirm</button>');
  const response=await ctrl.click({role:'button',name:'Popup confirm'});
  expect(response.result).toMatchObject({dialog_pending:true});
  await ctrl.dialog('dismiss');
  expect((await engine.evaluate('window.answer')).result).toBe(false);
  await engine.closeTab(popup.id);await engine.switchTab(original);
 });
 it('emits rendered text instead of stylesheet source',async()=>{
  await engine.page.setContent('<style>.leak-marker{color:red}</style><h1>Job results</h1><button>Search</button><p>Visible job description</p>');
  const {observation}=await new Observer().observe(engine,undefined,'full',true);
  const text=observation.text.map(x=>x.text).join('\n');expect(text).toContain('Visible job description');expect(text).not.toContain('leak-marker');
 });
 it('extracts Oracle metadata and excludes corporate boilerplate',async()=>{
  await engine.page.setContent('<h1>Software Developer 3</h1><div class="job-details__subtitle">India</div><ul><li class="job-meta__item"><span class="job-meta__title">Years</span><span class="job-meta__subitem">3 to 5+ years</span></li><li class="job-meta__item"><span class="job-meta__title">Posting Date</span><span class="job-meta__subitem">09/11/2026, 11:41 PM</span></li></ul><section class="job-details__section"><h2>Responsibilities</h2><p>'+('Design and build software systems. '.repeat(8))+'</p></section><section class="job-details__section"><h2>About Us</h2><p>BOILERPLATE_SUPPORT</p></section><button>Apply Now</button>');
  const r=(await engine.evaluate(POSTING_EXTRACT_SCRIPT)).result as any;
  expect(r.description_ready).toBe(true);expect(r.posted).toBe('09/11/2026, 11:41 PM');expect(r.location).toBe('India');expect(r.text).not.toContain('BOILERPLATE_SUPPORT');expect(parseMaxYears(r.text)).toBe(5);
 });
 it('parses word-separated experience ranges and leaves unspecified null',()=>{expect(parseMaxYears('Years\n3 to 5+ years')).toBe(5);expect(parseMaxYears('0 through 2 years of experience')).toBe(2);expect(parseMaxYears('Software engineering role')).toBe(null)});

 it('preserves punctuation and full accessible names',async()=>{
  const name='Save (draft) [private] '+ 'long name '.repeat(10);
  await engine.page.setContent('<button></button>');
  await engine.page.$eval('button',(el,n)=>{el.textContent=n;el.setAttribute('onclick','window.exactClicked=true')},name.trim());
  expect((await ctrl.click({role:'button',name:name.trim()})).ok).toBe(true);
  expect((await engine.evaluate('window.exactClicked')).result).toBe(true);
 });
 it('supports native implicit roles and text targets',async()=>{
  await engine.page.setContent('<button onclick="window.nativeClicked=true">Native control</button>');
  expect((await ctrl.click({role:'button'})).ok).toBe(true);
  expect((await ctrl.click({text:'Native control'})).ok).toBe(true);
 });
 it('rejects duplicate semantic targets without choosing the first',async()=>{
  await engine.page.setContent('<button onclick="window.duplicateClicked=true">Duplicate</button><button onclick="window.duplicateClicked=true">Duplicate</button>');
  expect((await ctrl.click({role:'button',name:'Duplicate'})).ok).toBe(false);
  expect((await engine.evaluate('!!window.duplicateClicked')).result).toBe(false);
 });

});

