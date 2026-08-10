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
  taste_zh            VARCHAR(64),   -- 味: 辛、微苦...
  taste_vi            VARCHAR(128),
  meridian_zh         VARCHAR(128),  -- 归经: 肺、膀胱...
  meridian_vi         VARCHAR(255),

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
  domain        VARCHAR(32) NOT NULL,     -- 'herb' | 'acupoint' | 'formula' (future)
  spreadsheet_id VARCHAR(64) NOT NULL,
  row_count     INT,
  imported_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- Future domains follow the same "denormalized read view" pattern:
--   formulas   — from 03_master_data/HVYD Formula Core DB (kb_formulas,
--                kb_formula_ingredients, kb_formula_indication_claims...)
--   acupoints  — once acupoint_db is rebuilt
-- ---------------------------------------------------------------------
