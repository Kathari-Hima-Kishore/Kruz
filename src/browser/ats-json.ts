// ── Types ──────────────────────────────────────────────────────────

export interface JsonHarvestJob {
  id: string;
  title: string;
  location: string;
  department?: string;
  url: string;
  updated_at?: string;
  posted_at?: string;
  body?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  content?: string;
}

export interface JsonHarvestResult {
  company: string;
  ats: string;
  status: "ok" | "empty" | "error";
  jobs: JsonHarvestJob[];
  error?: string;
}

export interface TargetCompany {
  name: string;
  ats: string;
  handle: string;
  careers_url: string;
  size?: string;
  notes?: string;
}

// ── Greenhouse ─────────────────────────────────────────────────────

export async function greenhouseHarvest(company: string, query?: string): Promise<JsonHarvestJob[]> {
  const base = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs`;
  const params = query ? `?content=true&${query}` : "?content=true";
  try {
    const res = await fetch(base + params);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs ?? []).map((j: any) => ({
      id: j.id,
      title: j.title,
      location: j.location?.name ?? "",
      department: j.departments?.[0]?.name,
      url: j.absolute_url ?? "",
      updated_at: j.updated_at,
      content: j.content,
    }));
  } catch { return []; }
}

// ── Lever ──────────────────────────────────────────────────────────

export async function leverHarvest(company: string): Promise<JsonHarvestJob[]> {
  const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data ?? []).map((j: any) => ({
      id: j.id,
      title: j.text,
      location: j.categories?.location ?? "",
      department: j.categories?.department,
      url: j.hostedUrl ?? "",
      updated_at: j.createdAt,
      body: j.descriptionPlain,
      posted_at: j.createdAt,
    }));
  } catch { return []; }
}

// ── Ashby ──────────────────────────────────────────────────────────

export async function ashbyHarvest(company: string): Promise<JsonHarvestJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs ?? []).map((j: any) => ({
      id: j.id,
      title: j.title,
      location: j.location ?? "",
      department: j.department,
      url: j.jobUrl ?? "",
      updated_at: j.publishedAt,
      body: j.descriptionHtml,
    }));
  } catch { return []; }
}

// ── SmartRecruiters ────────────────────────────────────────────────

export async function smartRecruitersHarvest(company: string): Promise<JsonHarvestJob[]> {
  let all: JsonHarvestJob[] = [];
  let offset = 0;
  const limit = 100;
  try {
    while (true) {
      const url = `https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=${limit}&offset=${offset}`;
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      if (!data.content?.length) break;
      all = all.concat(data.content.map((j: any) => ({
        id: j.id,
        title: j.name,
        location: j.location?.city ?? "",
        url: `https://jobs.smartrecruiters.com/${company}/${j.id}`,
        updated_at: j.releasedDate,
        body: j.jobAd?.sections,
      })));
      offset += limit;
    }
  } catch { /* ignore */ }
  return all;
}

// ── Workday ────────────────────────────────────────────────────────

export async function workdayHarvest(tenant: string, site: string, query = ""): Promise<JsonHarvestJob[]> {
  const url = `https://${tenant}.wd1.myworkdayjobs.com/en-US/${site}/jobs`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ searchText: query, appliedFacets: {}, limit: 50, offset: 0 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobPostings ?? []).map((j: any) => ({
      id: j.bulletFields?.[0] ?? j.id,
      title: j.title,
      location: j.locationsText ?? "",
      url: `https://${tenant}.wd1.myworkdayjobs.com/en-US/${site}${j.externalPath}`,
      posted_at: j.startDate,
    }));
  } catch { return []; }
}

// ── Bulk sweep ─────────────────────────────────────────────────────

export async function bulkHarvest(
  companies: TargetCompany[],
): Promise<JsonHarvestResult[]> {
  const results: JsonHarvestResult[] = [];
  // Run in batches of 5 to avoid rate limits
  for (let i = 0; i < companies.length; i += 5) {
    const batch = companies.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(async (c) => {
        try {
          let jobs: JsonHarvestJob[] = [];
          switch (c.ats) {
            case "greenhouse": jobs = await greenhouseHarvest(c.handle); break;
            case "lever": jobs = await leverHarvest(c.handle); break;
            case "ashby": jobs = await ashbyHarvest(c.handle); break;
            case "smartrecruiters": jobs = await smartRecruitersHarvest(c.handle); break;
            case "workday":
              const parts = c.handle.split("/");
              const tenant = parts[0] ?? c.handle;
              const site = parts[1] ?? "External";
              jobs = await workdayHarvest(tenant, site);
              break;
            default: jobs = [];
          }
        return { company: c.name, ats: c.ats, status: (jobs.length > 0 ? "ok" : "empty") as "ok" | "empty", jobs };
      } catch (e: any) {
        return { company: c.name, ats: c.ats, status: "error", jobs: [], error: String(e?.message ?? e) };
      }
    }),
  );
  for (const r of settled) {
    results.push(r.status === "fulfilled" ? (r.value as JsonHarvestResult) : { company: "unknown", ats: "unknown", status: "error", jobs: [], error: String(r.reason) });
  }
  }
  return results;
}

// ── Filter helpers ─────────────────────────────────────────────────

const ROLE_KEYWORDS = ["software engineer", "developer", "full stack", "frontend", "backend", "mobile", "devops", "sre", "platform", "engineer", "sde", "mts", "member of technical staff", "associate engineer", "graduate engineer", "trainee engineer", "junior engineer", "engineer i", "sde-1", "software engineer l1", "solutions engineer"];
const EXPERIENCE_RE = /(\d{1,2})\s*(?:to|[-–—])\s*(\d{1,2})?\s*\+?\s*years?|(\d{1,2})\+?\s*years?|0[- ]?3|(?:1|2|3)\s*(?:to|[-–—])\s*3|junior|entry|associate|early|graduate|fresher|campus|0-2|0\s*-\s*2|0\s*/;
const FRESHER_BAND = /0[- ]?3|(?:1|2|3)\s*(?:to|[-–—])\s*3|junior|entry|associate|early|graduate|fresher|campus|0-2|0\s*-\s*2|0\s*/;

export function filterSoftwareJobs(jobs: JsonHarvestJob[], maxYears: number = 3): JsonHarvestJob[] {
  return jobs.filter((j) => {
    const title = (j.title ?? "").toLowerCase();
    const body = ((j.body ?? j.descriptionPlain ?? j.descriptionHtml ?? j.content ?? "") as string).toLowerCase();
    const text = title + " " + body;
    const isSoftware = ROLE_KEYWORDS.some((kw) => text.includes(kw));
    if (!isSoftware) return false;
    const isSenior = /senior|staff|principal|lead|architect|head of|tech lead/i.test(title) && !FRESHER_BAND.test(title + " " + body);
    if (isSenior) return false;
    const hasYears = EXPERIENCE_RE.test(text);
    return true; // caller does the year filter on body content
  });
}
