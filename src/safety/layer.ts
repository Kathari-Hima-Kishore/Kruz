import type { P1Config } from "../config.js";

export type ActionSeverity = "safe" | "confirm" | "human";

export interface SafetyDecision {
  severity: ActionSeverity;
  action: string;
  reason: string;
  reversible: boolean;
}

/**
 * Safety layer. Classifies actions and determines whether human intervention is required.
 */
export class SafetyLayer {
  private policy: P1Config["safetyPolicy"];

  constructor(policy: P1Config["safetyPolicy"] = "strict") {
    this.policy = policy;
  }

  /**
   * Classify an action and determine required safety level.
   */
  classify(
    action: string,
    target?: { name?: string; text?: string; role?: string },
    url?: string
  ): SafetyDecision {
    if (this.policy === "off") {
      return {
        severity: "safe",
        action,
        reason: "Safety policy is off",
        reversible: true,
      };
    }

    const targetText = this.getTargetText(target);
    const isHighImpact = this.isHighImpactAction(action, targetText, url);
    const isIrreversible = this.isIrreversible(action, targetText);

    if (isHighImpact && this.policy === "strict") {
      return {
        severity: "human",
        action,
        reason: this.getReason(action, targetText),
        reversible: !isIrreversible,
      };
    }

    if (isHighImpact && this.policy === "lenient") {
      return {
        severity: "confirm",
        action,
        reason: this.getReason(action, targetText),
        reversible: !isIrreversible,
      };
    }

    return {
      severity: "safe",
      action,
      reason: "Action is safe",
      reversible: true,
    };
  }

  /**
   * Check if an action should trigger human takeover.
   */
  requiresHumanTakeover(action: string, target?: any, url?: string): boolean {
    return this.classify(action, target, url).severity === "human";
  }

  /**
   * Check if an action requires confirmation.
   */
  requiresConfirmation(action: string, target?: any, url?: string): boolean {
    const severity = this.classify(action, target, url).severity;
    return severity === "confirm" || severity === "human";
  }

  /**
   * Check if a page likely needs human intervention (CAPTCHA, login, etc.).
   */
  /**
   * Check if a page likely needs human intervention (CAPTCHA, login, 2FA).
   *
   * Accepts a Puppeteer `Page`. The previous implementation called
   * `page.locator(...).count()`, which is PLAYWRIGHT API — the only page objects
   * in this codebase are Puppeteer pages, which have no `.locator`. The
   * resulting TypeError was swallowed by a bare `catch`, so this function
   * returned `{needed:false}` unconditionally for every CAPTCHA, password and
   * 2FA page: it could only ever answer "no".
   *
   * Now a single `page.evaluate` counts all three signal sets at once, which is
   * both correct and one CDP round-trip instead of three.
   */
  async detectHumanNeeded(page: any): Promise<{ needed: boolean; reason?: string }> {
    try {
      const hit = await page.evaluate(() => {
        const CAPTCHA = [
          '[class*="captcha"]', '[id*="captcha"]', '[class*="recaptcha"]', '[id*="recaptcha"]',
          'iframe[src*="recaptcha"]', 'iframe[src*="captcha"]', '[class*="hcaptcha"]',
          'iframe[src*="hcaptcha"]',
        ].join(',');
        const PASSWORD = 'input[type="password"], input[name*="password"], input[id*="password"]';
        const TWO_FACTOR = [
          '[class*="2fa"]', '[class*="two-factor"]', '[class*="otp"]',
          'input[name*="otp"]', 'input[name*="code"]', 'input[id*="otp"]',
        ].join(',');
        // CAPTCHA first: an hCaptcha reCAPTCHA iframe on a login page is the more
        // specific reason, and reporting "password field" would send the model
        // to type credentials into a wall it cannot pass.
        if (document.querySelector(CAPTCHA)) return "captcha";
        if (document.querySelector(PASSWORD)) return "password";
        if (document.querySelector(TWO_FACTOR)) return "2fa";
        return null;
      });

      if (hit === "captcha") return { needed: true, reason: "CAPTCHA detected on page" };
      if (hit === "password") return { needed: true, reason: "Login/password form detected" };
      if (hit === "2fa") return { needed: true, reason: "Two-factor authentication detected" };
    } catch {
      // Detection is advisory: a page that cannot be evaluated is not evidence of
      // a human being needed.
    }

    return { needed: false };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getTargetText(target?: { name?: string; text?: string; role?: string }): string {
    if (!target) return "";
    return (target.name || target.text || "").toLowerCase();
  }

  /**
   * Does `text` contain `keyword` as a WHOLE WORD?
   *
   * A bare `includes` matched inside unrelated words: "Display options" contains
   * "pay", "Posted: 2 days ago" contains "post", "Cancellation policy" contains
   * "cancel". Under `strict` each of those was classified `severity:"human"` and
   * flagged `requiresHumanTakeover`, so ordinary navigation controls demanded
   * human review while genuinely irreversible ones were indistinguishable from
   * them. Multi-word keywords are matched as a contiguous phrase.
   */
  private hasKeyword(text: string, keyword: string): boolean {
    if (!text || !keyword) return false;
    const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundaries are expressed manually so the guard is identical whether or
    // not the runtime supports `\b` inside the class (and so `_` counts as a word
    // character, which is what we want for "opt_out"/"sign_out").
    const start = "(?<![a-z0-9])";
    const end = "(?![a-z0-9])";
    return new RegExp(`${start}${esc.replace(/\s+/g, "\\s+")}${end}`, "i").test(text);
  }

  private isHighImpactAction(action: string, targetText: string, url?: string): boolean {
    const highImpactKeywords = [
      "delete", "remove", "unsubscribe", "cancel",
      "purchase", "buy", "checkout", "pay",
      "send", "publish", "post",
      "accept", "agree",
      "logout", "sign out",
    ];

    const destructiveKeywords = [
      "delete", "remove", "destroy", "erase",
      "unsubscribe", "opt out", "cancel account",
    ];

    // Check action type
    if (action === "click") {
      for (const keyword of highImpactKeywords) {
        if (this.hasKeyword(targetText, keyword)) return true;
      }
    }

    // Check for destructive patterns
    for (const keyword of destructiveKeywords) {
      if (this.hasKeyword(targetText, keyword)) return true;
    }

    // Check URL patterns for payment/checkout. URL segments are slash- or
    // dot-delimited, so an anchored segment match is used rather than a bare
    // substring: /pay and /checkout are payment pages, /player and /paying-in-4
    // are not.
    if (url) {
      const paymentPatterns = [
        /(^|[/?#._-])checkout([/?#._-]|$)/i,
        /(^|[/?#._-])payment([/?#._-]|$)/i,
        /(^|[/?#._-])pay([/?#._-]|$)/i,
        /(^|[/?#._-])purchase([/?#._-]|$)/i,
        /(^|[/?#._-])billing([/?#._-]|$)/i,
        /(^|[/?#._-])cart[/?#._-].*review/i,
      ];
      for (const pattern of paymentPatterns) {
        if (pattern.test(url)) return true;
      }
    }

    return false;
  }

  private isIrreversible(_action: string, targetText: string): boolean {
    const irreversibleKeywords = [
      "delete", "remove", "destroy", "erase",
      "unsubscribe", "opt out", "cancel account",
      "permanently", "irreversible",
    ];

    for (const keyword of irreversibleKeywords) {
      if (this.hasKeyword(targetText, keyword)) return true;
    }

    return false;
  }

  private getReason(action: string, targetText: string): string {
    if (this.hasKeyword(targetText, "delete") || this.hasKeyword(targetText, "remove")) {
      return `This action appears to be destructive (${action}: "${targetText}"). Human review recommended.`;
    }
    if (this.hasKeyword(targetText, "submit") || this.hasKeyword(targetText, "send")) {
      return `This action submits/sends data (${action}: "${targetText}"). Human review recommended.`;
    }
    if (this.hasKeyword(targetText, "pay") || this.hasKeyword(targetText, "purchase")) {
      return `This action involves payment (${action}: "${targetText}"). Human review required.`;
    }
    if (this.hasKeyword(targetText, "accept") || this.hasKeyword(targetText, "agree")) {
      return `This action accepts/agrees to terms (${action}: "${targetText}"). Human review recommended.`;
    }
    return `This action may have significant impact (${action}: "${targetText}").`;
  }
}
