/**
 * write_atlas_assets.mjs
 *
 * One-off script: writes the 11 AI-generated (Gemini) atlas base-diagram
 * images into the `kb_atlas_assets` tab of the HVYD Acupoint Core DB Google
 * Sheet — the canonical source of truth (Drive-hosted, shared across HVYD
 * apps), not just Chimedis' own MySQL. `storage_uri` is the Drive file ID of
 * each PNG (folder `1lrHgfMAM7zIH3P_TdN4B09ITsV9gmc-A`), `sha256` computed
 * locally via `shasum -a 256`. Requires Editor access on the Core DB sheet
 * for the service account (read-only by default — grant temporarily if
 * re-running for a future batch of images, see [[project_chimedis_acupoint_atlas]]
 * memory for the full asset catalog and design decisions behind these images).
 *
 * Safe to re-run for the SAME 11 rows (uses append, so re-running duplicates
 * rows — check kb_atlas_assets manually before re-running, or delete the
 * existing 11 rows first). Not part of the regular build; run manually only
 * when adding new atlas view images.
 *
 * Usage: GOOGLE_CREDENTIALS_JSON=<path> node write_atlas_assets.mjs
 */
import { google } from 'googleapis';
import { createGoogleAuth } from './google-auth.js';

const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = '1kmJYYviIcxjDVzt0KKGcmRIFDKsHvo6kiOX1Sv_3L7I';

const now = new Date().toISOString();

const headers = [
  'asset_id','asset_version','asset_type','view_type','body_model_scope',
  'license_status','storage_uri','sha256','illustrative_only','batch_id',
  'content_version','review_status','display_policy','source_passage_id',
  'row_fingerprint','created_at','updated_at','is_active',
];

const rows = [
  ['ATLAS-FOREARM-HAND-ANT','1.0.0','LINE_ART_BASE_DIAGRAM','FOREARM_HAND_ANTERIOR','UPPER_LIMB','AI_GENERATED_ORIGINAL_HVYD','14J-9ipk8OU9FRv9bNRBV5s_GLWOGAHtR','c72948391ae1ec5583b85a58dff9cc2326ce99fbad745364557182cd4561ec98',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-FOREARM-HAND-POST','1.0.0','LINE_ART_BASE_DIAGRAM','FOREARM_HAND_POSTERIOR','UPPER_LIMB','AI_GENERATED_ORIGINAL_HVYD','1wqKCxgT5z29o-olFMcx33rgOkfFwi1S8','68c85c4765bfef06c648ca164e9325bc8e135fe3434490d26dc3da4e939728e0',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-LEGS-ANT','1.0.0','LINE_ART_BASE_DIAGRAM','LEGS_ANTERIOR','LOWER_LIMB','AI_GENERATED_ORIGINAL_HVYD','1Be73uM8ljSqPwh-aTkg4BH269bvyl9d_','f5c6e8c7435d90ae01b602b01d681dbf5aac588e74cd54313c66ae97d875afe9',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-LEGS-POST','1.0.0','LINE_ART_BASE_DIAGRAM','LEGS_POSTERIOR','LOWER_LIMB','AI_GENERATED_ORIGINAL_HVYD','1GPeYbTYEWa2K4xAaLv1jvZPVtxCZ5VY0','dd9d32db5385f0f578ab058dd29b03b0f820b1834b046425a42db39ff756ab8b',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-LEG-LATERAL','1.0.0','LINE_ART_BASE_DIAGRAM','LEG_LATERAL','LOWER_LIMB','AI_GENERATED_ORIGINAL_HVYD','1TxvDI-7_aXW9J_hiuwobexYkl8JG7xnb','bd38db9d86d9a3f1802407e4d333a83b786491ab3ae36f39bd7640e4a02455fa',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-CHEST-ABDOMEN-ANT','1.0.0','LINE_ART_BASE_DIAGRAM','CHEST_ABDOMEN_ANTERIOR','TORSO','AI_GENERATED_ORIGINAL_HVYD','1B6KAJs4zN3BqcCAg1FJWBM80bDdiDjqM','446299470a8e823846818f35a579e36a638d7cfb502a3c6532227cc4091cf3c0',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-BACK-TORSO','1.0.0','LINE_ART_BASE_DIAGRAM','BACK_TORSO','TORSO','AI_GENERATED_ORIGINAL_HVYD','1CCPksY6uM9ggjKcE8v3CXF5fJ6UEmFeq','63320ee606c77d53c27458e3f049f782dbf9ba914cbfeb9705d7e987865b9d94',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-HEAD-ANT','1.0.0','LINE_ART_BASE_DIAGRAM','HEAD_ANTERIOR','HEAD','AI_GENERATED_ORIGINAL_HVYD','1nlNNbX1ggUHUgUAG0rYOcjNYSgwCk0jH','91d7bddf9155e8edb76fd7d5949056bedbffe3c6f2bc87ffcd7f2f705897a03f',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-HEAD-LATERAL','1.0.0','LINE_ART_BASE_DIAGRAM','HEAD_LATERAL','HEAD','AI_GENERATED_ORIGINAL_HVYD','1-nqYgDPmjO2X8dsPCjIeuL_tvViCyDSR','55195e482a1bf837edb028cd670445346300f0c4ecb257c02ffabd27641fbd3b',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-WHOLE-BODY-ANT','1.0.0','LINE_ART_BASE_DIAGRAM','WHOLE_BODY_ANTERIOR','WHOLE_BODY','AI_GENERATED_ORIGINAL_HVYD','1-pSVns1qbCMh1OusPszDthRO7ycLkU1_','65baba0b4afcf88fd5dc43cfe8475b8cf0ee1a700b1b435bf0ff7c50559b9f4d',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
  ['ATLAS-WHOLE-BODY-POST','1.0.0','LINE_ART_BASE_DIAGRAM','WHOLE_BODY_POSTERIOR','WHOLE_BODY','AI_GENERATED_ORIGINAL_HVYD','1nHqPSVkVqLUtgss4cSPeU6OzTQ7T7EY8','e5b291eb7304be84bbd6694e713cf65ca1c3f5d95c4e1108e87d26ec02bd6b90',true,'ATLAS001','0.1.0','SOURCE_VERIFIED','INTERNAL_QA_ONLY','','',now,now,true],
];

// Check existing rows to avoid duplicating if already has header
const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'kb_atlas_assets!A1:A2' });
const hasHeader = existing.data.values && existing.data.values.length > 0 && existing.data.values[0][0] === 'asset_id';

if (!hasHeader) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'kb_atlas_assets!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [headers] },
  });
  console.log('Header written.');
}

await sheets.spreadsheets.values.append({
  spreadsheetId,
  range: 'kb_atlas_assets!A1',
  valueInputOption: 'RAW',
  insertDataOption: 'INSERT_ROWS',
  requestBody: { values: rows },
});

console.log(`Wrote ${rows.length} rows to kb_atlas_assets.`);
