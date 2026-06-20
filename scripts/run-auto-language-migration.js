'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'apply-auto-language-migration.js');
const runtimePath = path.join(__dirname, '.apply-auto-language-migration.runtime.js');
let source = fs.readFileSync(sourcePath, 'utf8');

const faulty = '    "        `- Main language setting: ${promptLang}` ,".replace(\' `\',\'`\').replace(\'` ,\',\'`,\'),';
const corrected = '    "        `- Main language setting: ${promptLang}` ,".replace(\'` ,\',\'`,\'),';

if (source.includes(faulty)) {
  source = source.replace(faulty, corrected);
} else if (!source.includes(corrected)) {
  throw new Error('AUTO language migration source has an unexpected prompt-language fragment');
}

fs.writeFileSync(runtimePath, source, 'utf8');
try {
  require(runtimePath);
} finally {
  fs.rmSync(runtimePath, { force: true });
}
