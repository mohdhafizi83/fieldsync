#!/usr/bin/env node
/**
 * npm audit gate — fails CI on high/critical advisories that actually have a
 * fix, and tolerates a small documented allowlist of advisories with NO
 * patched version upstream (recheck these periodically).
 *
 * Why not plain `npm audit --audit-level=high`? As of this writing the only
 * root high advisories in the tree are:
 *   - braces  (DoS via deeply nested glob patterns) — advisory covers <=3.0.3,
 *     and 3.0.3 is the latest release: no patched version exists.
 *   - node-forge (RSA PKCS#1 v1.5 verification quirk) — advisory covers <=1.4.0,
 *     and 1.4.0 is the latest release: no patched version exists.
 * Both arrive only through dev tooling (metro/jest chains and @expo/cli's
 * code-signing dep); neither ships in the Expo app bundle.
 *
 * Usage: node scripts/audit-gate.mjs
 */
import { execFileSync } from 'node:child_process';

const UNPATCHED_ALLOWLIST = new Set([
  'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
  'node-forge RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements',
]);

let raw;
try {
  raw = execFileSync('npm', ['audit', '--audit-level=high', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch (err) {
  // npm exits non-zero when vulnerabilities exist; the JSON on stdout is what we want.
  raw = err.stdout?.toString() ?? '';
  if (!raw) throw err;
}

const audit = JSON.parse(raw);
const offenders = [];
const allowed = [];

for (const [pkg, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
  for (const via of vuln.via ?? []) {
    if (typeof via === 'string') continue; // chained through another package
    const title = via.title ?? '';
    if (UNPATCHED_ALLOWLIST.has(title)) allowed.push(`${pkg}: ${title}`);
    else offenders.push(`${pkg}: ${title} (patched: ${JSON.stringify(via.fixAvailable)})`);
  }
}

if (offenders.length) {
  console.error('npm audit gate: fixable high/critical advisories found:\n  ' + offenders.join('\n  '));
  process.exitCode = 1;
} else {
  console.log(
    `npm audit gate: clean. ${allowed.length} allowlisted advisories have no upstream fix yet:\n  ` +
      [...new Set(allowed.map((a) => a.split(': ').slice(1).join(': ')))].join('\n  '),
  );
}
