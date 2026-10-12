'use strict';

const fs = require('fs');
const path = require('path');

// Agent settings the desktop app can change at runtime (stored in data/settings.json).
class Settings {
  constructor(dataDir, defaults) {
    this.file = path.join(dataDir, 'settings.json');
    this.values = { ...defaults };
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // first run
    }
  }

  get() {
    return { ...this.values };
  }

  set(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in this.values)) throw new Error(`unknown setting "${k}"`);
      if (typeof v !== typeof this.values[k]) throw new Error(`setting "${k}" must be a ${typeof this.values[k]}`);
      this.values[k] = v;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
    return this.get();
  }
}

module.exports = { Settings };
