import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ recognize: vi.fn(), init: vi.fn() }));
vi.mock("@azure/cognitiveservices-computervision", () => ({ ComputerVisionClient: class { recognizePrintedTextInStream = mocks.recognize; constructor(...args: any[]) { mocks.init(...args); } } }));
import { initAzureCV, findTextWithOCR, parseOCRBox, cvEnhancedClick, createKruzCVBridge } from "../../src/browser/azure-cv.js";
const line = { boundingBox: "1196,732,96,10", words: [{ text: "SEARCH" }, { text: "JOBS" }] };
beforeEach(() => { vi.clearAllMocks(); process.env.AZURE_CV_ENDPOINT = "https://example.com"; process.env.AZURE_CV_KEY = "test"; initAzureCV(); mocks.recognize.mockResolvedValue({ regions: [{ lines: [line] }] }); });
describe("Azure OCR repair", () => {
 it("uses the SDK boolean, bytes, options signature and xywh coordinates", async () => {
  const image = Buffer.from('image');
  expect(await findTextWithOCR(image, 'search jobs')).toEqual({ x:1244,y:737,width:96,height:10,text:'SEARCH JOBS',confidence:null });
  expect(mocks.recognize).toHaveBeenCalledWith(false,image,expect.objectContaining({language:'en'}));
 });
 it("reads credentials lazily and clears a previously initialized client on failure", () => {
  delete process.env.AZURE_CV_KEY; expect(initAzureCV()).toBe(false);
  process.env.AZURE_CV_KEY='new'; expect(initAzureCV()).toBe(true);
 });
 it("rejects invalid boxes", () => { for(const box of ['1,2,3','1,2,-3,4','1,,3,4','a,2,3,4',[1,2,3,4]]) expect(()=>parseOCRBox(box)).toThrow(); });
 it("does not invent matches when regions are absent", async () => { mocks.recognize.mockResolvedValue({}); expect(await findTextWithOCR(Buffer.alloc(0),'Search')).toBeNull(); });
 it("rejects duplicate or rotated matches and does not match partial labels", async () => {
  mocks.recognize.mockResolvedValueOnce({regions:[{lines:[line,line]}]}); await expect(findTextWithOCR(Buffer.alloc(0),'SEARCH JOBS')).rejects.toThrow('Ambiguous');
  mocks.recognize.mockResolvedValueOnce({textAngle:0.1}); await expect(findTextWithOCR(Buffer.alloc(0),'SEARCH JOBS')).rejects.toThrow('Rotated');
  expect(await findTextWithOCR(Buffer.alloc(0),'SEARCH')).toBeNull();
 });
 it("never retries an uncertain click and never clicks Apply", async () => {
  const bridge = { capture: vi.fn(async()=>({image:Buffer.alloc(0)})), click: vi.fn(async()=>{throw new Error('lost acknowledgement')}) };
  await expect(cvEnhancedClick(bridge as any,'SEARCH JOBS')).rejects.toThrow('lost acknowledgement'); expect(bridge.click).toHaveBeenCalledTimes(1);
  await expect(cvEnhancedClick(bridge as any,'Apply Now')).rejects.toThrow('disabled'); expect(bridge.click).toHaveBeenCalledTimes(1);
 });
 it("reports click dispatch separately from verification", async () => {
  const bridge = { capture: async()=>({image:Buffer.alloc(0)}), click: vi.fn(async()=>({x:10,y:20})) };
  expect(await cvEnhancedClick(bridge as any,'SEARCH JOBS')).toMatchObject({ok:true,clicked:true,verified:false});
  expect(await cvEnhancedClick(bridge as any,'SEARCH JOBS',{verify:async()=>true})).toMatchObject({verified:true});
 });
 it("scales device pixels to CSS pixels and rejects stale viewport state", async () => {
  const image=Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(image); image.writeUInt32BE(2000,16); image.writeUInt32BE(1400,20);
  let state={width:1000,height:700,url:'https://example.com',scrollX:0,scrollY:0};
  const engine={listTabs:async()=>[{id:"tab-1",isActive:true}],evaluate:vi.fn(async(s:string)=>({ok:true,result:s.startsWith('({width')?state:true})),screenshot:vi.fn(async()=>image),mouseClick:vi.fn()};
  const bridge=createKruzCVBridge(engine as any); const capture=await bridge.capture(); await bridge.click({x:1000,y:700},capture);
  expect(engine.screenshot).toHaveBeenCalledWith({fullPage:false}); expect(engine.mouseClick).toHaveBeenCalledWith(500,350,{button:'left'});
  state={...state,scrollY:100}; await expect(bridge.click({x:1000,y:700},capture)).rejects.toThrow('moved'); expect(engine.mouseClick).toHaveBeenCalledTimes(1);
 });
});
