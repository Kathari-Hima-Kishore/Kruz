import { describe, it, expect } from "vitest";
import { detectATS } from "../../src/browser/ats-detector.js";
import { BrowserController } from "../../src/browser/controller.js";

describe("Kruz v1.7 Consolidated Fixes Verification", () => {
  describe("Priority 1 — BUG-G1: ats.detect False Positives vs True Positives", () => {
    it("should NOT false-positive on Wikipedia mentioning 'Phenom' in prose", () => {
      const res = detectATS("https://en.wikipedia.org/wiki/AMD_Phenom", "<p>The AMD Phenom is a microprocessor family designed by AMD.</p>");
      expect(res.type).toBe("unknown");
      expect(res.confidence).toBe("low");
    });

    it("should NOT false-positive on Naukri containing 'workday' in prose", () => {
      const res = detectATS("https://www.naukri.com/jobs", "<p>Software engineers discuss their daily workday routine and challenges.</p>");
      expect(res.type).toBe("unknown");
      expect(res.confidence).toBe("low");
    });

    it("should NOT false-positive on Reddit mentioning 'workday' in comments", () => {
      const res = detectATS("https://www.reddit.com/r/cscareerquestions/comments/123", "<div>How was your workday today? Share your thoughts.</div>");
      expect(res.type).toBe("unknown");
      expect(res.confidence).toBe("low");
    });

    it("should accurately detect real Workday career portal URLs", () => {
      const res = detectATS("https://mycompany.wd5.myworkdayjobs.com/en-US/Careers");
      expect(res.type).toBe("workday");
      expect(res.confidence).toBe("high");
    });

    it("should accurately detect real Oracle HCM Cloud portals", () => {
      const res = detectATS("https://fa-saasfaprod1.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/requisitions");
      expect(res.type).toBe("oracle-hcm");
      expect(res.confidence).toBe("high");
    });

    it("should accurately detect real Greenhouse job boards", () => {
      const res = detectATS("https://boards.greenhouse.io/airbnb/jobs/12345");
      expect(res.type).toBe("greenhouse");
      expect(res.confidence).toBe("high");
    });

    it("should accurately detect real Lever career portals", () => {
      const res = detectATS("https://jobs.lever.co/netflix");
      expect(res.type).toBe("lever");
      expect(res.confidence).toBe("high");
    });

    it("should accurately detect real Ashby job boards", () => {
      const res = detectATS("https://jobs.ashbyhq.com/figma");
      expect(res.type).toBe("ashby");
      expect(res.confidence).toBe("high");
    });

    it("should accurately detect real iCIMS portals", () => {
      const res = detectATS("https://careers-globalcu.icims.com/jobs/intro");
      expect(res.type).toBe("icims");
      expect(res.confidence).toBe("high");
    });
  });

  describe("Priority 3 — page.extractExperience Signals Verification", () => {
    const ctrl = new BrowserController(null as any);

    it("should extract 8-10 years senior level accurately", () => {
      const res = ctrl.extractExperience("Senior Software Engineer", "Requires 8-10 years of experience in distributed systems and cloud architecture.");
      expect(res.level).toBe("senior");
      expect(res.years).toBe(10);
      expect(res.confidence).toBe("high");
      expect(res.signals).toContain("8-10 years");
    });

    it("should extract 6+ years staff level accurately", () => {
      const res = ctrl.extractExperience("Staff Engineer", "Must have 6+ years of relevant experience in backend development with Go or Java.");
      expect(res.level).toBe("senior");
      expect(res.years).toBe(6);
      expect(res.confidence).toBe("high");
    });

    it("should extract recent graduate / 0-1 years entry level accurately", () => {
      const res = ctrl.extractExperience("Software Engineer - University Graduate", "Open to recent graduate candidates or applicants with 0-1 years experience.");
      expect(res.level).toBe("junior");
      expect(res.years).toBe(1);
      expect(res.confidence).toBe("high");
      expect(res.signals).toContain("recent graduate");
    });

    it("should honestly return unknown/none for postings without experience criteria", () => {
      const res = ctrl.extractExperience("Frontend Developer", "Join our fast-growing company! We offer competitive compensation and great culture.");
      expect(res.level).toBe("unknown");
      expect(res.years).toBe(-1);
      expect(res.confidence).toBe("none");
    });
  });

  describe("Priority 2 & 3 — Controller Feature Existence Verification", () => {
    const ctrl = new BrowserController(null as any);

    it("should expose click and fill with force and ignore_visibility options", () => {
      expect(typeof ctrl.click).toBe("function");
      expect(typeof ctrl.fill).toBe("function");
    });

    it("should expose handleOverlays and dialog policies", () => {
      expect(typeof ctrl.handleOverlays).toBe("function");
      expect(typeof ctrl.setDialogPolicy).toBe("function");
    });

    it("should expose full hierarchy and site structure navigation", () => {
      expect(typeof ctrl.siteStructure).toBe("function");
      expect(typeof ctrl.exploreHierarchy).toBe("function");
      expect(typeof ctrl.scrollAll).toBe("function");
      expect(typeof ctrl.paginate).toBe("function");
    });

    it("should expose ATS helper functions", () => {
      expect(typeof ctrl.oracleHCMSearch).toBe("function");
      expect(typeof ctrl.iCIMSSearch).toBe("function");
      expect(typeof ctrl.atsPaginate).toBe("function");
      expect(typeof ctrl.atsVerifyPosting).toBe("function");
      expect(typeof ctrl.atsSummarize).toBe("function");
    });

    it("should expose frame-scoped tools for iframe navigation (e.g. iCIMS)", () => {
      expect(typeof ctrl.frameEvaluate).toBe("function");
      expect(typeof ctrl.frameExtractLinks).toBe("function");
      expect(typeof ctrl.frameObserve).toBe("function");
    });
  });
});
