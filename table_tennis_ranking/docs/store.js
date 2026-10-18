// Loading and saving data.json.
// Viewers read the copy published on the website. The recorder reads and writes the file in
// the GitHub repository directly, and keeps a working copy on the phone so nothing is lost
// if the signal drops at the venue.

const CONFIG_KEY = 'ttr.recorder';
const WORKING_KEY = 'ttr.working';
// Every save rebuilds the GitHub Pages site, which allows about 10 builds an hour,
// so results entered during a night are uploaded at most every 5 minutes.
export const NIGHT_SAVE_INTERVAL = 5 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;

const readJson = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };

export const loadConfig = () => readJson(CONFIG_KEY);
export const saveConfig = cfg => localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
export function forgetConfig() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(WORKING_KEY);
}

export async function loadPublished() {
  const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load the results (error ${res.status})`);
  return res.json();
}

const toBase64 = text => {
  let bin = '';
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin);
};
const fromBase64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

async function github(cfg, method, body) {
  const ref = method === 'GET' ? `?ref=${encodeURIComponent(cfg.branch)}` : '';
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${cfg.path}${ref}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('No connection to GitHub'), { status: 0 });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.message || `GitHub error ${res.status}`), { status: res.status });
  return json;
}

export async function getFile(cfg) {
  const json = await github(cfg, 'GET');
  return { data: JSON.parse(fromBase64(json.content)), sha: json.sha };
}

async function putFile(cfg, data, sha, message) {
  const json = await github(cfg, 'PUT', {
    message, sha, branch: cfg.branch,
    content: toBase64(JSON.stringify(data, null, 1) + '\n'),
  });
  return json.content.sha;
}

const commitMessage = messages =>
  messages.length === 1 ? messages[0] : `${messages.length} changes: ${messages.join('; ')}`.slice(0, 900);

export class Recorder {
  constructor(cfg, onStatus) {
    this.cfg = cfg;
    this.onStatus = onStatus;
    this.data = null;
    this.sha = null;
    this.rev = 0;
    this.savedRev = 0;
    this.messages = [];
    this.lastPush = 0;
    this.timer = null;
    this.due = 0;
    this.busy = false;
    this.status = 'saved';
    this.detail = '';
  }

  get dirty() { return this.rev !== this.savedRev; }

  setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    this.onStatus();
  }

  // keepLocal(): asked only when this phone has unsaved changes and GitHub has moved on.
  async load(keepLocal) {
    const local = readJson(WORKING_KEY);
    const pending = local && local.repo === this.cfg.repo && local.dirty ? local : null;
    let remote;
    try {
      remote = await getFile(this.cfg);
    } catch (e) {
      if (e.status !== 0 || !pending) throw e;
      this.adopt(pending, pending.sha);
      this.setStatus('offline', 'No connection. Using the copy saved on this phone.');
      this.schedule(RETRY_DELAY);
      return this.data;
    }
    if (pending && (pending.sha === remote.sha || keepLocal())) {
      this.adopt(pending, remote.sha);
      this.setStatus('pending');
      this.schedule(0);
      return this.data;
    }
    this.data = remote.data;
    this.sha = remote.sha;
    this.writeLocal();
    this.setStatus('saved');
    return this.data;
  }

  adopt(local, sha) {
    this.data = local.data;
    this.sha = sha;
    this.messages = local.messages || [];
    this.rev = 1;
    this.savedRev = 0;
  }

  writeLocal() {
    try {
      localStorage.setItem(WORKING_KEY, JSON.stringify({
        repo: this.cfg.repo, sha: this.sha, dirty: this.dirty, messages: this.messages, data: this.data,
      }));
    } catch { /* storage full or blocked: the upload still happens */ }
  }

  // Record a change. throttle: upload no sooner than NIGHT_SAVE_INTERVAL after the last one.
  change(message, throttle) {
    this.rev++;
    this.messages.push(message);
    this.writeLocal();
    const wait = throttle ? this.lastPush + NIGHT_SAVE_INTERVAL - Date.now() : 0;
    this.schedule(Math.max(1500, wait));
    if (this.status === 'saved') this.setStatus('pending');
  }

  schedule(delay) {
    const due = Date.now() + delay;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => { this.timer = null; this.push(); }, delay);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    return this.push();
  }

  async push() {
    if (!this.dirty) return;
    if (this.busy) { this.schedule(2000); return; }
    this.busy = true;
    const rev = this.rev, count = this.messages.length;
    this.setStatus('saving');
    try {
      this.sha = await putFile(this.cfg, this.data, this.sha, commitMessage(this.messages.slice(0, count)));
      this.savedRev = rev;
      this.lastPush = Date.now();
      this.messages.splice(0, count);
      this.writeLocal();
      this.setStatus(this.dirty ? 'pending' : 'saved');
    } catch (e) {
      if (e.status === 409 || e.status === 422) {
        this.setStatus('conflict', 'GitHub has a newer version than this phone, so nothing was overwritten. ' +
          'Use "Overwrite GitHub" to keep this phone\'s version, or "Discard" to load GitHub\'s.');
      } else if (e.status === 401 || e.status === 403 || e.status === 404) {
        this.setStatus('error', `GitHub refused the save (${e.message}). Check the token in Settings.`);
      } else {
        this.setStatus('offline', 'No connection. Results are kept on this phone and will upload automatically.');
        this.schedule(RETRY_DELAY);
      }
    } finally {
      this.busy = false;
    }
  }

  async overwrite() {
    this.sha = (await getFile(this.cfg)).sha;
    return this.saveNow();
  }

  async discard() {
    localStorage.removeItem(WORKING_KEY);
    clearTimeout(this.timer);
    this.timer = null;
    this.rev = this.savedRev = 0;
    this.messages = [];
    const remote = await getFile(this.cfg);
    this.data = remote.data;
    this.sha = remote.sha;
    this.writeLocal();
    this.setStatus('saved');
    return this.data;
  }
}
