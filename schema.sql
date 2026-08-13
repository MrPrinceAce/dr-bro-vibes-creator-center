-- Dr Bro Vibes — Creator Center database schema (Cloudflare D1 / SQLite)
-- Core rule encoded here: one media_library row per uploaded file.
-- Galleries and creator_content both reference media_library rows via
-- junction tables — nothing is ever duplicated on upload.

PRAGMA foreign_keys = ON;

-- Every uploaded photo/video, stored once. The actual file bytes live in R2;
-- this table just points at them plus basic metadata.
CREATE TABLE IF NOT EXISTS media_library (
  id            TEXT PRIMARY KEY,          -- uuid
  r2_key        TEXT NOT NULL UNIQUE,      -- path inside the R2 bucket
  url           TEXT NOT NULL,             -- public/served URL
  media_type    TEXT NOT NULL CHECK (media_type IN ('photo','video')),
  original_name TEXT,
  file_size     INTEGER,
  width         INTEGER,
  height        INTEGER,
  duration_sec  REAL,                      -- videos only
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Personal Galleries. User-created, no fixed category list. Private by default.
CREATE TABLE IF NOT EXISTS galleries (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,
  description   TEXT,
  cover_media_id TEXT REFERENCES media_library(id) ON DELETE SET NULL,
  visibility    TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at   TEXT
);

-- Which media items belong to which gallery, with manual ordering.
CREATE TABLE IF NOT EXISTS gallery_media (
  gallery_id    TEXT NOT NULL REFERENCES galleries(id) ON DELETE CASCADE,
  media_id      TEXT NOT NULL REFERENCES media_library(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (gallery_id, media_id)
);

-- Creator/Influencer content. This is the "one content record" — separate
-- from galleries entirely. A creator_content row never implies anything
-- about gallery membership, and vice versa.
CREATE TABLE IF NOT EXISTS creator_content (
  id                  TEXT PRIMARY KEY,          -- uuid
  content_type        TEXT NOT NULL CHECK (content_type IN ('post','video')),
  title               TEXT,
  caption             TEXT,
  description         TEXT,
  -- ASL video support: a creator communicating in American Sign Language
  -- uploads a video and writes their own English transcript of what they
  -- signed. This is NOT auto-generated captioning from spoken audio — it is
  -- a human-authored transcript of a visual ASL message, entered by the
  -- creator themselves. transcript_language exists so a future AI transcript
  -- pass (see "Sign Language AI" note below) can tag machine-suggested drafts
  -- distinctly from creator-authored ones, and so other transcript languages
  -- can be added later without a schema change.
  transcript          TEXT,                      -- creator-written English transcript of the ASL video
  transcript_language TEXT DEFAULT 'English',     -- language of `transcript`; 'English' for now
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','archived')),
  scheduled_at  TEXT,                      -- when status = 'scheduled'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT
);

-- ---------------------------------------------------------------------------
-- ROADMAP (not built, architecture intentionally kept open for it):
-- "Sign Language AI" — future ASL <-> English capability.
--
-- Today: creators upload an ASL video and type their own English transcript
-- by hand (transcript / transcript_language above). No gesture-recognition
-- or ASL-interpretation AI runs anywhere in this system yet.
--
-- Planned, NOT implemented: (1) camera/video -> AI -> English text (real ASL
-- understanding — hand shape, movement, both hands, body position, facial
-- expressions, non-manual markers, spatial grammar, and context, not just
-- "hand gesture recognition"), offered as a drafting aid the creator must
-- review and correct before anything publishes — an AI-suggested transcript
-- must never auto-publish without human review; (2) English text -> AI ->
-- ASL avatar/video output; (3) eventually, using ASL as an input method for
-- the Creator Center's own UI instead of typing.
--
-- Nothing in this schema should be assumed to block that: `transcript` and
-- `transcript_language` are plain nullable text columns so a later
-- `transcript_source` ('creator' | 'ai_draft' | 'ai_reviewed') or a separate
-- `asl_ai_jobs` table can be added without breaking existing rows.
-- ---------------------------------------------------------------------------

-- Which media items are attached to a piece of creator content (reused from
-- media_library, never re-uploaded).
CREATE TABLE IF NOT EXISTS creator_content_media (
  creator_content_id TEXT NOT NULL REFERENCES creator_content(id) ON DELETE CASCADE,
  media_id            TEXT NOT NULL REFERENCES media_library(id) ON DELETE CASCADE,
  position             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (creator_content_id, media_id)
);

-- Per-platform publish target + status for a piece of creator content.
-- One row per platform the user selected when publishing.
CREATE TABLE IF NOT EXISTS publish_targets (
  id                  TEXT PRIMARY KEY,     -- uuid
  creator_content_id  TEXT NOT NULL REFERENCES creator_content(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL CHECK (platform IN ('website','facebook','instagram','youtube')),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (
                         status IN ('pending','not_connected','processing','published','failed')
                       ),
  platform_post_id    TEXT,
  platform_url        TEXT,
  error_message       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  requested_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (creator_content_id, platform)
);

-- Which platforms currently have valid credentials connected.
-- Populated once Phase 0 (Meta App Review / Google OAuth) is complete.
CREATE TABLE IF NOT EXISTS platform_connections (
  platform       TEXT PRIMARY KEY CHECK (platform IN ('facebook','instagram','youtube')),
  connected      INTEGER NOT NULL DEFAULT 0,  -- 0/1
  account_label  TEXT,                        -- e.g. "DrBroVibesOfficial"
  connected_at   TEXT,
  last_error     TEXT
);

INSERT OR IGNORE INTO platform_connections (platform, connected) VALUES
  ('facebook', 0), ('instagram', 0), ('youtube', 0);

CREATE INDEX IF NOT EXISTS idx_gallery_media_gallery ON gallery_media(gallery_id);
CREATE INDEX IF NOT EXISTS idx_creator_content_media_content ON creator_content_media(creator_content_id);
CREATE INDEX IF NOT EXISTS idx_publish_targets_content ON publish_targets(creator_content_id);
CREATE INDEX IF NOT EXISTS idx_creator_content_status ON creator_content(status);
CREATE INDEX IF NOT EXISTS idx_galleries_visibility ON galleries(visibility);

-- ===========================================================================
-- PARTNER & CREATOR PROGRAM (affiliates / ambassadors / creators / paid
-- partners / VIP partners). Own set of tables; nothing above this line is
-- touched. All activity/money below is meant to be populated by REAL
-- recorded activity (real clicks, real admin-recorded sales/signups) --
-- nothing here is seeded demo data.
--
-- NOTE: this codebase has no users/events/tickets/payments tables yet, so
-- referral_conversions.reference_id is a free-text pointer to "the real
-- order/ticket/membership row" for whenever that system exists here. Right
-- now conversions are recorded by the admin as real events, never fabricated.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS partners (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    email                   TEXT NOT NULL UNIQUE,
    phone                   TEXT,
    partner_type            TEXT NOT NULL DEFAULT 'affiliate'
                              CHECK (partner_type IN ('affiliate','ambassador','creator','paid_partner','vip')),
    status                  TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','active','paused','rejected','terminated')),
    level                   TEXT NOT NULL DEFAULT 'new'
                              CHECK (level IN ('new','bronze','silver','gold','elite','vip')),
    referral_code           TEXT NOT NULL UNIQUE,
    dashboard_token         TEXT NOT NULL UNIQUE,
    default_commission_pct REAL,
    social_links            TEXT,
    audience_size           INTEGER,
    location                TEXT,
    category                TEXT,
    notes                   TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at          TEXT
  );

CREATE TABLE IF NOT EXISTS partner_levels (
    level            TEXT PRIMARY KEY CHECK (level IN ('new','bronze','silver','gold','elite','vip')),
    min_revenue      REAL NOT NULL DEFAULT 0,
    min_conversions  INTEGER NOT NULL DEFAULT 0,
    commission_pct   REAL,
    perks            TEXT,
    sort_order       INTEGER NOT NULL DEFAULT 0
  );
INSERT OR IGNORE INTO partner_levels (level, min_revenue, min_conversions, commission_pct, perks, sort_order) VALUES
  ('new',    0,     0,   5,  '["Standard referral link"]', 0),
  ('bronze', 250,   5,   7,  '["Standard referral link","Access to open campaigns"]', 1),
  ('silver', 1000,  20,  10, '["Higher commission","Early campaign access"]', 2),
  ('gold',   3000,  50,  12, '["Higher commission","Early campaign access","Priority for paid campaigns"]', 3),
  ('elite',  7500,  100, 15, '["Highest standard commission","Early access","Priority paid campaigns"]', 4),
  ('vip',    15000, 200, 0,  '["Individually negotiated compensation and benefits"]', 5);

CREATE TABLE IF NOT EXISTS campaigns (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    description           TEXT,
    campaign_type         TEXT NOT NULL DEFAULT 'affiliate'
                            CHECK (campaign_type IN ('affiliate','paid_partnership','ambassador','creator_content')),
    status                TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','open','active','paused','completed','cancelled')),
    commission_type       TEXT NOT NULL DEFAULT 'percentage'
                            CHECK (commission_type IN ('percentage','fixed_per_referral','fixed_per_sale','fixed_payment','custom')),
    commission_value      REAL,
    fixed_payment_amount  REAL,
    budget                REAL,
    starts_at             TEXT,
    ends_at               TEXT,
    requirements          TEXT,
    bonus_rules           TEXT,
    eligibility           TEXT,
    target_url            TEXT NOT NULL DEFAULT '/',
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS partner_applications (
    id                      TEXT PRIMARY KEY,
    applicant_name          TEXT NOT NULL,
    applicant_email         TEXT NOT NULL,
    requested_partner_type  TEXT NOT NULL DEFAULT 'affiliate'
                              CHECK (requested_partner_type IN ('affiliate','ambassador','creator','paid_partner','vip')),
    campaign_id             TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    message                 TEXT,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    review_notes            TEXT,
    partner_id              TEXT REFERENCES partners(id) ON DELETE SET NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at             TEXT
  );

CREATE TABLE IF NOT EXISTS campaign_partners (
    campaign_id                 TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    partner_id                  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','removed')),
    commission_override_type    TEXT,
    commission_override_value   REAL,
    fixed_payment_override      REAL,
    joined_at                   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (campaign_id, partner_id)
  );

CREATE TABLE IF NOT EXISTS referral_links (
    id               TEXT PRIMARY KEY,
    partner_id       TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    campaign_id      TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    code             TEXT NOT NULL UNIQUE,
    destination_url  TEXT NOT NULL DEFAULT '/',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS referral_clicks (
    id                 TEXT PRIMARY KEY,
    referral_link_id   TEXT NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
    ip_hash            TEXT,
    user_agent         TEXT,
    referer            TEXT,
    clicked_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS referral_conversions (
    id                 TEXT PRIMARY KEY,
    referral_link_id   TEXT NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE,
    partner_id         TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    campaign_id        TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    conversion_type    TEXT NOT NULL CHECK (conversion_type IN ('signup','ticket_sale','membership','other_purchase')),
    reference_id       TEXT,
    revenue_amount     REAL NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'pending_review'
                         CHECK (status IN ('pending_review','verified','rejected','flagged')),
    flagged_reason     TEXT,
    occurred_at        TEXT NOT NULL DEFAULT (datetime('now')),
    verified_at        TEXT
  );

CREATE TABLE IF NOT EXISTS earnings (
    id             TEXT PRIMARY KEY,
    partner_id     TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    conversion_id  TEXT REFERENCES referral_conversions(id) ON DELETE SET NULL,
    earning_type   TEXT NOT NULL DEFAULT 'commission'
                     CHECK (earning_type IN ('commission','fixed_payment','bonus','adjustment')),
    amount         REAL NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','processing','paid','failed','disputed')),
    notes          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at    TEXT,
    paid_at        TEXT
  );

CREATE TABLE IF NOT EXISTS payouts (
    id              TEXT PRIMARY KEY,
    partner_id      TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    amount          REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','processing','paid','failed','disputed')),
    method          TEXT,
    reference_note  TEXT,
    requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at         TEXT
  );

CREATE TABLE IF NOT EXISTS payout_earnings (
    payout_id   TEXT NOT NULL REFERENCES payouts(id) ON DELETE CASCADE,
    earning_id  TEXT NOT NULL REFERENCES earnings(id) ON DELETE CASCADE,
    PRIMARY KEY (payout_id, earning_id)
  );

CREATE TABLE IF NOT EXISTS bonus_rules (
    id            TEXT PRIMARY KEY,
    campaign_id   TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
    metric        TEXT NOT NULL CHECK (metric IN ('referrals','sales','revenue')),
    threshold     REAL NOT NULL,
    bonus_amount  REAL NOT NULL,
    description   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS content_assignments (
    id                 TEXT PRIMARY KEY,
    campaign_id        TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    partner_id         TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    requirement_label  TEXT NOT NULL,
    content_id         TEXT REFERENCES creator_content(id) ON DELETE SET NULL,
    status             TEXT NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','submitted','approved','revision_requested','rejected','published')),
    platform           TEXT,
    due_at             TEXT,
    submitted_at       TEXT,
    published_at       TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

CREATE TABLE IF NOT EXISTS partner_notes (
    id          TEXT PRIMARY KEY,
    partner_id  TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    note        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

-- Rule/AI-flagged suspicious activity, for admin review ONLY. Nothing here
-- auto-bans a partner or withholds earnings just because a flag exists.
CREATE TABLE IF NOT EXISTS fraud_flags (
    id                      TEXT PRIMARY KEY,
    partner_id              TEXT REFERENCES partners(id) ON DELETE CASCADE,
    referral_conversion_id  TEXT REFERENCES referral_conversions(id) ON DELETE CASCADE,
    reason                  TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed_ok','reviewed_confirmed')),
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at             TEXT
  );

CREATE INDEX IF NOT EXISTS idx_referral_links_partner ON referral_links(partner_id);
CREATE INDEX IF NOT EXISTS idx_referral_clicks_link ON referral_clicks(referral_link_id);
CREATE INDEX IF NOT EXISTS idx_referral_conversions_partner ON referral_conversions(partner_id);
CREATE INDEX IF NOT EXISTS idx_referral_conversions_link ON referral_conversions(referral_link_id);
CREATE INDEX IF NOT EXISTS idx_earnings_partner ON earnings(partner_id);
CREATE INDEX IF NOT EXISTS idx_earnings_status ON earnings(status);
CREATE INDEX IF NOT EXISTS idx_payouts_partner ON payouts(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_applications_status ON partner_applications(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_content_assignments_campaign ON content_assignments(campaign_id);
CREATE INDEX IF NOT EXISTS idx_content_assignments_partner ON content_assignments(partner_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_status ON fraud_flags(status);
