// Guardrails that run on this machine, before anything reaches the API or the instance.
// The hard limits (auto-shutdown on time, budget and idle GPU) are enforced by CloudGPU's servers;
// these catch mistakes early and keep secrets out of the model's context.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ── Commands that would break the instance ───────────────────────────────────
//
// Every CloudGPU instance runs a small platform monitoring agent, and the platform checks on it
// over SSH. Changing the root password, rewriting the SSH config or killing the agent locks that
// check out, and the platform then shuts the instance down. These patterns stop an assistant from
// doing that by accident (for example while "hardening" SSH or "cleaning up" processes).
const BLOCKED = [
  { re: /\b(passwd|chpasswd)\b/, why: "changes a login password" },
  { re: /\busermod\b[^\n]*\s-p\b/, why: "changes a login password" },
  { re: /sshd_config|\/etc\/ssh\//, why: "edits the SSH server configuration" },
  { re: /\b(systemctl|service)\s+(stop|disable|mask|restart)\s+(ssh|sshd)\b/, why: "stops the SSH server" },
  { re: /cgpu-(watchdog|agent)/, why: "touches the platform monitoring agent" },
  { re: /\bkill\s+(-9\s+|-KILL\s+|-s\s+KILL\s+)?-1\b/, why: "kills every process on the machine" },
  { re: /\bpkill\s+(-9\s+)?(-f\s+)?(bash|sh|sshd)\b/, why: "kills the shells the platform relies on" },
  { re: /\bkillall\s+(-9\s+)?(bash|sh|sshd)\b/, why: "kills the shells the platform relies on" },
  { re: /\b(iptables|nft|ufw)\b/, why: "changes the firewall" },
];

export function checkCommand(command) {
  for (const b of BLOCKED) {
    if (b.re.test(command)) {
      return (
        `Refused: this command ${b.why}. CloudGPU instances must stay reachable for the platform's ` +
        `monitoring, otherwise the instance is shut down. Do the task another way.`
      );
    }
  }
  return null;
}

// ── Local files that should not be shipped to a rented machine by default ─────
const SENSITIVE = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config\/gcloud(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.env(\..*)?$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
];

export function sensitiveReason(localPath) {
  const abs = path.resolve(expandHome(localPath)).replace(/\\/g, "/");
  if (abs === os.homedir().replace(/\\/g, "/")) return "it is your whole home directory";
  for (const re of SENSITIVE) if (re.test(abs)) return "it looks like credentials or a secrets file";
  return null;
}

export function expandHome(p) {
  if (!p) return p;
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

// ── Redaction ─────────────────────────────────────────────────────────────
/** Remove secrets (API key, SSH password, SSH host) from any text going back to the model. */
export function redact(text, secrets) {
  if (text == null) return text;
  let out = String(text);
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join("[redacted]");
  }
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]");
  return out;
}

/** Instance object as the model sees it: no SSH host, user or password. */
export function publicInstance(inst) {
  if (!inst) return inst;
  const { ssh, ...rest } = inst;
  return { ...rest, ssh_ready: !!(ssh && ssh.host && inst.status === "running") };
}

// ── Quotes ────────────────────────────────────────────────────────────────
//
// create_instance only accepts a quote_id from estimate_cost, so the assistant always has the
// real hourly price, the estimate and the balance in hand (and shows them) before renting.
export class Quotes {
  constructor(ttlMs = 15 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  put(q) {
    const id = "q_" + crypto.randomBytes(6).toString("hex");
    this.map.set(id, { ...q, id, at: Date.now() });
    return id;
  }
  take(id) {
    const q = this.map.get(id);
    if (!q) return { error: "Unknown quote_id. Call estimate_cost first and show the quote to the user." };
    if (Date.now() - q.at > this.ttlMs) {
      this.map.delete(id);
      return { error: "This quote expired (quotes last 15 minutes). Call estimate_cost again; prices are live." };
    }
    this.map.delete(id);
    return { quote: q };
  }
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Shell-quote one argument for bash. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
