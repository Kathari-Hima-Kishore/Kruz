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
  async detectHumanNeeded(page: any): Promise<{ needed: boolean; reason?: string }> {
    try {
      // Check for CAPTCHA indicators
      const hasCaptcha = await page.locator(
        '[class*="captcha"], [id*="captcha"], [class*="recaptcha"], ' +
        '[id*="recaptcha"], iframe[src*="recaptcha"], iframe[src*="captcha"], ' +
        '[class*="hcaptcha"], iframe[src*="hcaptcha"]'
      ).count() > 0;

      if (hasCaptcha) {
        return { needed: true, reason: "CAPTCHA detected on page" };
      }

      // Check for login forms (password fields)
      const hasPasswordField = await page.locator(
        'input[type="password"], input[name*="password"], input[id*="password"]'
      ).count() > 0;

      if (hasPasswordField) {
        return { needed: true, reason: "Login/password form detected" };
      }

      // Check for 2FA indicators
      const has2FA = await page.locator(
        '[class*="2fa"], [class*="two-factor"], [class*="otp"], ' +
        'input[name*="otp"], input[name*="code"], input[id*="otp"]'
      ).count() > 0;

      if (has2FA) {
        return { needed: true, reason: "Two-factor authentication detected" };
      }
    } catch {
      // Ignore detection errors
    }

    return { needed: false };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getTargetText(target?: { name?: string; text?: string; role?: string }): string {
    if (!target) return "";
    return (target.name || target.text || "").toLowerCase();
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
        if (targetText.includes(keyword)) return true;
      }
    }

    // Check for destructive patterns
    for (const keyword of destructiveKeywords) {
      if (targetText.includes(keyword)) return true;
    }

    // Check URL patterns for payment/checkout
    if (url) {
      const paymentPatterns = [
        /checkout/i, /payment/i, /pay/i, /purchase/i,
        /cart.*review/i, /billing/i,
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
      if (targetText.includes(keyword)) return true;
    }

    return false;
  }

  private getReason(action: string, targetText: string): string {
    if (targetText.includes("delete") || targetText.includes("remove")) {
      return `This action appears to be destructive (${action}: "${targetText}"). Human review recommended.`;
    }
    if (targetText.includes("submit") || targetText.includes("send")) {
      return `This action submits/sends data (${action}: "${targetText}"). Human review recommended.`;
    }
    if (targetText.includes("pay") || targetText.includes("purchase")) {
      return `This action involves payment (${action}: "${targetText}"). Human review required.`;
    }
    if (targetText.includes("accept") || targetText.includes("agree")) {
      return `This action accepts/agrees to terms (${action}: "${targetText}"). Human review recommended.`;
    }
    return `This action may have significant impact (${action}: "${targetText}").`;
  }
}
