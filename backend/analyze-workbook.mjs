import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';
import fs from 'fs';

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']);
const sheets = google.sheets({ version: 'v4', auth });
const id = '1_CdWvjAuc2cv20iPTrSkU64hXD-8-aJOO6gy4u6DfuE';

async function readTab(tab, range = 'A:Z') {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${tab}!${range}` });
  const values = res.data.values || [];
  if (values.length < 1) return { headers: [], rows: [] };
  const headers = values[0];
  const rows = values.slice(1)
    .filter((r) => r.some((c) => c !== undefined && c !== ''))
    .map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] ?? ''; }); return o; });
  return { headers, rows };
}

function countBy(rows, key) {
  const c = {};
  for (const r of rows) { const v = r[key] || '(trống)'; c[v] = (c[v] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

const terms = await readTab('pathology_terms');
const relations = await readTab('pathology_term_relations');
const occurrences = await readTab('pathology_term_occurrences');
const sources = await readTab('pathology_sources');

const out = {
  counts: {
    terms: terms.rows.length,
    relations: relations.rows.length,
    occurrences: occurrences.rows.length,
    sources: sources.rows.length,
  },
  terms_by_type: countBy(terms.rows, 'term_type'),
  terms_by_medical_system: countBy(terms.rows, 'medical_system'),
  terms_by_review_status: countBy(terms.rows, 'review_status'),
  terms_by_display_policy: countBy(terms.rows, 'display_policy'),
  relations_by_type: countBy(relations.rows, 'relation_type'),
  relations_by_review_status: countBy(relations.rows, 'review_status'),
  occurrences_by_review_status: countBy(occurrences.rows, 'review_status'),
  sources_list: sources.rows.map(r => ({ id: r.source_reference_id, title_zh: r.title_zh, title_vi: r.title_vi, edition: r.edition, year: r.publication_year })),
  // Completeness check trên terms
  terms_missing_hanviet: terms.rows.filter(r => !r.term_vi_hanviet).length,
  terms_missing_vi_standard: terms.rows.filter(r => !r.term_vi_standard).length,
  terms_missing_en: terms.rows.filter(r => !r.term_en).length,
  terms_missing_definition: terms.rows.filter(r => !r.definition_short_vi && !r.definition_short_zh).length,
  terms_type_disease_count: terms.rows.filter(r => r.term_type === 'DISEASE').length,
};

fs.writeFileSync('/private/tmp/claude-501/-Users-mac-hvdq-chimedis/5d1b6472-2962-4b6f-bf5e-534d0fce0e65/scratchpad/workbook-stats.json', JSON.stringify(out, null, 2));
fs.writeFileSync('/private/tmp/claude-501/-Users-mac-hvdq-chimedis/5d1b6472-2962-4b6f-bf5e-534d0fce0e65/scratchpad/workbook-terms.json', JSON.stringify(terms.rows));
fs.writeFileSync('/private/tmp/claude-501/-Users-mac-hvdq-chimedis/5d1b6472-2962-4b6f-bf5e-534d0fce0e65/scratchpad/workbook-relations.json', JSON.stringify(relations.rows));
fs.writeFileSync('/private/tmp/claude-501/-Users-mac-hvdq-chimedis/5d1b6472-2962-4b6f-bf5e-534d0fce0e65/scratchpad/workbook-occurrences.json', JSON.stringify(occurrences.rows));
fs.writeFileSync('/private/tmp/claude-501/-Users-mac-hvdq-chimedis/5d1b6472-2962-4b6f-bf5e-534d0fce0e65/scratchpad/workbook-sources.json', JSON.stringify(sources.rows));
console.log(JSON.stringify(out, null, 2));
console.log('Đã lưu đủ raw JSON ra scratchpad.');
