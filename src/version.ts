import { readFileSync } from 'node:fs';

// src/ and dist/ are both direct children of the package root.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION: string = pkg.version;
export const USER_AGENT = `SiteCheck/${VERSION}`;
