'use strict';

// Files reports as GitHub issues so Claude can read them with its GitHub tools.

class GitHubReporter {
  constructor(cfg, fetchImpl = fetch) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.cfg.token && this.cfg.repo);
  }

  async request(method, path, body) {
    const res = await this.fetch(`${this.cfg.api}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gnd-control-agent',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json && json.message) || text.slice(0, 200) || res.statusText;
      throw new Error(`GitHub ${res.status}: ${msg}`);
    }
    return json;
  }

  // Returns an open report issue with the same title, so auto reports do not pile up.
  async findOpen(title) {
    const q = `?state=open&labels=${encodeURIComponent(this.cfg.label)}&per_page=50`;
    const list = await this.request('GET', `/repos/${this.cfg.repo}/issues${q}`);
    return (list || []).find((i) => i.title === title && !i.pull_request) || null;
  }

  async report({ title, body, dedupe = false }) {
    if (!this.enabled) throw new Error('GITHUB_TOKEN is not set in control/agent/.env');
    if (dedupe) {
      const existing = await this.findOpen(title);
      if (existing) {
        await this.request('POST', `/repos/${this.cfg.repo}/issues/${existing.number}/comments`, { body });
        return { url: existing.html_url, number: existing.number, updated: true };
      }
    }
    const issue = await this.request('POST', `/repos/${this.cfg.repo}/issues`, {
      title,
      body,
      labels: [this.cfg.label],
    });
    return { url: issue.html_url, number: issue.number, updated: false };
  }
}

module.exports = { GitHubReporter };
