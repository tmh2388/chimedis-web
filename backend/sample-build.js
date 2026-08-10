// Quick local build (without Google Sheets) for testing

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'public', 'data');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Sample data from HTML (first 5 terms for testing)
const SAMPLE_TERMS = [
  {
    "id": "hh001",
    "hz": "肺",
    "py": "fèi",
    "vi": "Phổi",
    "en": "lung",
    "group1": "Giải phẫu",
    "group2": "Hệ hô hấp",
    "vitri": "Phổi nằm trong lồng ngực, hai bên trung thất",
    "congnang": "Cơ quan chính của hệ hô hấp",
    "tcm": "Phế chủ khí",
    "verify": true
  },
  {
    "id": "hh002",
    "hz": "鼻",
    "py": "bí",
    "vi": "Mũi",
    "en": "nose",
    "group1": "Giải phẫu",
    "group2": "Hệ hô hấp",
    "verify": false
  },
  {
    "id": "hh003",
    "hz": "咽",
    "py": "yān",
    "vi": "Hầu",
    "en": "pharynx",
    "group1": "Giải phẫu",
    "group2": "Hệ hô hấp",
    "verify": true
  }
];

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'terms.json'),
  JSON.stringify(SAMPLE_TERMS, null, 2)
);

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'groups.json'),
  JSON.stringify({
    group1: ['Giải phẫu', 'Sinh lý', 'Bệnh lý'],
    group2: ['Hệ hô hấp']
  }, null, 2)
);

fs.writeFileSync(
  path.join(OUTPUT_DIR, 'metadata.json'),
  JSON.stringify({
    lastBuilt: new Date().toISOString(),
    totalTerms: SAMPLE_TERMS.length,
    verified: 2,
    unverified: 1,
    version: '1.0.0'
  }, null, 2)
);

console.log('✓ Sample data built successfully!');
console.log(`  Terms: ${SAMPLE_TERMS.length}`);
console.log(`  Location: ${OUTPUT_DIR}`);
