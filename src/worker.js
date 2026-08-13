/**
 * Dr Bro Vibes — Creator Center backend (Cloudflare Worker)
 *
 * One Media Library (R2 + D1) shared by Personal Galleries and Creator
 * Content. Uploading a file writes exactly one media_library row; galleries
 * and creator content both reference it — nothing is ever re-uploaded.
 *
 * Routes:
 *   POST   /api/login                          { password } -> { token }
 *
 *   POST   /api/media                           multipart upload -> media row
 *   GET    /api/media                           list media library
 *
 *   GET    /api/galleries                       list personal galleries
 *   POST   /api/galleries                       create gallery
 *   GET    /api/galleries/:id                   gallery detail + ordered media
 *   PATCH  /api/galleries/:id                   rename/describe/cover/visibility
 *   DELETE /api/galleries/:id                   archive (soft) or ?hard=1
 *   POST   /api/galleries/:id/media              { media_id } add existing media
 *   DELETE /api/galleries/:id/media/:mediaId     remove from gallery
 *   PUT    /api/galleries/:id/media/reorder      { order: [mediaId,...] }
 *
 *   GET    /api/content                         list creator content (?status=)
 *   POST   /api/content                         create (draft/scheduled/published)
 *   GET    /api/content/:id                     detail incl. media + publish status
 *   PATCH  /api/content/:id                     edit title/caption/description/transcript/media
 *   POST   /api/content/:id/publish             { platforms: [...] } fan-out publish
 *   POST   /api/content/:id/retry/:platform      retry one failed platform only
 *   DELETE /api/content/:id                     archive
 *
 *   GET    /api/public/galleries                public galleries only
 *   GET    /api/public/content                  published creator content only
 *
 * Everything under /api/* except /api/login and /api/public/* requires a
 * valid session token (Authorization: Bearer <token>) minted by /api/login.
 */

// ---------- small helpers ----------

function uuid() {
  return crypto.randomUUID();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function makeSessionToken(env) {
  const payload = `admin:${Date.now() + 1000 * 60 * 60 * 24 * 7}`; // 7 day expiry
  const sig = await hmac(env.SESSION_SECRET, payload);
  return `${btoa(payload)}.${sig}`;
}

async function verifySessionToken(env, token) {
  if (!token) return false;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;
  const payload = atob(payloadB64);
  const expected = await hmac(env.SESSION_SECRET, payload);
  if (expected !== sig) return false;
  const [, expiresAt] = payload.split(":");
  return Date.now() < Number(expiresAt);
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return verifySessionToken(env, token);
}

// ---------- media library ----------

async function handleMediaUpload(request, env) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return err("No file provided.");

  const id = uuid();
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const r2Key = `media/${id}.${ext}`;
  const isVideo = file.type.startsWith("video/");

  await env.MEDIA_BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  const url = `${new URL(request.url).origin}/media/${r2Key.split("/")[1]}`;

  await env.DB.prepare(
    `INSERT INTO media_library (id, r2_key, url, media_type, original_name, file_size, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(id, r2Key, url, isVideo ? "video" : "photo", file.name, file.size)
    .run();

  const row = await env.DB.prepare(`SELECT * FROM media_library WHERE id = ?`).bind(id).first();
  return json({ media: row }, 201);
}

async function handleMediaList(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM media_library ORDER BY uploaded_at DESC`
  ).all();
  return json({ media: results });
}

async function handleMediaServe(request, env, filename) {
  const obj = await env.MEDIA_BUCKET.get(`media/${filename}`);
  if (!obj) return err("Not found.", 404);
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType || "application/octet-stream" },
  });
}

// ---------- galleries ----------

async function handleGalleryCreate(request, env) {
  const body = await request.json();
  if (!body.name || !body.name.trim()) return err("Gallery name is required.");
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO galleries (id, name, description, cover_media_id, visibility)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, body.name.trim(), body.description || null, body.cover_media_id || null, body.visibility === "public" ? "public" : "private")
    .run();
  const row = await env.DB.prepare(`SELECT * FROM galleries WHERE id = ?`).bind(id).first();
  return json({ gallery: row }, 201);
}

async function handleGalleryList(env) {
  const { results } = await env.DB.prepare(
    `SELECT g.*, COUNT(gm.media_id) as media_count
     FROM galleries g
     LEFT JOIN gallery_media gm ON gm.gallery_id = g.id
     WHERE g.archived_at IS NULL
     GROUP BY g.id
     ORDER BY g.sort_order ASC, g.created_at DESC`
  ).all();
  return json({ galleries: results });
}

async function handleGalleryDetail(env, id) {
  const gallery = await env.DB.prepare(`SELECT * FROM galleries WHERE id = ?`).bind(id).first();
  if (!gallery) return err("Gallery not found.", 404);
  const { results: media } = await env.DB.prepare(
    `SELECT m.*, gm.position
     FROM gallery_media gm
     JOIN media_library m ON m.id = gm.media_id
     WHERE gm.gallery_id = ?
     ORDER BY gm.position ASC`
  )
    .bind(id)
    .all();
  return json({ gallery, media });
}

async function handleGalleryUpdate(request, env, id) {
  const body = await request.json();
  const fields = [];
  const values = [];
  for (const key of ["name", "description", "cover_media_id", "visibility"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (!fields.length) return err("Nothing to update.");
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  await env.DB.prepare(`UPDATE galleries SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  const row = await env.DB.prepare(`SELECT * FROM galleries WHERE id = ?`).bind(id).first();
  return json({ gallery: row });
}

async function handleGalleryDelete(request, env, id) {
  const hard = new URL(request.url).searchParams.get("hard") === "1";
  if (hard) {
    await env.DB.prepare(`DELETE FROM galleries WHERE id = ?`).bind(id).run();
  } else {
    await env.DB.prepare(`UPDATE galleries SET archived_at = datetime('now') WHERE id = ?`).bind(id).run();
  }
  return json({ ok: true });
}

async function handleGalleryAddMedia(request, env, galleryId) {
  const body = await request.json();
  if (!body.media_id) return err("media_id is required.");
  const posRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM gallery_media WHERE gallery_id = ?`
  )
    .bind(galleryId)
    .first();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO gallery_media (gallery_id, media_id, position) VALUES (?, ?, ?)`
  )
    .bind(galleryId, body.media_id, posRow.next_pos)
    .run();
  return json({ ok: true }, 201);
}

async function handleGalleryRemoveMedia(env, galleryId, mediaId) {
  await env.DB.prepare(`DELETE FROM gallery_media WHERE gallery_id = ? AND media_id = ?`)
    .bind(galleryId, mediaId)
    .run();
  return json({ ok: true });
}

async function handleGalleryReorder(request, env, galleryId) {
  const body = await request.json();
  if (!Array.isArray(body.order)) return err("order must be an array of media ids.");
  const stmts = body.order.map((mediaId, i) =>
    env.DB.prepare(`UPDATE gallery_media SET position = ? WHERE gallery_id = ? AND media_id = ?`).bind(i, galleryId, mediaId)
  );
  await env.DB.batch(stmts);
  return json({ ok: true });
}

// ---------- creator content ----------

async function handleContentCreate(request, env) {
  const body = await request.json();
  if (!body.content_type || !["post", "video"].includes(body.content_type)) {
    return err("content_type must be 'post' or 'video'.");
  }
  const id = uuid();
  const status = body.status && ["draft", "scheduled", "published"].includes(body.status) ? body.status : "draft";

  await env.DB.prepare(
    `INSERT INTO creator_content (id, content_type, title, caption, description, transcript, transcript_language, status, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.content_type,
      body.title || null,
      body.caption || null,
      body.description || null,
      body.transcript || null,
      body.transcript ? body.transcript_language || "English" : null,
      status,
      body.scheduled_at || null
    )
    .run();

  const mediaIds = Array.isArray(body.media_ids) ? body.media_ids : [];
  if (mediaIds.length) {
    const stmts = mediaIds.map((mediaId, i) =>
      env.DB.prepare(`INSERT OR IGNORE INTO creator_content_media (creator_content_id, media_id, position) VALUES (?, ?, ?)`).bind(id, mediaId, i)
    );
    await env.DB.batch(stmts);
  }

  const platforms = Array.isArray(body.platforms) ? body.platforms : [];
  if (platforms.length) {
    const stmts = platforms.map((p) =>
      env.DB.prepare(`INSERT OR IGNORE INTO publish_targets (id, creator_content_id, platform, status) VALUES (?, ?, ?, 'pending')`).bind(uuid(), id, p)
    );
    await env.DB.batch(stmts);
  }

  const row = await env.DB.prepare(`SELECT * FROM creator_content WHERE id = ?`).bind(id).first();
  return json({ content: row }, 201);
}

async function handleContentList(request, env) {
  const status = new URL(request.url).searchParams.get("status");
  const query = status
    ? env.DB.prepare(`SELECT * FROM creator_content WHERE status = ? ORDER BY created_at DESC`).bind(status)
    : env.DB.prepare(`SELECT * FROM creator_content ORDER BY created_at DESC`);
  const { results } = await query.all();
  return json({ content: results });
}

async function handleContentDetail(env, id) {
  const content = await env.DB.prepare(`SELECT * FROM creator_content WHERE id = ?`).bind(id).first();
  if (!content) return err("Content not found.", 404);
  const { results: media } = await env.DB.prepare(
    `SELECT m.*, cm.position
     FROM creator_content_media cm
     JOIN media_library m ON m.id = cm.media_id
     WHERE cm.creator_content_id = ?
     ORDER BY cm.position ASC`
  )
    .bind(id)
    .all();
  const { results: targets } = await env.DB.prepare(`SELECT * FROM publish_targets WHERE creator_content_id = ?`).bind(id).all();
  return json({ content, media, publish_targets: targets });
}

async function handleContentUpdate(request, env, id) {
  const body = await request.json();
  const fields = [];
  const values = [];
  for (const key of ["title", "caption", "description", "transcript", "transcript_language", "status", "scheduled_at"]) {
    if (key in body) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (fields.length) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    await env.DB.prepare(`UPDATE creator_content SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  }
  if (Array.isArray(body.media_ids)) {
    await env.DB.prepare(`DELETE FROM creator_content_media WHERE creator_content_id = ?`).bind(id).run();
    const stmts = body.media_ids.map((mediaId, i) =>
      env.DB.prepare(`INSERT INTO creator_content_media (creator_content_id, media_id, position) VALUES (?, ?, ?)`).bind(id, mediaId, i)
    );
    if (stmts.length) await env.DB.batch(stmts);
  }
  const row = await env.DB.prepare(`SELECT * FROM creator_content WHERE id = ?`).bind(id).first();
  return json({ content: row });
}

async function handleContentDelete(env, id) {
  await env.DB.prepare(`UPDATE creator_content SET status = 'archived', updated_at = datetime('now') WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ---------- publishing (adapters) ----------
// Website always works today. Facebook/Instagram/YouTube are stubbed until
// Phase 0 credentials (Meta App Review, Google OAuth) exist — see the
// Content Publishing plan. Swap the body of each function for the real API
// call once credentials are available; nothing else in this file changes.

async function publishToWebsite(env, content) {
  return { status: "published", platform_url: null, platform_post_id: content.id };
}

async function publishToFacebook(env, content) {
  const conn = await env.DB.prepare(`SELECT * FROM platform_connections WHERE platform = 'facebook'`).first();
  if (!conn || !conn.connected) {
    return { status: "not_connected", error_message: "Facebook Page not connected yet (Phase 0 setup required)." };
  }
  // TODO: real Graph API call to /{page-id}/photos or resumable video upload.
  return { status: "not_connected", error_message: "Facebook publisher not yet implemented." };
}

async function publishToInstagram(env, content) {
  const conn = await env.DB.prepare(`SELECT * FROM platform_connections WHERE platform = 'instagram'`).first();
  if (!conn || !conn.connected) {
    return { status: "not_connected", error_message: "Instagram Business account not connected yet (Phase 0 setup required)." };
  }
  // TODO: real Graph API container + publish call.
  return { status: "not_connected", error_message: "Instagram publisher not yet implemented." };
}

async function publishToYouTube(env, content) {
  const conn = await env.DB.prepare(`SELECT * FROM platform_connections WHERE platform = 'youtube'`).first();
  if (!conn || !conn.connected) {
    return { status: "not_connected", error_message: "YouTube channel not connected yet (Phase 0 setup required)." };
  }
  // TODO: real resumable upload via YouTube Data API v3.
  return { status: "not_connected", error_message: "YouTube publisher not yet implemented." };
}

const PUBLISHERS = {
  website: publishToWebsite,
  facebook: publishToFacebook,
  instagram: publishToInstagram,
  youtube: publishToYouTube,
};

async function runPublish(env, contentId, platform) {
  const content = await env.DB.prepare(`SELECT * FROM creator_content WHERE id = ?`).bind(contentId).first();
  if (!content) return null;
  const publisher = PUBLISHERS[platform];
  if (!publisher) return null;

  await env.DB.prepare(
    `UPDATE publish_targets SET status = 'processing', updated_at = datetime('now') WHERE creator_content_id = ? AND platform = ?`
  )
    .bind(contentId, platform)
    .run();

  let result;
  try {
    result = await publisher(env, content);
  } catch (e) {
    result = { status: "failed", error_message: e.message };
  }

  await env.DB.prepare(
    `UPDATE publish_targets
     SET status = ?, platform_url = ?, platform_post_id = ?, error_message = ?,
         updated_at = datetime('now')
     WHERE creator_content_id = ? AND platform = ?`
  )
    .bind(
      result.status,
      result.platform_url || null,
      result.platform_post_id || null,
      result.error_message || null,
      contentId,
      platform
    )
    .run();

  return result;
}

async function handleContentPublish(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const platforms = Array.isArray(body.platforms) && body.platforms.length ? body.platforms : null;

  let targets;
  if (platforms) {
    for (const p of platforms) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO publish_targets (id, creator_content_id, platform, status) VALUES (?, ?, ?, 'pending')`
      )
        .bind(uuid(), id, p)
        .run();
    }
    targets = platforms;
  } else {
    const { results } = await env.DB.prepare(`SELECT platform FROM publish_targets WHERE creator_content_id = ?`).bind(id).all();
    targets = results.map((r) => r.platform);
  }

  const results = {};
  for (const platform of targets) {
    results[platform] = await runPublish(env, id, platform);
  }

  const anyPublished = Object.values(results).some((r) => r && r.status === "published");
  await env.DB.prepare(
    `UPDATE creator_content SET status = ?, published_at = COALESCE(published_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`
  )
    .bind(anyPublished ? "published" : "draft", id)
    .run();

  return json({ results });
}

async function handleContentRetry(env, id, platform) {
  const result = await runPublish(env, id, platform);
  if (!result) return err("Unknown platform or content.", 404);
  return json({ result });
}

// ---------- public (read-only, no auth) ----------

async function handlePublicGalleries(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM galleries WHERE visibility = 'public' AND archived_at IS NULL ORDER BY sort_order ASC, created_at DESC`
  ).all();
  return json({ galleries: results });
}

async function handlePublicContent(env) {
  // SELECT * includes `transcript` / `transcript_language`, so a published
  // ASL video's English transcript is already exposed here for the public
  // site to render alongside the video and for it to be searchable — no
  // separate endpoint needed. Transcripts only ever reach this table via a
  // creator explicitly saving/publishing them (see handleContentCreate /
  // handleContentUpdate); nothing here auto-generates or auto-publishes one.
  const { results } = await env.DB.prepare(
    `SELECT * FROM creator_content WHERE status = 'published' ORDER BY published_at DESC`
  ).all();

  // Attach ordered media (the actual video/photo file(s)) to each item so the
  // public site can render the ASL video itself, not just its metadata.
  const { results: mediaRows } = await env.DB.prepare(
    `SELECT cm.creator_content_id, cm.position, m.id, m.url, m.media_type, m.width, m.height, m.duration_sec
     FROM creator_content_media cm
     JOIN media_library m ON m.id = cm.media_id
     ORDER BY cm.position ASC`
  ).all();
  const mediaByContent = {};
  for (const row of mediaRows) {
    (mediaByContent[row.creator_content_id] ||= []).push({
      id: row.id, url: row.url, media_type: row.media_type,
      width: row.width, height: row.height, duration_sec: row.duration_sec,
    });
  }
  const content = results.map((row) => ({ ...row, media: mediaByContent[row.id] || [] }));
  return json({ content });
}

async function handleConnectionsList(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM platform_connections`).all();
  return json({ connections: results });
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // Serve uploaded media files (public read)
      const mediaMatch = pathname.match(/^\/media\/(.+)$/);
      if (mediaMatch && method === "GET") {
        return handleMediaServe(request, env, mediaMatch[1]);
      }

      // Public, no-auth endpoints
      if (pathname === "/api/public/galleries" && method === "GET") return handlePublicGalleries(env);
      if (pathname === "/api/public/content" && method === "GET") return handlePublicContent(env);

      // Login
      if (pathname === "/api/login" && method === "POST") {
        const body = await request.json();
        if (body.password !== env.ADMIN_PASSWORD) return err("Wrong password.", 401);
        const token = await makeSessionToken(env);
        return json({ token });
      }

      // Everything else under /api requires auth
      if (pathname.startsWith("/api/")) {
        const authed = await requireAuth(request, env);
        if (!authed) return err("Unauthorized.", 401);
      }

      if (pathname === "/api/media" && method === "POST") return handleMediaUpload(request, env);
      if (pathname === "/api/media" && method === "GET") return handleMediaList(env);

      if (pathname === "/api/connections" && method === "GET") return handleConnectionsList(env);

      if (pathname === "/api/galleries" && method === "POST") return handleGalleryCreate(request, env);
      if (pathname === "/api/galleries" && method === "GET") return handleGalleryList(env);

      let m = pathname.match(/^\/api\/galleries\/([^/]+)\/media\/reorder$/);
      if (m && method === "PUT") return handleGalleryReorder(request, env, m[1]);

      m = pathname.match(/^\/api\/galleries\/([^/]+)\/media\/([^/]+)$/);
      if (m && method === "DELETE") return handleGalleryRemoveMedia(env, m[1], m[2]);

      m = pathname.match(/^\/api\/galleries\/([^/]+)\/media$/);
      if (m && method === "POST") return handleGalleryAddMedia(request, env, m[1]);

      m = pathname.match(/^\/api\/galleries\/([^/]+)$/);
      if (m && method === "GET") return handleGalleryDetail(env, m[1]);
      if (m && method === "PATCH") return handleGalleryUpdate(request, env, m[1]);
      if (m && method === "DELETE") return handleGalleryDelete(request, env, m[1]);

      if (pathname === "/api/content" && method === "POST") return handleContentCreate(request, env);
      if (pathname === "/api/content" && method === "GET") return handleContentList(request, env);

      m = pathname.match(/^\/api\/content\/([^/]+)\/publish$/);
      if (m && method === "POST") return handleContentPublish(request, env, m[1]);

      m = pathname.match(/^\/api\/content\/([^/]+)\/retry\/([^/]+)$/);
      if (m && method === "POST") return handleContentRetry(env, m[1], m[2]);

      m = pathname.match(/^\/api\/content\/([^/]+)$/);
      if (m && method === "GET") return handleContentDetail(env, m[1]);
      if (m && method === "PATCH") return handleContentUpdate(request, env, m[1]);
      if (m && method === "DELETE") return handleContentDelete(env, m[1]);

      // Fall through to static assets (public site + dashboard shell)
      return env.ASSETS.fetch(request);
    } catch (e) {
      return err(`Server error: ${e.message}`, 500);
    }
  },
};
