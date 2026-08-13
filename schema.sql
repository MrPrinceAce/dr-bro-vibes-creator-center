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
  id            TEXT PRIMARY KEY,          -- uuid
  content_type  TEXT NOT NULL CHECK (content_type IN ('post','video')),
  title         TEXT,
  caption       TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','archived')),
  scheduled_at  TEXT,                      -- when status = 'scheduled'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT
);

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
