import { normalizePhone } from "./db.mjs";

/**
 * Natural-language command engine (restored workflow: "natural-language
 * commands and interactions"). Parses a plain-English instruction into an
 * actionable command handled by the console/server. Deterministic pattern
 * matcher, no model required; the console exposes the same interface.
 *
 * Examples:
 *   "show the dashboard" / "how are we doing"
 *   "anything needing review" / "pending receipts" / "review queue"
 *   "run the draw for 2026-W40" / "draw week 40"
 *   "draft a reply for the promotion chat" / "help me reply to OK-HRE-01"
 *   "send 'thanks' to 263771234567" / "text tauya"
 *   "summarise the last 48 hours" / "brief"
 *   "which entries qualify" / "list entries" / "winners"
 *   "link my phone" / "show the qr code" / "unlink"
 *   "what's the system status" / "status"
 *   "classify this: <text>"
 */

export const INTENTS = {
  DASHBOARD: ["dashboard", "overview", "how are we doing", "summary", "metrics", "report", "status of everything"],
  REVIEW: ["review", "needs review", "pending", "must review", "unread receipts", "inbox"],
  ENTRIES: ["entries", "qualified", "submissions", "applicants list"],
  PARTICIPANTS: ["participants", "customers", "registrants", "clients"],
  CAMPAIGNS: ["campaigns", "campaign", "promotions running"],
  WINNERS: ["winners", "winner list", "who won"],
  DRAW: ["draw", "run the draw", "pick winners"],
  DRAFT: ["draft", "write a reply", "help me reply", "compose"],
  SEND: ["send", "message", "text ", "reply to"],
  BRIEF: ["brief", "summarise", "summarize", "triage", "what came in"],
  STATUS: ["status", "health", "is the system up", "connected"],
  LINK: ["link", "pair", "qr code", "scan"],
  UNLINK: ["unlink", "disconnect", "remove device"],
  CLASSIFY: ["classify", "triage this", "what category"],
  HELP: ["help", "what can you do", "commands"],
};

function extractPeriod(text) {
  const m = text.match(/(20\d\d[- ]?W\s?\d{1,2})|(?:week|period)[\s-]*(\d{1,2})/i) || text.match(/(20\d\d)\s*[-/]\s*(\d{1,2})/);
  if (!m) return null;
  if (m[1]) return m[1].replace(/[\s-]/g, "-").toUpperCase();
  if (m[3] && m[4]) return `${m[3]}-W${String(m[4]).padStart(2, "0")}`;
  return null;
}

/**
 * The recipient is taken ONLY from an explicit trailing "to <number>" (the same
 * anchor the body stripper below uses). Taking the first 9+ digit run anywhere
 * in the text delivered support messages to whatever number happened to be
 * quoted in the body — a callback line, a receipt number, a claim reference or
 * an ID — i.e. one participant's claim details went to a stranger's WhatsApp.
 * No trailing recipient means no recipient: the command is refused instead.
 */
function extractPhone(text) {
  const m = String(text).match(/\s(?:to|@)\s*(\+?\d[\d\s()-]{8,})\s*$/i);
  if (!m) return null;
  return normalizePhone(m[1]);
}

function extractTextChunk(text, strippedStart) {
  const rest = String(text).replace(strippedStart, "").trim();
  // quoted text wins
  const q = rest.match(/(['"])(.*?)\1/);
  if (q) return q[2];
  return rest;
}

const KEYWORD_RE = new Map();
/**
 * Keywords match on WORD BOUNDARIES. Plain substring matching made every
 * keyword a prefix of longer words: "unlink my phone" contains "link", so the
 * revocation command was answered with a pairing QR while the lost device
 * stayed authorised on the business number (and UNLINK was unreachable for
 * every input). The old `low.includes(name)` clause is gone too — it made each
 * intent NAME a hidden keyword with the same substring problem.
 */
function keywordHit(low, keyword) {
  const k = keyword.trim();
  let re = KEYWORD_RE.get(k);
  // A trailing plural/gerund still counts as the same keyword. Word boundaries
  // alone reclassified every inflected form the old substring matcher routed:
  // "reports" / "show me the reports" lost the dashboard, "run the draws" lost
  // the draw, and /api/nl answers a null action with the generic help text, so
  // those console command-bar phrases stopped doing anything at all. The suffix
  // is OUTSIDE the keyword and still anchored by \b, so "unlink" is still not
  // "link".
  if (!re) { re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es|ing)?\\b`, "i"); KEYWORD_RE.set(k, re); }
  return re.test(low);
}

export function parseCommand(text) {
  const t = String(text || "").trim();
  const low = t.toLowerCase();
  let intent = null;
  for (const [name, keys] of Object.entries(INTENTS)) {
    if (keys.some((k) => keywordHit(low, k))) { intent = name; break; }
  }

  switch (intent) {
    case "DRAW": {
      const period = extractPeriod(t);
      return { action: "draw", params: { period }, confidence: period ? 0.9 : 0.6, reply: period ? `Starting the draw for ${period}.` : "Which week? e.g. \"run the draw for 2026-W40\"." };
    }
    case "DRAFT": {
      return { action: "draft", params: { target: extractPhone(t), text: extractTextChunk(t, `draft`).slice(0, 300) }, confidence: 0.75, reply: "Opening the draft assistant." };
    }
    case "SEND": {
      const phone = extractPhone(t);
      const m2 = t.match(/(?:send|message|text|reply to)\s*[:,\-]?\s*(.*)/i);
      let textChunk = (m2 ? m2[1] : "").trim();
      const q = textChunk.match(/(['"])(.*?)\1/);
      if (q) textChunk = q[2];
      else textChunk = textChunk.replace(/\s+(?:to|@)\s*\+?[\d\s()-]{8,}$/i, "").trim().replace(/^["']|["']$/g, "");
      return phone && textChunk ? { action: "send", params: { phone, text: textChunk.slice(0, 4000) }, confidence: 0.85, reply: `Sending to ${phone.slice(-9)}.` }
        : { action: "send", params: null, confidence: 0.4, reply: "Who should I message? e.g. \"send: thanks for entering to 263771234567\"" };
    }
    case "BRIEF": return { action: "brief", params: {}, confidence: 0.8, reply: "Running the brief." };
    case "STATUS": return { action: "status", params: {}, confidence: 0.9, reply: "Checking system status." };
    case "LINK": return { action: "link", params: {}, confidence: 0.9, reply: "Opening the QR link screen." };
    case "UNLINK": return { action: "unlink", params: {}, confidence: 0.9, reply: "Unlinking the WhatsApp device." };
    case "REVIEW": return { action: "review", params: { limit: 20, status: "NEEDS_REVIEW" }, confidence: 0.8, reply: "Loading the review queue." };
    case "ENTRIES": return { action: "entries", params: {}, confidence: 0.8, reply: "Listing qualified entries." };
    case "PARTICIPANTS": return { action: "participants", params: {}, confidence: 0.8, reply: "Listing participants." };
    case "CAMPAIGNS": return { action: "campaigns", params: {}, confidence: 0.8, reply: "Listing campaigns." };
    case "WINNERS": return { action: "winners", params: {}, confidence: 0.8, reply: "Fetching latest winners." };
    case "CLASSIFY": {
      const textChunk = extractTextChunk(t, "classify");
      return { action: "classify", params: { text: textChunk }, confidence: 0.7, reply: "Classifying…" };
    }
    case "DASHBOARD": return { action: "dashboard", params: {}, confidence: 0.85, reply: "Opening the dashboard." };
    case "HELP": return { action: "help", params: {}, confidence: 1, reply: null };
    default: return { action: null, params: {}, confidence: 0, reply: null };
  }
}

export const HELP_TEXT = `I can do these, in plain English:
- "show the dashboard" — platform overview and metrics
- "anything needing review" — the receipt review queue
- "list entries" / "participants" / "campaigns" / "winners"
- "run the draw for 2026-W40" — freeze, execute, approve, publish
- "brief" / "summarise the last 48 hours" — AI traffic brief
- "draft a reply for X" — AI reply drafting
- "send: thanks for entering to 263771234567" — outbound message
- "classify this: <text>" — AI classification
- "link my phone" (QR) / "unlink" / "status" / "help"`;