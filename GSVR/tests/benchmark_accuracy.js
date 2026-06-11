const fs = require('fs');
const path = require('path');

const lib = require('./accuracy_benchmark_lib.js');

function parseArgs(argv) {
  const options = {
    suite: 'gold',
    family: null,
    json: false,
    failOnRegression: false,
    writeBaseline: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--fail-on-regression') {
      options.failOnRegression = true;
    } else if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else if (arg === '--suite' && argv[index + 1]) {
      options.suite = argv[index + 1];
      index++;
    } else if (arg === '--family' && argv[index + 1]) {
      options.family = argv[index + 1];
      index++;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log([
    'Usage: node GSVR/tests/benchmark_accuracy.js [options]',
    '',
    'Options:',
    '  --suite gold|shadow|real|all',
    '  --family <fixture-family>',
    '  --json',
    '  --fail-on-regression',
    '  --write-baseline',
    '',
    'Artifacts:',
    `  Writes json/html/markdown reports to ${lib.REPORTS_DIR}`,
  ].join('\n'));
}

function deepSubsetEqual(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((value, index) => deepSubsetEqual(value, actual[index]));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.keys(expected).every((key) => deepSubsetEqual(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
  return `${Number(value || 0).toFixed(2)}ms`;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'latest';
}

function buildArtifactBaseName(report) {
  const suiteSlug = slugify(report.suite || 'all');
  const familySlug = report.family ? `-${slugify(report.family)}` : '';
  return `accuracy-${suiteSlug}${familySlug}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMatrixMarkdown(title, matrix) {
  const rows = Object.keys(matrix || {});
  if (!rows.length) return `### ${title}\n\n_No data._`;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(matrix[row] || {})))).sort();
  const header = ['Expected \\ Actual', ...columns];
  const divider = header.map(() => '---');
  const body = rows.sort().map((row) => [
    row,
    ...columns.map((column) => String(matrix[row]?.[column] || 0)),
  ]);
  return [
    `### ${title}`,
    '',
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...body.map((line) => `| ${line.join(' | ')} |`),
  ].join('\n');
}

function renderSuiteMarkdown(report, suiteName, suiteReport) {
  const sections = [
    `## ${suiteName}`,
    '',
    '| Family | Total | Pass | Accuracy | Precision | Recall | Abstain | Ambiguous | Mean | P95 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const familyName of Object.keys(suiteReport.families).sort()) {
    const family = suiteReport.families[familyName];
    sections.push(
      `| ${familyName} | ${family.total} | ${family.passed} | ${percent(family.exactAccuracy)} | ${percent(family.precision)} | ${percent(family.recall)} | ${percent(family.abstainRate)} | ${percent(family.ambiguityRate)} | ${formatMs(family.meanLatencyMs)} | ${formatMs(family.p95LatencyMs)} |`
    );
  }

  for (const familyName of Object.keys(suiteReport.families).sort()) {
    const family = suiteReport.families[familyName];
    sections.push('', `### ${familyName}`, '');
    sections.push(renderMatrixMarkdown('Status Confusion', family.statusConfusion));
    if (familyName === 'conference_resolution') {
      sections.push('', renderMatrixMarkdown('Conference Rank Confusion', family.conferenceRankConfusion));
    }
    if (familyName === 'journal_resolution') {
      sections.push('', renderMatrixMarkdown('Journal Quartile Confusion', family.journalQuartileConfusion));
    }
    if (family.sampleFailures?.length) {
      sections.push('', '### Sample Failures', '');
      for (const failure of family.sampleFailures) {
        sections.push(`- \`${failure.id}\` expected \`${JSON.stringify(failure.expected)}\` but saw \`${JSON.stringify(failure.actual)}\``);
      }
    }
  }

  return sections.join('\n');
}

function renderMarkdownReport(report, issues, artifactPaths) {
  const lines = [
    '# Accuracy Benchmark Report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Suite: \`${report.suite}\``,
    `- Family: ${report.family ? `\`${report.family}\`` : 'all families'}`,
    `- Fixtures: ${report.fixtureCount}`,
    `- JSON artifact: \`${artifactPaths.json}\``,
    `- HTML artifact: \`${artifactPaths.html}\``,
  ];

  if (issues.length) {
    lines.push('', '## Gating Issues', '');
    for (const issue of issues) lines.push(`- ${issue}`);
  }

  if (report.topRegressions?.length) {
    lines.push('', '## Top Regressions', '');
    for (const regression of report.topRegressions.slice(0, 20)) {
      lines.push(`- \`${regression.suite}/${regression.family}/${regression.id}\``);
    }
  }

  for (const [suiteName, suiteReport] of Object.entries(report.suites)) {
    lines.push('', renderSuiteMarkdown(report, suiteName, suiteReport));
  }

  return `${lines.join('\n')}\n`;
}

function metricTone(value, kind) {
  if (kind === 'count') return 'neutral';
  if (kind === 'issues') return value > 0 ? 'bad' : 'good';
  if (kind === 'latency') {
    if (value <= 2) return 'good';
    if (value <= 8) return 'neutral';
    return 'warn';
  }
  if (kind === 'secondary') return 'neutral';
  if (value >= 0.98) return 'good';
  if (value >= 0.9) return 'warn';
  return 'bad';
}

function renderMetricChip(label, value, tone) {
  return `<div class="metric-chip metric-chip--${tone}">
    <span class="metric-chip__label">${escapeHtml(label)}</span>
    <strong class="metric-chip__value">${escapeHtml(value)}</strong>
  </div>`;
}

function renderOverviewCard(title, subtitle, metrics) {
  return `<article class="overview-card">
    <div class="overview-card__header">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    <div class="overview-card__metrics">
      ${metrics.join('')}
    </div>
  </article>`;
}

function renderMatrixHtml(title, matrix) {
  const rows = Object.keys(matrix || {}).sort();
  if (!rows.length) {
    return `<section class="matrix-block"><h4>${escapeHtml(title)}</h4><p class="matrix-block__empty">No data.</p></section>`;
  }
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(matrix[row] || {})))).sort();
  const allCounts = rows.flatMap((row) => columns.map((column) => matrix[row]?.[column] || 0));
  const max = Math.max(1, ...allCounts);
  const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const body = rows.map((row) => {
    const cells = columns.map((column) => {
      const count = matrix[row]?.[column] || 0;
      const diagonal = row === column;
      const intensity = count > 0 ? (count / max).toFixed(3) : '0';
      const tone = count === 0 ? 'zero' : (diagonal ? 'good' : 'bad');
      return `<td class="matrix-cell matrix-cell--${tone}" style="--heat:${intensity}" title="${escapeHtml(`${row} -> ${column}: ${count}`)}">${count}</td>`;
    }).join('');
    return `<tr><th>${escapeHtml(row)}</th>${cells}</tr>`;
  }).join('');
  return `<section class="matrix-block">
    <h4>${escapeHtml(title)}</h4>
    <div class="matrix-scroll">
      <table class="matrix-table">
        <thead><tr><th>Expected \\ Actual</th>${header}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`;
}

function renderFailureList(failures) {
  if (!failures?.length) return '';
  return `<section class="failure-block">
    <h4>Sample Failures</h4>
    <div class="failure-list">
      ${failures.map((failure) => `<article class="failure-item">
        <div class="failure-item__id"><code>${escapeHtml(failure.id)}</code></div>
        <div class="failure-item__body">
          <div><strong>Expected:</strong> <code>${escapeHtml(JSON.stringify(failure.expected))}</code></div>
          <div><strong>Actual:</strong> <code>${escapeHtml(JSON.stringify(failure.actual))}</code></div>
        </div>
      </article>`).join('')}
    </div>
  </section>`;
}

function renderFamilyTableHtml(suiteReport) {
  const rows = Object.keys(suiteReport.families).sort().map((familyName) => {
    const family = suiteReport.families[familyName];
    const summaryTone = family.failed > 0 ? 'bad' : 'good';
    return `<tr>
      <td data-sort-value="${escapeHtml(familyName)}"><span class="family-name family-name--${summaryTone}">${escapeHtml(familyName)}</span></td>
      <td data-sort-value="${family.total}">${family.total}</td>
      <td data-sort-value="${family.passed}">${family.passed}</td>
      <td data-sort-value="${family.exactAccuracy}">${escapeHtml(percent(family.exactAccuracy))}</td>
      <td data-sort-value="${family.precision}">${escapeHtml(percent(family.precision))}</td>
      <td data-sort-value="${family.recall}">${escapeHtml(percent(family.recall))}</td>
      <td data-sort-value="${family.abstainRate}">${escapeHtml(percent(family.abstainRate))}</td>
      <td data-sort-value="${family.ambiguityRate}">${escapeHtml(percent(family.ambiguityRate))}</td>
      <td data-sort-value="${family.meanLatencyMs}">${escapeHtml(formatMs(family.meanLatencyMs))}</td>
      <td data-sort-value="${family.p95LatencyMs}">${escapeHtml(formatMs(family.p95LatencyMs))}</td>
    </tr>`;
  }).join('\n');

  return `<div class="table-shell">
    <table class="metrics-table sortable-table">
      <thead>
        <tr>
          <th data-sortable="text">Family</th>
          <th data-sortable="number">Total</th>
          <th data-sortable="number">Pass</th>
          <th data-sortable="number">Accuracy</th>
          <th data-sortable="number">Precision</th>
          <th data-sortable="number">Recall</th>
          <th data-sortable="number">Abstain</th>
          <th data-sortable="number">Ambiguous</th>
          <th data-sortable="number">Mean</th>
          <th data-sortable="number">P95</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderFamilyPanels(suiteReport) {
  return Object.keys(suiteReport.families).sort().map((familyName) => {
    const family = suiteReport.families[familyName];
    const chips = [
      renderMetricChip('Accuracy', percent(family.exactAccuracy), metricTone(family.exactAccuracy, 'quality')),
      renderMetricChip('Precision', percent(family.precision), metricTone(family.precision, 'quality')),
      renderMetricChip('Recall', percent(family.recall), metricTone(family.recall, 'quality')),
      renderMetricChip('Abstain', percent(family.abstainRate), metricTone(family.abstainRate, 'secondary')),
      renderMetricChip('Ambiguous', percent(family.ambiguityRate), metricTone(family.ambiguityRate, 'secondary')),
      renderMetricChip('P95', formatMs(family.p95LatencyMs), metricTone(family.p95LatencyMs, 'latency')),
    ].join('');

    const confusionBlocks = [
      renderMatrixHtml('Status Confusion', family.statusConfusion),
    ];
    if (family.family === 'conference_resolution') {
      confusionBlocks.push(renderMatrixHtml('Conference Rank Confusion', family.conferenceRankConfusion));
    }
    if (family.family === 'journal_resolution') {
      confusionBlocks.push(renderMatrixHtml('Journal Quartile Confusion', family.journalQuartileConfusion));
    }

    return `<details class="family-panel"${family.failed > 0 ? ' open' : ''}>
      <summary class="family-panel__summary">
        <div>
          <div class="family-panel__title">${escapeHtml(familyName)}</div>
          <div class="family-panel__meta">${family.total} fixtures, ${family.failed} failures</div>
        </div>
        <div class="family-panel__chips">${chips}</div>
      </summary>
      <div class="family-panel__body">
        <div class="matrix-grid">${confusionBlocks.join('')}</div>
        ${renderFailureList(family.sampleFailures)}
      </div>
    </details>`;
  }).join('\n');
}

function renderHtmlReport(report, issues, artifactPaths) {
  const overviewCards = Object.entries(report.suites).map(([suiteName, suiteReport]) => {
    const overall = suiteReport.overall;
    return renderOverviewCard(
      suiteName,
      `${overall.total} fixtures across ${Object.keys(suiteReport.families).length} families`,
      [
        renderMetricChip('Accuracy', percent(overall.exactAccuracy), metricTone(overall.exactAccuracy, 'quality')),
        renderMetricChip('Precision', percent(overall.precision), metricTone(overall.precision, 'quality')),
        renderMetricChip('Recall', percent(overall.recall), metricTone(overall.recall, 'quality')),
        renderMetricChip('P95', formatMs(overall.p95LatencyMs), metricTone(overall.p95LatencyMs, 'latency')),
      ]
    );
  }).join('\n');

  const suiteSections = Object.entries(report.suites).map(([suiteName, suiteReport]) => {
    const overall = suiteReport.overall;
    return `
    <section class="suite">
      <div class="suite__header">
        <div>
          <div class="eyebrow">Suite</div>
          <h2>${escapeHtml(suiteName)}</h2>
          <p>${overall.total} fixtures, ${Object.keys(suiteReport.families).length} measured families, ${overall.failed} failures.</p>
        </div>
        <div class="suite__chips">
          ${renderMetricChip('Accuracy', percent(overall.exactAccuracy), metricTone(overall.exactAccuracy, 'quality'))}
          ${renderMetricChip('Precision', percent(overall.precision), metricTone(overall.precision, 'quality'))}
          ${renderMetricChip('Recall', percent(overall.recall), metricTone(overall.recall, 'quality'))}
          ${renderMetricChip('P95', formatMs(overall.p95LatencyMs), metricTone(overall.p95LatencyMs, 'latency'))}
        </div>
      </div>
      ${renderFamilyTableHtml(suiteReport)}
      <div class="family-panels">
        ${renderFamilyPanels(suiteReport)}
      </div>
    </section>`;
  }).join('\n');

  const issuesHtml = issues.length
    ? `<section class="alert-section alert-section--bad"><h2>Gating Issues</h2><ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></section>`
    : '';
  const regressionsHtml = report.topRegressions?.length
    ? `<section class="alert-section"><h2>Top Regressions</h2><div class="regression-grid">${report.topRegressions.slice(0, 20).map((entry) => `<div class="regression-chip"><code>${escapeHtml(`${entry.suite}/${entry.family}/${entry.id}`)}</code></div>`).join('')}</div></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Accuracy Benchmark Report</title>
  <style>
    :root {
      --bg: #f4f7fc;
      --panel: #ffffff;
      --panel-2: #f7faff;
      --ink: #13284b;
      --muted: #5d7094;
      --line: #d9e4f7;
      --line-strong: #b6c8ea;
      --blue: #2459d3;
      --blue-soft: #e8f0ff;
      --green: #1d8f57;
      --green-soft: #e6f7ef;
      --amber: #b97807;
      --amber-soft: #fff4d7;
      --red: #c24646;
      --red-soft: #ffe5e5;
      --shadow: 0 20px 55px rgba(17, 40, 86, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px;
      font-family: "Segoe UI Variable Text", "Aptos", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(36, 89, 211, 0.12), transparent 30%),
        radial-gradient(circle at top right, rgba(29, 143, 87, 0.08), transparent 24%),
        var(--bg);
    }
    h1, h2, h3, h4, p { margin: 0; }
    .page {
      max-width: 1440px;
      margin: 0 auto;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 0.9fr);
      gap: 20px;
      align-items: stretch;
    }
    .hero-panel,
    .meta-panel,
    .overview-card,
    .suite,
    .alert-section {
      background: rgba(255,255,255,0.88);
      backdrop-filter: blur(10px);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
    }
    .hero-panel {
      padding: 28px;
      background:
        linear-gradient(135deg, rgba(36, 89, 211, 0.07), rgba(255,255,255,0.92) 38%),
        var(--panel);
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--blue);
      font-weight: 700;
      margin-bottom: 12px;
    }
    .hero-panel h1 {
      font-size: clamp(32px, 5vw, 54px);
      line-height: 0.96;
      letter-spacing: -0.03em;
      margin-bottom: 14px;
    }
    .hero-panel p {
      color: var(--muted);
      font-size: 16px;
      line-height: 1.7;
      max-width: 56ch;
    }
    .hero-kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 22px;
    }
    .meta-panel {
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 20px;
    }
    .meta-list {
      display: grid;
      gap: 10px;
      color: var(--muted);
      font-size: 14px;
    }
    .meta-list strong {
      color: var(--ink);
      display: inline-block;
      min-width: 78px;
    }
    .meta-links {
      display: grid;
      gap: 10px;
    }
    .meta-link {
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--ink);
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-top: 22px;
    }
    .overview-card {
      padding: 22px;
    }
    .overview-card__header p {
      color: var(--muted);
      margin-top: 8px;
      font-size: 14px;
    }
    .overview-card__metrics,
    .suite__chips,
    .family-panel__chips {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .metric-chip {
      border-radius: 999px;
      padding: 9px 12px;
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
      border: 1px solid transparent;
      font-size: 13px;
      font-weight: 600;
    }
    .metric-chip__label { color: var(--muted); }
    .metric-chip__value { font-size: 15px; }
    .metric-chip--good { background: var(--green-soft); border-color: rgba(29, 143, 87, 0.18); color: var(--green); }
    .metric-chip--warn { background: var(--amber-soft); border-color: rgba(185, 120, 7, 0.18); color: var(--amber); }
    .metric-chip--bad { background: var(--red-soft); border-color: rgba(194, 70, 70, 0.16); color: var(--red); }
    .metric-chip--neutral { background: var(--blue-soft); border-color: rgba(36, 89, 211, 0.16); color: var(--blue); }
    .alert-section,
    .suite {
      margin-top: 22px;
      padding: 22px;
    }
    .alert-section h2,
    .suite h2 {
      font-size: 24px;
      letter-spacing: -0.02em;
      margin-bottom: 10px;
    }
    .alert-section--bad {
      background: linear-gradient(135deg, rgba(194, 70, 70, 0.08), rgba(255,255,255,0.96));
      border-color: rgba(194, 70, 70, 0.18);
    }
    .regression-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }
    .regression-chip {
      padding: 10px 12px;
      border-radius: 999px;
      background: var(--panel-2);
      border: 1px solid var(--line);
    }
    .suite__header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 16px;
    }
    .suite__header p {
      color: var(--muted);
      margin-top: 8px;
      line-height: 1.6;
    }
    .table-shell {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--panel-2);
    }
    .metrics-table,
    .matrix-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 820px;
    }
    .metrics-table th,
    .metrics-table td,
    .matrix-table th,
    .matrix-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      font-size: 14px;
      white-space: nowrap;
    }
    .metrics-table th,
    .matrix-table th {
      background: rgba(229, 238, 255, 0.85);
      color: #37568d;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
      user-select: none;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .metrics-table tbody tr:hover {
      background: rgba(36, 89, 211, 0.035);
    }
    .family-name {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
    }
    .family-name::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 0 5px rgba(29, 143, 87, 0.12);
    }
    .family-name--bad::before { background: var(--red); box-shadow: 0 0 0 5px rgba(194, 70, 70, 0.14); }
    .family-panels {
      display: grid;
      gap: 14px;
      margin-top: 18px;
    }
    .family-panel {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--panel);
      overflow: hidden;
    }
    .family-panel[open] {
      border-color: var(--line-strong);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
    }
    .family-panel__summary {
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding: 18px 18px 16px;
      cursor: pointer;
    }
    .family-panel__summary::-webkit-details-marker { display: none; }
    .family-panel__title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .family-panel__meta {
      color: var(--muted);
      margin-top: 4px;
      font-size: 13px;
    }
    .family-panel__body {
      padding: 0 18px 18px;
      border-top: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(247, 250, 255, 0.7), rgba(255,255,255,0.96));
    }
    .matrix-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .matrix-block {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: white;
      padding: 14px;
    }
    .matrix-block h4,
    .failure-block h4 {
      margin-bottom: 12px;
      font-size: 15px;
      letter-spacing: -0.01em;
    }
    .matrix-scroll {
      overflow: auto;
    }
    .matrix-table {
      min-width: 420px;
    }
    .matrix-table th:first-child {
      position: sticky;
      left: 0;
      z-index: 2;
    }
    .matrix-table tbody th {
      position: sticky;
      left: 0;
      z-index: 1;
      background: #f7faff;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
      font-size: 13px;
    }
    .matrix-cell {
      text-align: center !important;
      font-weight: 700;
      border-radius: 10px;
      background: rgba(211, 222, 241, 0.35);
      box-shadow: inset 0 0 0 1px rgba(182, 200, 234, 0.35);
    }
    .matrix-cell--good {
      background: rgba(29, 143, 87, calc(0.08 + var(--heat) * 0.55));
      color: #0f673e;
    }
    .matrix-cell--bad {
      background: rgba(194, 70, 70, calc(0.06 + var(--heat) * 0.48));
      color: #8e2c2c;
    }
    .matrix-cell--zero {
      color: #8ba0c8;
      font-weight: 600;
    }
    .matrix-block__empty {
      color: var(--muted);
      font-size: 14px;
    }
    .failure-block {
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: white;
    }
    .failure-list {
      display: grid;
      gap: 12px;
    }
    .failure-item {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: var(--panel-2);
    }
    .failure-item__id {
      margin-bottom: 8px;
      font-weight: 700;
    }
    .failure-item__body {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    code {
      font-family: "Cascadia Code", "Consolas", monospace;
      background: rgba(233, 241, 255, 0.95);
      padding: 2px 6px;
      border-radius: 8px;
      color: #204887;
    }
    @media (max-width: 980px) {
      body { padding: 18px; }
      .hero { grid-template-columns: 1fr; }
      .hero-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .suite__header,
      .family-panel__summary { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-panel">
        <div class="eyebrow">Benchmark Dashboard</div>
        <h1>Accuracy Benchmark Report</h1>
        <p>This artifact tracks ranking correctness, abstention behavior, and lookup latency across the offline DBLP, CORE, and SJR pipeline.</p>
        <div class="hero-kpis">
          ${renderMetricChip('Fixtures', String(report.fixtureCount), metricTone(report.fixtureCount, 'count'))}
          ${renderMetricChip('Suites', String(Object.keys(report.suites).length), metricTone(0, 'count'))}
          ${renderMetricChip('Issues', String(issues.length), metricTone(issues.length, 'issues'))}
          ${renderMetricChip('Families', String(Object.values(report.suites).reduce((sum, suite) => sum + Object.keys(suite.families).length, 0)), metricTone(0, 'count'))}
        </div>
      </div>
      <aside class="meta-panel">
        <div>
          <div class="eyebrow">Run Metadata</div>
          <div class="meta-list">
            <div><strong>Generated</strong> ${escapeHtml(report.generatedAt)}</div>
            <div><strong>Suite</strong> <code>${escapeHtml(report.suite)}</code></div>
            <div><strong>Family</strong> ${report.family ? `<code>${escapeHtml(report.family)}</code>` : 'all families'}</div>
            <div><strong>Fixtures</strong> ${report.fixtureCount}</div>
          </div>
        </div>
        <div>
          <div class="eyebrow">Artifacts</div>
          <div class="meta-links">
            <div class="meta-link"><strong>JSON</strong><br />${escapeHtml(artifactPaths.json)}</div>
            <div class="meta-link"><strong>Markdown</strong><br />${escapeHtml(artifactPaths.markdown)}</div>
            <div class="meta-link"><strong>HTML</strong><br />${escapeHtml(artifactPaths.html)}</div>
          </div>
        </div>
      </aside>
    </section>
    <section class="overview-grid">
      ${overviewCards}
    </section>
    ${issuesHtml}
    ${regressionsHtml}
    ${suiteSections}
  </div>
  <script>
    document.querySelectorAll('.sortable-table').forEach((table) => {
      const headers = table.querySelectorAll('thead th[data-sortable]');
      headers.forEach((header, headerIndex) => {
        header.addEventListener('click', () => {
          const tbody = table.querySelector('tbody');
          const rows = Array.from(tbody.querySelectorAll('tr'));
          const currentDir = header.getAttribute('data-sort-dir') === 'asc' ? 'asc' : 'desc';
          const nextDir = currentDir === 'asc' ? 'desc' : 'asc';
          headers.forEach((cell) => cell.removeAttribute('data-sort-dir'));
          header.setAttribute('data-sort-dir', nextDir);
          const mode = header.getAttribute('data-sortable');
          rows.sort((left, right) => {
            const leftCell = left.children[headerIndex];
            const rightCell = right.children[headerIndex];
            const leftValue = leftCell?.getAttribute('data-sort-value') ?? leftCell?.textContent ?? '';
            const rightValue = rightCell?.getAttribute('data-sort-value') ?? rightCell?.textContent ?? '';
            let comparison = 0;
            if (mode === 'number') {
              comparison = parseFloat(leftValue) - parseFloat(rightValue);
            } else {
              comparison = String(leftValue).localeCompare(String(rightValue));
            }
            return nextDir === 'asc' ? comparison : -comparison;
          });
          rows.forEach((row) => tbody.appendChild(row));
        });
      });
    });
  </script>
</body>
</html>
`;
}

function writeReportArtifacts(report, issues) {
  lib.ensureDir(lib.REPORTS_DIR);
  const baseName = buildArtifactBaseName(report);
  const jsonPath = path.join(lib.REPORTS_DIR, `${baseName}.json`);
  const markdownPath = path.join(lib.REPORTS_DIR, `${baseName}.md`);
  const htmlPath = path.join(lib.REPORTS_DIR, `${baseName}.html`);
  const latestJsonPath = path.join(lib.REPORTS_DIR, 'accuracy-latest.json');
  const latestMarkdownPath = path.join(lib.REPORTS_DIR, 'accuracy-latest.md');
  const latestHtmlPath = path.join(lib.REPORTS_DIR, 'accuracy-latest.html');
  const payload = { report, issues };
  const artifactPaths = { json: jsonPath, markdown: markdownPath, html: htmlPath };
  const markdown = renderMarkdownReport(report, issues, artifactPaths);
  const html = renderHtmlReport(report, issues, artifactPaths);

  lib.writeJson(jsonPath, payload);
  fs.writeFileSync(markdownPath, markdown, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  lib.writeJson(latestJsonPath, payload);
  fs.writeFileSync(latestMarkdownPath, markdown, 'utf8');
  fs.writeFileSync(latestHtmlPath, html, 'utf8');

  return {
    ...artifactPaths,
    latestJson: latestJsonPath,
    latestMarkdown: latestMarkdownPath,
    latestHtml: latestHtmlPath,
  };
}

function latencyRegressionThreshold(baselineLatencyMs) {
  if (!(baselineLatencyMs > 0)) return Number.POSITIVE_INFINITY;
  return baselineLatencyMs + Math.max(1, baselineLatencyMs * 0.2);
}

function getExpectedStatus(family, expected) {
  if (!expected || typeof expected !== 'object') return null;
  if (family === 'pipeline_e2e') return expected.decisionStatus || null;
  if (family === 'track_classification') return expected.label || null;
  return expected.status || null;
}

function getActualStatus(family, actual) {
  if (!actual || typeof actual !== 'object') return null;
  if (family === 'pipeline_e2e') return actual.decisionStatus || null;
  if (family === 'track_classification') return actual.label || null;
  return actual.status || null;
}

function getConferenceRankLabel(result) {
  return lib.normalizeRankForConfusion(result?.rank, lib.VALID_RANKS);
}

function getJournalQuartileLabel(result) {
  return lib.normalizeRankForConfusion(result?.quartile, lib.SJR_QUARTILES);
}

function incrementNestedCounter(target, leftKey, rightKey) {
  if (!target[leftKey]) target[leftKey] = {};
  target[leftKey][rightKey] = (target[leftKey][rightKey] || 0) + 1;
}

function createAccumulator(suiteName, familyName) {
  return {
    suite: suiteName,
    family: familyName,
    total: 0,
    passed: 0,
    latencies: [],
    tp: 0,
    fp: 0,
    fn: 0,
    abstainCount: 0,
    ambiguityCount: 0,
    statusConfusion: {},
    conferenceRankConfusion: {},
    journalQuartileConfusion: {},
    failures: [],
    falsePositives: [],
    falseNegatives: [],
    ambiguousFailures: [],
  };
}

function recordFixture(accumulator, evaluatedFixture) {
  accumulator.total += 1;
  accumulator.latencies.push(evaluatedFixture.latencyMs);
  if (evaluatedFixture.pass) accumulator.passed += 1;

  const expectedStatus = getExpectedStatus(accumulator.family, evaluatedFixture.expected);
  const actualStatus = getActualStatus(accumulator.family, evaluatedFixture.actual);
  if (expectedStatus || actualStatus) {
    incrementNestedCounter(accumulator.statusConfusion, expectedStatus || 'null', actualStatus || 'null');
  }

  if (actualStatus === lib.DECISION_STATUS.AMBIGUOUS) accumulator.ambiguityCount += 1;
  if (actualStatus === lib.DECISION_STATUS.AMBIGUOUS || actualStatus === lib.DECISION_STATUS.MISSING) {
    accumulator.abstainCount += 1;
  }

  const expectedPositive = expectedStatus === lib.DECISION_STATUS.MATCHED;
  const actualPositive = actualStatus === lib.DECISION_STATUS.MATCHED;
  if (expectedPositive && actualPositive) accumulator.tp += 1;
  else if (!expectedPositive && actualPositive) accumulator.fp += 1;
  else if (expectedPositive && !actualPositive) accumulator.fn += 1;

  if (accumulator.family === 'conference_resolution') {
    incrementNestedCounter(
      accumulator.conferenceRankConfusion,
      getConferenceRankLabel(evaluatedFixture.expected),
      getConferenceRankLabel(evaluatedFixture.actual)
    );
  } else if (accumulator.family === 'journal_resolution') {
    incrementNestedCounter(
      accumulator.journalQuartileConfusion,
      getJournalQuartileLabel(evaluatedFixture.expected),
      getJournalQuartileLabel(evaluatedFixture.actual)
    );
  }

  if (!evaluatedFixture.pass) {
    accumulator.failures.push(evaluatedFixture);
    if (!expectedPositive && actualPositive) accumulator.falsePositives.push(evaluatedFixture);
    if (expectedPositive && !actualPositive) accumulator.falseNegatives.push(evaluatedFixture);
    if (expectedStatus === lib.DECISION_STATUS.AMBIGUOUS && actualPositive) {
      accumulator.ambiguousFailures.push(evaluatedFixture);
    }
  }
}

function finalizeAccumulator(accumulator) {
  const precision = accumulator.tp + accumulator.fp > 0 ? accumulator.tp / (accumulator.tp + accumulator.fp) : 1;
  const recall = accumulator.tp + accumulator.fn > 0 ? accumulator.tp / (accumulator.tp + accumulator.fn) : 1;
  const failed = accumulator.total - accumulator.passed;
  return {
    suite: accumulator.suite,
    family: accumulator.family,
    total: accumulator.total,
    passed: accumulator.passed,
    failed,
    exactAccuracy: accumulator.total > 0 ? accumulator.passed / accumulator.total : 1,
    precision,
    recall,
    falsePositiveCount: accumulator.fp,
    falseNegativeCount: accumulator.fn,
    abstainRate: accumulator.total > 0 ? accumulator.abstainCount / accumulator.total : 0,
    ambiguityRate: accumulator.total > 0 ? accumulator.ambiguityCount / accumulator.total : 0,
    meanLatencyMs: mean(accumulator.latencies),
    p95LatencyMs: percentile(accumulator.latencies, 0.95),
    statusConfusion: accumulator.statusConfusion,
    conferenceRankConfusion: accumulator.conferenceRankConfusion,
    journalQuartileConfusion: accumulator.journalQuartileConfusion,
    sampleFailures: accumulator.failures.slice(0, 10).map((entry) => ({
      id: entry.id,
      family: entry.family,
      suite: entry.suite,
      expected: entry.expected,
      actual: entry.actual,
      latencyMs: entry.latencyMs,
    })),
    topFalsePositives: accumulator.falsePositives.slice(0, 5).map((entry) => entry.id),
    topFalseNegatives: accumulator.falseNegatives.slice(0, 5).map((entry) => entry.id),
    topAmbiguousFailures: accumulator.ambiguousFailures.slice(0, 5).map((entry) => entry.id),
  };
}

function evaluateFixtures(fixtures) {
  const bySuiteFamily = new Map();
  const bySuiteOverall = new Map();

  for (const fixture of fixtures) {
    const startedAt = process.hrtime.bigint();
    const actual = lib.evaluateFixture(fixture);
    const endedAt = process.hrtime.bigint();
    const latencyMs = Number(endedAt - startedAt) / 1e6;
    const pass = deepSubsetEqual(fixture.expected, actual);
    const evaluated = {
      id: fixture.id,
      suite: fixture.suite,
      family: fixture.family,
      tags: fixture.tags || [],
      source: fixture.source || null,
      expected: fixture.expected,
      actual,
      pass,
      latencyMs,
    };

    const key = `${fixture.suite}::${fixture.family}`;
    if (!bySuiteFamily.has(key)) {
      bySuiteFamily.set(key, createAccumulator(fixture.suite, fixture.family));
    }
    recordFixture(bySuiteFamily.get(key), evaluated);

    if (!bySuiteOverall.has(fixture.suite)) {
      bySuiteOverall.set(fixture.suite, createAccumulator(fixture.suite, 'overall'));
    }
    recordFixture(bySuiteOverall.get(fixture.suite), evaluated);
  }

  const suites = {};
  for (const accumulator of bySuiteFamily.values()) {
    const familyReport = finalizeAccumulator(accumulator);
    if (!suites[familyReport.suite]) {
      suites[familyReport.suite] = { families: {}, overall: null };
    }
    suites[familyReport.suite].families[familyReport.family] = familyReport;
  }

  for (const [suiteName, suite] of Object.entries(suites)) {
    suite.overall = finalizeAccumulator(bySuiteOverall.get(suiteName));
  }

  return suites;
}

function buildOverallReport(options, fixtures, suites) {
  const suiteNames = Object.keys(suites);
  const allFailures = suiteNames.flatMap((suiteName) =>
    Object.values(suites[suiteName].families).flatMap((family) => family.sampleFailures)
  );

  return {
    generatedAt: new Date().toISOString(),
    cwd: process.cwd(),
    suite: options.suite,
    family: options.family,
    fixtureCount: fixtures.length,
    suites,
    topRegressions: allFailures.slice(0, 20),
  };
}

function compareAgainstBaseline(report) {
  if (!lib.readJson || !path) return [];
  if (!require('fs').existsSync(lib.BASELINE_REPORT_PATH)) return ['No baseline report found.'];
  const baseline = lib.readJson(lib.BASELINE_REPORT_PATH);
  const issues = [];
  for (const [suiteName, suiteReport] of Object.entries(report.suites)) {
    const baselineSuite = baseline.suites?.[suiteName];
    if (!baselineSuite) continue;

    const currentPipeline = suiteReport.families.pipeline_e2e;
    const baselinePipeline = baselineSuite.families?.pipeline_e2e;
    if (currentPipeline && baselinePipeline) {
      if (currentPipeline.falsePositiveCount > baselinePipeline.falsePositiveCount) {
        issues.push(`Pipeline false positives regressed for ${suiteName}: ${currentPipeline.falsePositiveCount} > ${baselinePipeline.falsePositiveCount}`);
      }
      if (currentPipeline.abstainRate > baselinePipeline.abstainRate) {
        issues.push(`Pipeline abstain rate regressed for ${suiteName}: ${currentPipeline.abstainRate.toFixed(3)} > ${baselinePipeline.abstainRate.toFixed(3)}`);
      }
      const pipelineLatencyThreshold = latencyRegressionThreshold(baselinePipeline.p95LatencyMs);
      if (currentPipeline.p95LatencyMs > pipelineLatencyThreshold) {
        issues.push(`Pipeline p95 latency regressed for ${suiteName}: ${currentPipeline.p95LatencyMs.toFixed(2)}ms > ${pipelineLatencyThreshold.toFixed(2)}ms`);
      }
    }

    for (const familyName of ['conference_resolution', 'journal_resolution']) {
      const currentFamily = suiteReport.families[familyName];
      const baselineFamily = baselineSuite.families?.[familyName];
      if (!currentFamily || !baselineFamily) continue;
      const familyLatencyThreshold = latencyRegressionThreshold(baselineFamily.p95LatencyMs);
      if (currentFamily.p95LatencyMs > familyLatencyThreshold) {
        issues.push(`${familyName} p95 latency regressed for ${suiteName}: ${currentFamily.p95LatencyMs.toFixed(2)}ms > ${familyLatencyThreshold.toFixed(2)}ms`);
      }
    }
  }
  return issues.filter(Boolean);
}

function collectGoldGateFailures(report) {
  const issues = [];
  const gold = report.suites.gold;
  if (!gold) return issues;

  for (const [familyName, familyReport] of Object.entries(gold.families)) {
    if (familyReport.failed > 0) {
      issues.push(`Gold fixtures failed in ${familyName}: ${familyReport.failed}`);
    }
  }

  const pipeline = gold.families.pipeline_e2e;
  if (pipeline) {
    if (pipeline.precision < 0.97) issues.push(`Gold pipeline precision below floor: ${pipeline.precision.toFixed(3)} < 0.970`);
    if (pipeline.recall < 0.9) issues.push(`Gold pipeline recall below floor: ${pipeline.recall.toFixed(3)} < 0.900`);
  }

  const conference = gold.families.conference_resolution;
  if (conference && conference.precision < 0.98) {
    issues.push(`Gold conference precision below floor: ${conference.precision.toFixed(3)} < 0.980`);
  }

  const journal = gold.families.journal_resolution;
  if (journal && journal.precision < 0.98) {
    issues.push(`Gold journal precision below floor: ${journal.precision.toFixed(3)} < 0.980`);
  }

  return issues;
}

function printConsoleReport(report) {
  console.log(`Accuracy benchmark: suite=${report.suite}${report.family ? ` family=${report.family}` : ''}`);
  console.log(`Fixtures: ${report.fixtureCount}`);
  for (const [suiteName, suiteReport] of Object.entries(report.suites)) {
    console.log(`\n[${suiteName}]`);
    for (const familyName of Object.keys(suiteReport.families).sort()) {
      const family = suiteReport.families[familyName];
      console.log(
        `${familyName.padEnd(22)} total=${String(family.total).padStart(4)} `
        + `pass=${String(family.passed).padStart(4)} `
        + `acc=${family.exactAccuracy.toFixed(3)} `
        + `prec=${family.precision.toFixed(3)} `
        + `rec=${family.recall.toFixed(3)} `
        + `p95=${family.p95LatencyMs.toFixed(2)}ms`
      );
    }
  }

  if (report.topRegressions.length) {
    console.log('\nTop regressions:');
    for (const regression of report.topRegressions.slice(0, 10)) {
      console.log(`- ${regression.suite}/${regression.family}/${regression.id}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const fixtures = lib.loadFixtures({ suite: options.suite, family: options.family });
  if (!fixtures.length) {
    throw new Error(`No fixtures found for suite=${options.suite}${options.family ? ` family=${options.family}` : ''}`);
  }

  const suites = evaluateFixtures(fixtures);
  const report = buildOverallReport(options, fixtures, suites);

  const issues = collectGoldGateFailures(report);
  if (options.failOnRegression) {
    issues.push(...compareAgainstBaseline(report));
  }

  if (options.writeBaseline) {
    lib.writeJson(lib.BASELINE_REPORT_PATH, report);
  }

  const artifactPaths = writeReportArtifacts(report, issues);

  if (options.json) {
    console.log(JSON.stringify({ report, issues, artifactPaths }, null, 2));
  } else {
    printConsoleReport(report);
    if (issues.length) {
      console.log('\nFailures:');
      for (const issue of issues) console.log(`- ${issue}`);
    }
    console.log('\nArtifacts:');
    console.log(`- JSON: ${artifactPaths.json}`);
    console.log(`- Markdown: ${artifactPaths.markdown}`);
    console.log(`- HTML: ${artifactPaths.html}`);
    if (options.writeBaseline) {
      console.log(`\nBaseline written to ${lib.BASELINE_REPORT_PATH}`);
    }
  }

  if (issues.length) {
    process.exitCode = 1;
  }
}

main();
