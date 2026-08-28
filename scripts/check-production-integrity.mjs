#!/usr/bin/env node
// Shared production-file integrity guard.
//
// Both the Pages deploy workflow and the pull request validation workflow run
// this exact script so the two can never silently diverge. It is a direct port
// of the check that previously lived inline in deploy-pages.yml.
//
// Runs before `npm ci`, so it must stay dependency-free.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const checks = {
  'src/App.tsx': {
    minimum: 30000,
    sentinels: ['FriendsRoute', 'MediaCard', 'PlaybackModal', 'loadDiscovery', 'openContext', 'export function App'],
  },
  'src/components/FriendsExperience.tsx': {
    minimum: 36000,
    sentinels: ['createRoom', 'joinRoom', 'sendMessage', 'subscribe', 'clearChat', 'PartyPlaybackPlayer', 'export function FriendsExperience'],
  },
  'src/friends.css': {
    minimum: 8000,
    sentinels: ['.watch-party', '.resume-room-card', '.party-chat', '.party-roster'],
  },
  'tests/friends-watch-party.test.tsx': {
    minimum: 10000,
    sentinels: ['Create private room', 'Join invite', 'Stay in room', 'Resume hosting', 'Jump to latest message', 'Message the room'],
  },
};

const placeholderBodies = new Set(['PLACEHOLDER_APP', 'PLACEHOLDER_FRIENDS', 'PLACEHOLDER_CSS', 'PLACEHOLDER_TEST']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

for (const [file, spec] of Object.entries(checks)) {
  const size = statSync(file).size;
  const text = readFileSync(file, 'utf8');
  if (size < spec.minimum) {
    fail(`${file} is ${size} bytes; expected at least ${spec.minimum}`);
  }
  if (text.includes('PLACEHOLDER_') || placeholderBodies.has(text.trim())) {
    fail(`${file} still contains a placeholder overwrite`);
  }
  const missing = spec.sentinels.filter((token) => !text.includes(token));
  if (missing.length) {
    fail(`${file} is missing production sentinels: ${missing.join(', ')}`);
  }
  console.log(`${file}: ${size} bytes, sentinels ok`);
}

const suite = readdirSync('tests')
  .filter((name) => /^friends-watch-party.*\.test\.tsx$/.test(name))
  .sort()
  .map((name) => path.join('tests', name));
const suiteText = suite.map((file) => readFileSync(file, 'utf8')).join('\n');
const suiteSize = suite.reduce((total, file) => total + statSync(file).size, 0);
if (suiteSize < 25000) {
  fail(`Friends test suite is ${suiteSize} bytes; expected at least 25000`);
}
const suiteSentinels = ['Room controls', 'Make Date Night co-host', 'Change title', 'Automated GlockTV host', 'Resync me'];
const missingSuite = suiteSentinels.filter((token) => !suiteText.includes(token));
if (missingSuite.length) {
  fail(`Friends test suite is missing coverage: ${missingSuite.join(', ')}`);
}
console.log(`friends suite: ${suiteSize} bytes across ${suite.length} files`);
console.log('integrity ok');
