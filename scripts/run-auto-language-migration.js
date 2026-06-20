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

const parentHtmlPath = path.join(__dirname, '..', 'public', 'parent.html');
let parentHtml = fs.readFileSync(parentHtmlPath, 'utf8');

const editButton = '        <button class="secondary" onclick="editChildProfile()">Редактировать</button>\n';
if (parentHtml.includes(editButton)) {
  parentHtml = parentHtml.replace(editButton, '');
}

const positionalLabels = [
  "  setText('#childPanel .row-actions button:nth-of-type(1)', t.editChild);",
  "  setText('#childPanel .row-actions button:nth-of-type(2)', t.saveChild);",
  "  setText('#childPanel .row-actions button:nth-of-type(3)', t.clearChild);",
].join('\n');

const actionLabels = [
  "  setText('#childPanel button[onclick=\"saveProfile()\"]', t.saveChild);",
  "  setText('#childPanel button[onclick=\"clearChildProfile()\"]', t.clearChild);",
].join('\n');

if (parentHtml.includes(positionalLabels)) {
  parentHtml = parentHtml.replace(positionalLabels, actionLabels);
} else if (!parentHtml.includes(actionLabels)) {
  throw new Error('Child button localization fragment was not found');
}

const currentAdvancedSpacing = '    .advanced-toggle-panel { border: 1px solid #57408f; border-top: 4px solid #ef4444; background: #151126; border-radius: 10px; padding: 16px; margin: 28px 0 14px; }';
const increasedAdvancedSpacing = '    .advanced-toggle-panel { border: 1px solid #57408f; border-top: 4px solid #ef4444; background: #151126; border-radius: 10px; padding: 16px; margin: 70px 0 14px; }';

if (parentHtml.includes(currentAdvancedSpacing)) {
  parentHtml = parentHtml.replace(currentAdvancedSpacing, increasedAdvancedSpacing);
} else if (!parentHtml.includes(increasedAdvancedSpacing)) {
  throw new Error('Advanced settings spacing rule was not found');
}

fs.writeFileSync(parentHtmlPath, parentHtml, 'utf8');
console.log('[Parent UI] child buttons fixed; advanced settings spacing increased to 84px total');
