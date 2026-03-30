const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const htmlPath = path.join(rootDir, 'src', 'renderer', 'index.html');
const cssPath = path.join(rootDir, 'src', 'renderer', 'styles.css');

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read ${path.relative(rootDir, filePath)}: ${error.message}`);
  }
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseTags(source) {
  return source.match(/<[^>]+>/g) || [];
}

function requireCondition(condition, message, failures) {
  if (!condition) failures.push(message);
}

const html = readFile(htmlPath);
const css = readFile(cssPath);
const failures = [];

requireCondition(
  !html.includes('components/VelocityCard.js'),
  'index.html must not include components/VelocityCard.js',
  failures
);

const tags = parseTags(html);
const extractedIds = new Set();
let inlineStyleCount = 0;

for (const tag of tags) {
  const idMatch = tag.match(/\sid\s*=\s*(['"])(.*?)\1/i);
  if (idMatch) {
    extractedIds.add(idMatch[2]);
  }

  if (/\sstyle\s*=/i.test(tag)) {
    inlineStyleCount += 1;
  }
}

requireCondition(
  inlineStyleCount === 0,
  `index.html must not contain inline style attributes (${inlineStyleCount} found)`,
  failures
);

const criticalIds = [
  'splash-overlay',
  'app-container',
  'titlebar',
  'titlebar-drag',
  'titlebar-right',
  'titlebar-controls',
  'btn-minimize',
  'btn-maximize',
  'btn-close',
  'sidebar',
  'btn-sidebar-toggle',
  'btn-connect-titlebar',
  'main-content',
  'cards-grid',
  'position-card',
  'pos-toggle',
  'pos-source-container',
  'hdg-source-container',
  'pos-lat',
  'pos-lon',
  'pos-alt',
  'pos-hacc',
  'pos-vacc',
  'hdg-stats-grid',
  'hdg-val',
  'hdg-pitch',
  'hdg-baseline',
  'pos-extra-fields',
  'pos-map',
  'satellite-card',
  'sat-toggle',
  'sat-source-container',
  'skyplot',
  'sat-stats',
  'imu-card',
  'att-toggle',
  'att-source-container',
  'att-horizon',
  'att-no-att',
  'att-roll',
  'att-pitch',
  'att-yaw',
  'att-ins-status',
  'rf-card',
  'rf-toggle',
  'rf-source-container',
  'rf-jam-state',
  'rf-ant-status',
  'rf-ant-power',
  'rf-update-age',
  'rtk-disconnected',
  'rtk-connected',
  'rtk-profile-list',
  'rtk-btn-connect',
  'rtk-btn-disconnect',
  'rtk-status-dot',
  'rtk-mount',
  'rtk-host',
  'rtk-rate',
  'rtk-progress-fill',
  'rtk-msgs',
  'rtk-duration',
  'rtk-types',
  'update-check-btn',
  'update-check-label',
  'update-expand',
  'update-release-notes',
  'update-progress-bar',
  'update-progress-fill',
  'update-actions',
  'update-version',
  'connect-dialog',
  'serial-port',
  'serial-baud',
  'btn-refresh-ports',
  'btn-cancel-connect',
  'btn-do-connect',
  'terminal-output',
  'terminal-input',
  'btn-term-time',
  'btn-term-scroll',
  'btn-term-clear',
  'btn-term-save',
  'settings-panel-messages',
  'settings-panel-ethernet',
  'settings-panel-base-rover',
  'settings-panel-heading',
  'settings-panel-ins',
  'ntrip-btn-connect',
  'ntrip-btn-disconnect',
  'ntrip-status-text',
  'ntrip-live-dot',
  'ntrip-host',
  'ntrip-port',
  'ntrip-mountpoint',
  'ntrip-username',
  'ntrip-password',
  'ntrip-sourcetable-section',
  'ntrip-sourcetable-body',
  'ntrip-error-log',
  'ntrip-profile-select',
  'ntrip-btn-save-profile',
  'ntrip-btn-delete-profile',
  'ntrip-btn-fetch-mounts'
];

const missingIds = criticalIds.filter((id) => !extractedIds.has(id));
if (missingIds.length > 0) {
  failures.push(`Missing critical renderer IDs: ${missingIds.join(', ')}`);
}

const cssWithoutComments = stripCssComments(css);

requireCondition(
  /:focus-visible\b/.test(cssWithoutComments),
  'styles.css must include a :focus-visible rule',
  failures
);

requireCondition(
  /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/i.test(cssWithoutComments),
  'styles.css must include an @media (prefers-reduced-motion: reduce) rule',
  failures
);

if (failures.length > 0) {
  console.error('Renderer UI verification failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Renderer UI verification passed.');
