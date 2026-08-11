-- Chimedis master data schema (MySQL)
--
-- Source of truth for content is the HVYD_ConsultDB Google Drive
-- (03_master_data/HVYD Herbal Core DB, Formula Core DB...) which is a
-- fully normalized, multi-table knowledge base shared across several
-- HVYD apps. Chimedis only needs a read-oriented "dictionary" view of
-- it, so this schema is a deliberately denormalized projection — one
-- row per herb with human-readable text (coded fields like taste_codes
-- "XIN|WEIKU" are resolved to Vietnamese/Chinese labels at import time)
-- rather than a 1:1 mirror of the source's 15+ normalized tables.
--
-- Re-running the import script (import-herbal-sheets.js) upserts this
-- table, so it's safe to refresh anytime the source Sheets change.
--
-- Trilingual columns: action_* comes from the source's own translated
-- ref_action_codes table (professionally structured, not machine
-- translated). indication_*/dose_text_*/caution_* and chapter_*/
-- section_* have no translation in the source and are machine-translated
-- at import time via Google Cloud Translation API — treat them as
-- "cần rà soát" (needs review), same caveat the source's own AI-translated
-- name_vi/name_en columns carry.

CREATE TABLE IF NOT EXISTS herbs (
  herb_id             VARCHAR(32) PRIMARY KEY,
  category_id         VARCHAR(16),
  chapter_zh          VARCHAR(128),
  chapter_vi          VARCHAR(128),
  chapter_en          VARCHAR(128),
  section_zh          VARCHAR(128),
  section_vi          VARCHAR(128),
  section_en          VARCHAR(128),
  name_zh             VARCHAR(64) NOT NULL,
  name_zh_traditional VARCHAR(64),
  name_vi             VARCHAR(128),
  pinyin              VARCHAR(128),
  latin_name          VARCHAR(255),
  medicinal_part      TEXT,
  source_species      TEXT,

  temperature_zh      VARCHAR(32),   -- 性: 温/寒/热...
  temperature_vi      VARCHAR(64),
  temperature_en      VARCHAR(64),
  taste_zh            VARCHAR(64),   -- 味: 辛、微苦...
  taste_vi            VARCHAR(128),
  taste_en            VARCHAR(128),
  meridian_zh         VARCHAR(128),  -- 归经: 肺、膀胱...
  meridian_vi         VARCHAR(255),
  meridian_en         VARCHAR(255),

  action_text_zh      TEXT,          -- 功能 (công năng) — from ref_action_codes, real translation
  action_text_vi      TEXT,
  action_text_en      TEXT,
  indication_text_zh  TEXT,          -- 主治 (chủ trị) — machine translated
  indication_text_vi  TEXT,
  indication_text_en  TEXT,
  dose_text_zh        TEXT,
  dose_text_vi         TEXT,
  dose_text_en         TEXT,
  dose_min_g          DECIMAL(6,2),
  dose_max_g          DECIMAL(6,2),
  caution_text_zh     TEXT,          -- 使用注意 (kiêng kỵ) — machine translated
  caution_text_vi     TEXT,
  caution_text_en     TEXT,

  is_active           BOOLEAN DEFAULT TRUE,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FULLTEXT INDEX ft_herbs_search (name_zh, name_zh_traditional, name_vi, pinyin, action_text_zh, action_text_vi, indication_text_zh, indication_text_vi)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_log (
  source_key    VARCHAR(64) PRIMARY KEY,  -- e.g. 'herbal_core_db_v2.0.0'
  domain        VARCHAR(32) NOT NULL,     -- 'herb' | 'acupoint' | 'formula' | 'anatomy'
  spreadsheet_id VARCHAR(64) NOT NULL,
  row_count     INT,
  imported_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- anatomy_terms — Giải phẫu (Anatomy) + Sinh lý (Physiology).
--
-- Unlike herbs, there is no pre-existing structured "Core DB" for this
-- domain — source is a raw Chinese-teaching course ("《实用医学汉语基础篇》",
-- Drive folder 1iLXo3SawcvvmhefxtdXNlBV_Vz7MKvUj: PPTX lessons per organ
-- system + 1 reference PDF for the muscular system) plus a small set of
-- pre-existing seed entries for the respiratory system. Content was
-- manually extracted/curated into backend/data/anatomy-raw.json, then
-- imported via import-anatomy-terms.js (machine-translating vi/en where
-- the source has none, via translate.js — same MyMemory pipeline as
-- herbs). Bệnh lý (Pathology) is NOT covered — no readable source found
-- for it yet (the full TCM textbooks in Drive returned empty content,
-- likely scanned images without an OCR text layer).
--
-- organ_system_zh is the stable filter key (raw Chinese, mirrors herbs'
-- group2 convention); organ_system_vi/en are display-only labels from
-- organ-system-translations.js (hand-verified, not machine translated —
-- same reasoning as category-translations.js for herb chapters/sections).
-- machine_translated flags rows where vi/en are NOT from the source
-- (nearly all of them, except the ~90 muscle-system entries that already
-- had human-quality Vietnamese in the reference PDF).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anatomy_terms (
  term_id            VARCHAR(32) PRIMARY KEY,   -- e.g. 'an-resp-001'
  domain             VARCHAR(16) NOT NULL,      -- 'Giải phẫu' | 'Sinh lý'
  organ_system_zh    VARCHAR(64) NOT NULL,      -- khoá lọc gốc, vd. '呼吸系统'
  organ_system_vi    VARCHAR(64),
  organ_system_en    VARCHAR(64),

  hz                 VARCHAR(64) NOT NULL,
  py                 VARCHAR(128),
  vi                 VARCHAR(128),
  en                 VARCHAR(128),

  position_zh        TEXT,          -- vị trí (vitri)
  position_vi        TEXT,
  position_en        TEXT,
  function_zh        TEXT,          -- công năng (congnang)
  function_vi        TEXT,
  function_en         TEXT,
  tcm_note_zh        TEXT,          -- ghi chú Trung Y (tcm)
  tcm_note_vi        TEXT,
  tcm_note_en        TEXT,
  clinical_zh        TEXT,          -- lâm sàng (lamsang)
  clinical_vi        TEXT,
  clinical_en        TEXT,

  source             TEXT,          -- vd. "《实用医学汉语基础篇》第四课：心血管系统"
  machine_translated BOOLEAN DEFAULT TRUE,
  verify             BOOLEAN DEFAULT TRUE,
  verify_note        TEXT,

  is_active          BOOLEAN DEFAULT TRUE,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FULLTEXT INDEX ft_anatomy_search (hz, vi, en, py, function_vi, function_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- word_elements — "Từ ghép Y Khoa" (English medical word-formation:
-- prefix/suffix/root/compound term). Unlike every other domain, the
-- headword here is the ENGLISH form (en), not Chinese — hz/zh is just a
-- one-word gloss, not a term of its own. Source: a standalone reference
-- app (med-terms.html, "本草詞根") already fully trilingual (zh/vi/en) —
-- no machine translation needed, straight import via
-- import-word-elements.js from backend/data/word-elements-raw.json.
--
-- element_type: 'prefix' | 'suffix' | 'root' | 'term' — this is what
-- dropdown 2 ("Loại") filters on for this domain, NOT organ_system
-- (prefix/suffix are ~all 'gen', not organ-specific — organ_system only
-- meaningfully varies for root/term).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS word_elements (
  element_id     VARCHAR(32) PRIMARY KEY,   -- e.g. 'we-prefix-001'
  element_type   VARCHAR(16) NOT NULL,      -- 'prefix' | 'suffix' | 'root' | 'term'
  organ_system   VARCHAR(16) NOT NULL,      -- khoá gốc từ nguồn, vd. 'cardio', 'gen'

  en             VARCHAR(128) NOT NULL,     -- từ/từ tố tiếng Anh — headword của domain này
  ipa            VARCHAR(255),
  zh             VARCHAR(64),               -- nghĩa Hán 1 từ, KHÔNG phải headword
  py             VARCHAR(128),
  vi             VARCHAR(128),              -- nghĩa Việt ngắn
  gloss          TEXT,                      -- giải thích thêm — TIẾNG VIỆT cho prefix/suffix/root,
                                             -- nhưng TIẾNG ANH cho type='term' (nguồn gốc trộn lẫn,
                                             -- xem import-word-elements.js — frontend tự xử lý theo type)
  example_en     TEXT,                      -- ví dụ (prefix/suffix/root) hoặc phân tích cấu tạo (term)
  example_zh     TEXT,
  example_vi     TEXT,

  is_active      BOOLEAN DEFAULT TRUE,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FULLTEXT INDEX ft_word_elements_search (en, zh, vi, py, gloss)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- Future domains follow the same "denormalized read view" pattern:
--   formulas   — from 03_master_data/HVYD Formula Core DB (kb_formulas,
--                kb_formula_ingredients, kb_formula_indication_claims...)
--   acupoints  — once acupoint_db is rebuilt
--   Bệnh lý (pathology) — needs a readable source first; see note above
-- ---------------------------------------------------------------------
