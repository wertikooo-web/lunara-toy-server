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

const quickButton = '        <button id="basicToggleButton" type="button" onclick="toggleBasicSettings()">Настройки</button>';
const quickButtonWithHelp = [
  '        <div class="quick-settings-row">',
  '          <button id="basicToggleButton" type="button" onclick="toggleBasicSettings()">Настройки</button>',
  '          <span id="basicHelpInline" class="small">(Профиль ребенка, Профиль игрушки, Время работы)</span>',
  '        </div>',
].join('\n');

if (parentHtml.includes(quickButton)) {
  parentHtml = parentHtml.replace(quickButton, quickButtonWithHelp);
} else if (!parentHtml.includes('id="basicHelpInline"')) {
  throw new Error('Basic settings button fragment was not found');
}

const quickActionsStyle = '    .quick-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; }';
const quickActionsStyleWithInlineHelp = [
  '    .quick-settings-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }',
  '    .quick-settings-row button { margin: 0; }',
  quickActionsStyle,
].join('\n');

if (parentHtml.includes(quickActionsStyle)) {
  parentHtml = parentHtml.replace(quickActionsStyle, quickActionsStyleWithInlineHelp);
} else if (!parentHtml.includes('.quick-settings-row {')) {
  throw new Error('Quick settings row style insertion point was not found');
}

const oldProfilesTitleText = "    profiles: 'Профили ребёнка',";
const newProfilesTitleText = "    profiles: 'Выбор профиля ребенка',";
if (parentHtml.includes(oldProfilesTitleText)) {
  parentHtml = parentHtml.replace(oldProfilesTitleText, newProfilesTitleText);
} else if (!parentHtml.includes(newProfilesTitleText)) {
  throw new Error('Russian profiles title text was not found');
}

const oldProfilesStaticHeading = '      <h2>Профили</h2>';
const newProfilesStaticHeading = '      <h2>Выбор профиля ребенка</h2>';
if (parentHtml.includes(oldProfilesStaticHeading)) {
  parentHtml = parentHtml.replace(oldProfilesStaticHeading, newProfilesStaticHeading);
} else if (!parentHtml.includes(newProfilesStaticHeading)) {
  throw new Error('Static profiles heading was not found');
}

const oldAdvancedHelpText = "    advancedHelp: '(Профили, контент и тонкие параметры открываются здесь.)',";
const newAdvancedHelpText = "    advancedHelp: '(Смена профиля, Настройки контента, Активность)',";
if (parentHtml.includes(oldAdvancedHelpText)) {
  parentHtml = parentHtml.replace(oldAdvancedHelpText, newAdvancedHelpText);
} else if (!parentHtml.includes(newAdvancedHelpText)) {
  throw new Error('Russian advanced help text was not found');
}

const oldAdvancedHelpStatic = '      <p id="advancedHelp" class="small">(Профили, контент и тонкие параметры открываются здесь.)</p>';
const newAdvancedHelpStatic = '      <p id="advancedHelp" class="small">(Смена профиля, Настройки контента, Активность)</p>';
if (parentHtml.includes(oldAdvancedHelpStatic)) {
  parentHtml = parentHtml.replace(oldAdvancedHelpStatic, newAdvancedHelpStatic);
} else if (!parentHtml.includes(newAdvancedHelpStatic)) {
  throw new Error('Static advanced help text was not found');
}

const oldAnalyticsText = "    analytics: 'Аналитика',";
const newAnalyticsText = "    analytics: 'Активность',";
if (parentHtml.includes(oldAnalyticsText)) {
  parentHtml = parentHtml.replace(oldAnalyticsText, newAnalyticsText);
} else if (!parentHtml.includes(newAnalyticsText)) {
  throw new Error('Russian analytics label was not found');
}

const oldAnalyticsButton = '      <button class="secondary" onclick="toggleAnalytics()">Аналитика</button>';
const newAnalyticsButton = '      <button class="secondary" onclick="toggleAnalytics()">Активность</button>';
if (parentHtml.includes(oldAnalyticsButton)) {
  parentHtml = parentHtml.replace(oldAnalyticsButton, newAnalyticsButton);
} else if (!parentHtml.includes(newAnalyticsButton)) {
  throw new Error('Static analytics button was not found');
}

fs.writeFileSync(parentHtmlPath, parentHtml, 'utf8');
console.log('[Parent UI] labels updated: advanced help and activity button');
