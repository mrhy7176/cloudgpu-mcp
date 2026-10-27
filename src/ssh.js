// SSH to a rented instance: run commands, upload, download.
//
// The SSH password comes from the API and stays inside this process. It is never put in a tool
// result, so it never reaches the model's context or the chat log.
import { Client } from "ssh2";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./api.js";

const MAX_OUTPUT = 20000; // characters of command output returned to the model

export class SshPool {
  constructor() {
    this.conns = new Map(); // instanceId -> { client, key }
  }

  async get(instanceId, ssh) {
    const key = `${ssh.host}:${ssh.port}:${ssh.user}`;
    const cur = this.conns.get(instanceId);
    if (cur && cur.key === key && cur.ready) return cur.client;
    if (cur) this.close(instanceId);
    // Some instance gateways drop several connections opened back to back, so retry with backoff.
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        const client = await connect(ssh);
        const entry = { client, key, ready: true };
        client.on("close", () => {
          entry.ready = false;
        });
        client.on("error", () => {
          entry.ready = false;
        });
        this.conns.set(instanceId, entry);
        return client;
      } catch (err) {
        lastErr = err;
        await sleep(2000 * (i + 1));
      }
    }
    throw new Error(`SSH connection failed: ${lastErr && lastErr.message}`);
  }

  close(instanceId) {
    const cur = this.conns.get(instanceId);
    if (cur) {
      try {
        cur.client.end();
      } catch {
        /* already closed */
      }
      this.conns.delete(instanceId);
    }
  }

  closeAll() {
    for (const id of [...this.conns.keys()]) this.close(id);
  }
}

function connect(ssh) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const timer = setTimeout(() => {
      c.end();
      reject(new Error("timed out"));
    }, 25000);
    c.on("ready", () => {
      clearTimeout(timer);
      resolve(c);
    });
    c.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.connect({
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user || "root",
      password: ssh.password,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
    });
    c.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => ssh.password)));
  });
}

/** Run a command; resolves { code, stdout, stderr } (both truncated to the tail). */
export function exec(client, command, { timeoutSec = 600 } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      let errOut = "";
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try {
          stream.close();
        } catch {
          /* ignore */
        }
        resolve({ code: null, timedOut: true, stdout: tail(out), stderr: tail(errOut) });
      }, timeoutSec * 1000);
      stream.on("data", (d) => {
        out = keepTail(out + d.toString("utf8"));
      });
      stream.stderr.on("data", (d) => {
        errOut = keepTail(errOut + d.toString("utf8"));
      });
      stream.on("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, timedOut: false, stdout: tail(out), stderr: tail(errOut) });
      });
    });
  });
}

function keepTail(s) {
  return s.length > MAX_OUTPUT * 2 ? s.slice(-MAX_OUTPUT * 2) : s;
}

function tail(s) {
  return s.length > MAX_OUTPUT ? "…(earlier output cut)…\n" + s.slice(-MAX_OUTPUT) : s;
}

function sftpOf(client) {
  return new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
}

const p = (fn) =>
  new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

async function mkdirp(sftp, dir) {
  const parts = dir.split("/").filter(Boolean);
  let cur = dir.startsWith("/") ? "" : ".";
  for (const part of parts) {
    cur = `${cur}/${part}`;
    try {
      await p((cb) => sftp.stat(cur, cb));
    } catch {
      await p((cb) => sftp.mkdir(cur, cb)).catch(() => {});
    }
  }
}

/** Upload a local file or directory. Returns { files, bytes }. */
export async function upload(client, localPath, remotePath) {
  const sftp = await sftpOf(client);
  try {
    const st = fs.statSync(localPath);
    let files = 0;
    let bytes = 0;
    const put = async (src, dst) => {
      await mkdirp(sftp, path.posix.dirname(dst));
      await p((cb) => sftp.fastPut(src, dst, cb));
      files += 1;
      bytes += fs.statSync(src).size;
    };
    if (st.isDirectory()) {
      const walk = async (dir, rel) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "__pycache__") continue;
          const src = path.join(dir, ent.name);
          const dst = path.posix.join(remotePath, rel, ent.name);
          if (ent.isDirectory()) await walk(src, path.posix.join(rel, ent.name));
          else if (ent.isFile()) await put(src, dst);
        }
      };
      await mkdirp(sftp, remotePath);
      await walk(localPath, "");
    } else {
      await put(localPath, remotePath.endsWith("/") ? path.posix.join(remotePath, path.basename(localPath)) : remotePath);
    }
    return { files, bytes };
  } finally {
    sftp.end();
  }
}

/** Download a remote file or directory. Returns { files: [{path, bytes}], bytes }. */
export async function download(client, remotePath, localPath) {
  const sftp = await sftpOf(client);
  try {
    const st = await p((cb) => sftp.stat(remotePath, cb));
    const files = [];
    let bytes = 0;
    const get = async (src, dst, size) => {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await p((cb) => sftp.fastGet(src, dst, cb));
      files.push({ path: dst, bytes: size });
      bytes += size;
    };
    if (st.isDirectory()) {
      const walk = async (dir, rel) => {
        const list = await p((cb) => sftp.readdir(dir, cb));
        for (const ent of list) {
          const src = path.posix.join(dir, ent.filename);
          const dst = path.join(localPath, rel, ent.filename);
          if (ent.attrs.isDirectory()) await walk(src, path.join(rel, ent.filename));
          else if (ent.attrs.isFile()) await get(src, dst, ent.attrs.size);
        }
      };
      fs.mkdirSync(localPath, { recursive: true });
      await walk(remotePath, "");
    } else {
      let dst = localPath;
      if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
        dst = path.join(localPath, path.posix.basename(remotePath));
      }
      await get(remotePath, dst, st.size);
    }
    return { files, bytes };
  } finally {
    sftp.end();
  }
}

/** Write a small text file on the instance. */
export async function writeFile(client, remotePath, content) {
  const sftp = await sftpOf(client);
  try {
    await mkdirp(sftp, path.posix.dirname(remotePath));
    await p((cb) => sftp.writeFile(remotePath, content, { mode: 0o700 }, cb));
  } finally {
    sftp.end();
  }
}
