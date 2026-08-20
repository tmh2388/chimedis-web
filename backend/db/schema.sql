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
  machine_translated  BOOLEAN DEFAULT TRUE,  -- indication/dose/caution vi+en vẫn là dịch máy
                                              -- chưa rà soát — tắt (FALSE) qua sheet rà soát
                                              -- (xem import-mt-review-sheet.js), UI ẩn ghi chú
                                              -- "cần rà soát" khi cờ này = FALSE.

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
  example_ipa    TEXT,                      -- IPA của TRỌN VẸN từng từ ví dụ (không phải IPA của
                                             -- dạng tiền tố/hậu tố ở cột `ipa` phía trên) — tự soạn
                                             -- tay 2026-08 vì nguồn không có, xem MEMORY dự án.
                                             -- Nhiều ví dụ trong 1 mục: ngăn cách bởi ", " đúng thứ
                                             -- tự với example_en (tách bởi " / ").

  is_active      BOOLEAN DEFAULT TRUE,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FULLTEXT INDEX ft_word_elements_search (en, zh, vi, py, gloss)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- acupoints — Huyệt vị. Source: "HVYD Acupoint Core DB v1.1.2" Google Sheet
-- (26+ normalized tables: kb_acupoints, kb_acupoint_names, kb_meridians,
-- kb_acupoint_meridian_map, kb_acupoint_locations, kb_acupoint_indication_claims,
-- kb_acupoint_action_claims, ref_action_codes, kb_acupoint_class_map,
-- ref_acupoint_class_codes, ref_body_regions...). The source provides real
-- vi/zh translations for name/location/indication (translation_vi/
-- translation_zh columns) but EN is only filled for 1-3 of 404 points —
-- location_text_en/indication_text_en fall back to machine translation
-- (MyMemory) when missing, flagged via en_machine_translated. vi/zh are
-- NEVER machine translated for this domain (always real/reviewed content).
--
-- meridian_vi uses a hand-verified lookup table (MERIDIAN_VI_STANDARD in
-- the import script), not the source's own label_vi column — the source
-- orders it "[organ] thủ/túc [âm-dương]" (vd. "Tiểu trường thủ Thái dương")
-- while the standard TCM Vietnamese convention Hạ Vân Y Đạo wants is
-- "Kinh Thủ/Túc [Âm-Dương] [Organ]" with every word capitalized (vd.
-- "Kinh Thủ Thái Dương Tiểu Trường") — decision 2026-08-17.
--
-- location_text_vi/indication_text_vi have point-code references (vd.
-- "ST-35") annotated with the referenced point's Vietnamese name (vd.
-- "Độc Tỵ (ST-35)") — the source's zh text already pairs name+code this
-- way, only the vi translation had dropped the name — decision 2026-08-17.
--
-- action_text_* (tác dụng lâm sàng) is genuinely incomplete in the source
-- itself (README: "PRODUCTION_IN_PROGRESS", only ~9 claims covering the
-- Lung meridian as of 2026-08) — left NULL for points without it, by
-- design (per Hạ Vân Y Đạo's own decision), not a bug to fix here.
--
-- Import script: import-acupoint-sheets.js. Re-running upserts, safe anytime.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acupoints (
  acupoint_id        VARCHAR(16) PRIMARY KEY,   -- e.g. 'ST-36', 'EX-UE-1'
  entity_type        VARCHAR(24) NOT NULL,      -- 'REGULAR_ACUPOINT' | 'EXTRA_ACUPOINT'
  sequence_number    INT,                       -- thứ tự trong kinh, vd. ST-36 = 36
  laterality         VARCHAR(24),               -- 'BILATERAL' | 'MIDLINE' | 'MULTIPLE_SYMMETRIC'

  meridian_code      VARCHAR(8),                -- 'LU','LI','ST'... NULL nếu kỳ huyệt không thuộc kinh nào
  meridian_zh        VARCHAR(64),               -- tên đầy đủ, vd. 手太阴肺经 — khoá lọc group2 ổn định
  meridian_vi        VARCHAR(128),
  meridian_en        VARCHAR(128),

  body_region_zh     VARCHAR(64),
  body_region_vi      VARCHAR(64),
  body_region_en      VARCHAR(64),

  name_zh             VARCHAR(64) NOT NULL,
  py                  VARCHAR(128),  -- pinyin CÓ dấu thanh, tự sinh từ name_zh bằng thư viện
                                      -- `pinyin` (nguồn không có cột pinyin — cột name_en/locale
                                      -- 'en' trong kb_acupoint_names thực ra là pinyin KHÔNG dấu,
                                      -- vd. "Zusanli" — vẫn giữ nguyên ở name_en, py là bổ sung mới).
  name_vi             VARCHAR(128),
  name_en             VARCHAR(128),

  location_text_zh    TEXT,          -- vị trí — nguyên văn nguồn
  location_text_vi    TEXT,          -- vị trí — bản dịch thật từ nguồn (không phải dịch máy)
  location_text_en    TEXT,

  indication_text_zh  TEXT,          -- chủ trị — nguyên văn nguồn
  indication_text_vi  TEXT,          -- chủ trị — bản dịch thật từ nguồn
  indication_text_en  TEXT,

  action_text_zh       TEXT,          -- tác dụng lâm sàng — CHƯA ĐẦY ĐỦ, để trống với đa số huyệt (xem trên)
  action_text_vi        TEXT,
  action_text_en        TEXT,

  special_class_zh     VARCHAR(255),  -- loại huyệt đặc biệt, vd. "输穴、原穴、八会穴之脉会"
  special_class_vi     VARCHAR(255),  -- "Du huyệt, Nguyên huyệt, Bát hội huyệt (Mạch hội)"
  special_class_en     VARCHAR(255),

  en_machine_translated BOOLEAN DEFAULT FALSE, -- location_text_en/indication_text_en: nguồn không có
                                       -- sẵn EN cho gần hết 404 huyệt (chỉ 1-3 huyệt có EN thật) —
                                       -- dịch máy MyMemory bù vào khi thiếu, cờ này bật khi ít nhất 1
                                       -- trong 2 trường trên là dịch máy. vi/zh KHÔNG bao giờ dịch máy
                                       -- (đều là bản dịch/nguyên văn thật từ nguồn).

  is_active            BOOLEAN DEFAULT TRUE,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FULLTEXT INDEX ft_acupoints_search (name_zh, name_vi, name_en, indication_text_zh, indication_text_vi, indication_text_en, location_text_vi)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- Future domains follow the same "denormalized read view" pattern:
--   formulas   — from 03_master_data/HVYD Formula Core DB (kb_formulas,
--                kb_formula_ingredients, kb_formula_indication_claims...)
--   Bệnh lý (pathology) — needs a readable source first; see note above
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- users / user_favorites / user_settings — đăng nhập người dùng (Firebase Auth).
-- Firebase Auth tự quản lý password/social login ở phía client — server KHÔNG lưu
-- password, chỉ lưu 1 bản ghi "profile" ứng với mỗi firebase_uid để join với dữ liệu
-- riêng của user (favorites, settings đồng bộ đa thiết bị). Xem backend/firebase-admin.js.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  firebase_uid   VARCHAR(128) NOT NULL UNIQUE,
  email          VARCHAR(255),
  display_name   VARCHAR(255),
  photo_url      TEXT,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- term_id + term_category (= group1 của term, vd. 'Dược liệu'/'Huyệt vị'...) đủ để tra
-- ngược ra term thật qua /api/terms phía frontend — không lưu trùng nội dung term ở đây.
CREATE TABLE IF NOT EXISTS user_favorites (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  term_id         VARCHAR(32) NOT NULL,
  term_category   VARCHAR(32) NOT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_term (user_id, term_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Đồng bộ đa thiết bị cho các cài đặt hiện đang chỉ lưu localStorage phía frontend
-- (state.lang, state.contentLangs, state.hanScript) — xem loadContentLangs() trong index.html.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id         INT PRIMARY KEY,
  lang            VARCHAR(8),    -- 'vi' | 'zh' | 'en'
  content_langs   VARCHAR(32),   -- vd. 'zh,vi,en' — danh sách ngôn ngữ nội dung đang bật
  han_script      VARCHAR(16),   -- 'simplified' | 'traditional'
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
