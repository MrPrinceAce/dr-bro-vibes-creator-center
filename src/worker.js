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
      const refMatch = pathname.match(/^\/r\/([^/]+)$/); if (refMatch && method === "GET") { return handleReferralClick(request, env, refMatch[1]); }

      // Public, no-auth endpoints
      if (pathname === "/api/public/galleries" && method === "GET") return handlePublicGalleries(env);
      if (pathname === "/api/public/content" && method === "GET") return handlePublicContent(env);
      const partnerPublicResp = await handlePublicPartnerRoutes(request, env, pathname, method); if (partnerPublicResp) return partnerPublicResp;

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
      const partnerAdminResp = await handleAdminPartnerRoutes(request, env, pathname, method); if (partnerAdminResp) return partnerAdminResp;

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


// =====================================================================
// PARTNER & CREATOR PROGRAM -- backend routes and helpers
// Real recorded activity only: referral clicks/conversions/earnings are
// written by real link visits and real admin-recorded sales/signups.
// No demo/fake data is seeded or fabricated here.
// =====================================================================

function randomCode(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function randomToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function hashIp(env, ip) {
  if (!ip) return null;
  return hmac(env.SESSION_SECRET, "ip:" + ip);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const EARNINGS_DISCLAIMER = "Earnings depend on actual performance: verified referrals, eligible sales, and the specific campaign's compensation terms. Nothing here is a guaranteed income.";

function describeCompensation(c) {
  if (c.commission_type === "percentage") return c.commission_value + "% commission per eligible sale/signup. " + EARNINGS_DISCLAIMER;
  if (c.commission_type === "fixed_per_referral") return "$" + c.commission_value + " per verified referral. " + EARNINGS_DISCLAIMER;
  if (c.commission_type === "fixed_per_sale") return "$" + c.commission_value + " per verified sale. " + EARNINGS_DISCLAIMER;
  if (c.commission_type === "fixed_payment") return "Fixed payment of $" + c.fixed_payment_amount + " for completing this partnership's requirements, subject to campaign terms. " + EARNINGS_DISCLAIMER;
  return "Custom compensation terms -- see campaign requirements for details. " + EARNINGS_DISCLAIMER;
}

async function getPartnerByToken(env, token) {
  if (!token) return null;
  return env.DB.prepare("SELECT * FROM partners WHERE dashboard_token = ?").bind(token).first();
}

function partnerTokenFromRequest(request) {
  const authHeader = request.headers.get("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "");
  if (bearer) return bearer;
  const url = new URL(request.url);
  return url.searchParams.get("token") || "";
}

async function ensureGeneralReferralLink(env, partner) {
  let link = await env.DB.prepare("SELECT * FROM referral_links WHERE partner_id = ? AND campaign_id IS NULL").bind(partner.id).first();
  if (link) return link;
  const id = uuid();
  await env.DB.prepare("INSERT INTO referral_links (id, partner_id, campaign_id, code, destination_url) VALUES (?, ?, NULL, ?, '/')").bind(id, partner.id, partner.referral_code).run();
  return env.DB.prepare("SELECT * FROM referral_links WHERE id = ?").bind(id).first();
}

async function computeCommissionAmount(env, campaign, partner, conversion) {
  let type = campaign ? campaign.commission_type : "percentage";
  let value = campaign ? campaign.commission_value : partner.default_commission_pct;
  if ((value === null || value === undefined) && partner.default_commission_pct !== null) { type = "percentage"; value = partner.default_commission_pct; }
  if (type === "fixed_payment") return round2(campaign ? campaign.fixed_payment_amount : 0);
  if (type === "fixed_per_referral" || type === "fixed_per_sale") return round2(value || 0);
  if (type === "percentage") return round2(((value || 0) / 100) * (conversion.revenue_amount || 0));
  return 0;
}

async function handleReferralClick(request, env, code) {
  const link = await env.DB.prepare("SELECT * FROM referral_links WHERE code = ?").bind(code).first();
  const origin = new URL(request.url).origin;
  if (!link) return Response.redirect(origin + "/", 302);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipHash = await hashIp(env, ip);
  await env.DB.prepare("INSERT INTO referral_clicks (id, referral_link_id, ip_hash, user_agent, referer) VALUES (?, ?, ?, ?, ?)").bind(uuid(), link.id, ipHash, request.headers.get("User-Agent") || "", request.headers.get("Referer") || "").run();
  await checkClickVelocityFraud(env, link, ipHash);
  await env.DB.prepare("UPDATE partners SET last_active_at = datetime('now') WHERE id = ?").bind(link.partner_id).run();
  const dest = link.destination_url && link.destination_url !== "/" ? link.destination_url : "/";
  const headers = new Headers();
  headers.set("Location", origin + dest);
  headers.append("Set-Cookie", "drbv_ref=" + encodeURIComponent(code) + "; Max-Age=2592000; Path=/");
  return new Response(null, { status: 302, headers });
}

async function handleEarnMoneyList(env) {
  const { results: campaigns } = await env.DB.prepare("SELECT * FROM campaigns WHERE status IN ('open','active') ORDER BY created_at DESC").all();
  const { results: levels } = await env.DB.prepare("SELECT * FROM partner_levels ORDER BY sort_order ASC").all();
  const list = campaigns.map((c) => Object.assign({}, c, { compensation_summary: describeCompensation(c) }));
  return json({ campaigns: list, partner_levels: levels, disclaimer: EARNINGS_DISCLAIMER });
}

async function handlePartnerApplicationCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.applicant_name || !body.applicant_email) return err("applicant_name and applicant_email are required.");
  const id = uuid();
  await env.DB.prepare("INSERT INTO partner_applications (id, applicant_name, applicant_email, requested_partner_type, campaign_id, message) VALUES (?, ?, ?, ?, ?, ?)").bind(id, body.applicant_name, body.applicant_email, body.requested_partner_type || "affiliate", body.campaign_id || null, body.message || null).run();
  const row = await env.DB.prepare("SELECT * FROM partner_applications WHERE id = ?").bind(id).first();
  return json({ application: row }, 201);
}

async function handlePartnerDashboard(request, env) {
  const token = partnerTokenFromRequest(request);
  const partner = await getPartnerByToken(env, token);
  if (!partner) return err("Invalid or missing partner token.", 401);
  const generalLink = await ensureGeneralReferralLink(env, partner);
  const { results: links } = await env.DB.prepare("SELECT * FROM referral_links WHERE partner_id = ?").bind(partner.id).all();
  const { results: conversions } = await env.DB.prepare("SELECT * FROM referral_conversions WHERE partner_id = ? ORDER BY occurred_at DESC").bind(partner.id).all();
  const { results: earnings } = await env.DB.prepare("SELECT * FROM earnings WHERE partner_id = ? ORDER BY created_at DESC").bind(partner.id).all();
  const { results: campaigns } = await env.DB.prepare("SELECT c.* FROM campaigns c JOIN campaign_partners cp ON cp.campaign_id = c.id WHERE cp.partner_id = ? AND cp.status = 'active'").bind(partner.id).all();
  const { results: assignments } = await env.DB.prepare("SELECT * FROM content_assignments WHERE partner_id = ? ORDER BY created_at DESC").bind(partner.id).all();
  let totalClicks = 0;
  for (const l of links) {
    const row = await env.DB.prepare("SELECT COUNT(*) as n FROM referral_clicks WHERE referral_link_id = ?").bind(l.id).first();
    totalClicks += row.n;
  }
  const totals = { pending: 0, approved: 0, processing: 0, paid: 0 };
  for (const e of earnings) { if (totals[e.status] !== undefined) totals[e.status] += e.amount; }
  return json({
    partner: { id: partner.id, name: partner.name, email: partner.email, partner_type: partner.partner_type, status: partner.status, level: partner.level, referral_code: partner.referral_code, default_commission_pct: partner.default_commission_pct },
    general_referral_link: generalLink,
    referral_links: links,
    campaigns: campaigns,
    conversions: conversions,
    earnings: earnings,
    content_assignments: assignments,
    totals_by_status: { pending: round2(totals.pending), approved: round2(totals.approved), processing: round2(totals.processing), paid: round2(totals.paid) },
    total_clicks: totalClicks,
    disclaimer: EARNINGS_DISCLAIMER,
  });
}

async function handlePartnerReferralLinkCreate(request, env) {
  const token = partnerTokenFromRequest(request);
  const partner = await getPartnerByToken(env, token);
  if (!partner) return err("Invalid or missing partner token.", 401);
  const body = await request.json().catch(() => ({}));
  if (!body.campaign_id) return err("campaign_id is required.");
  const membership = await env.DB.prepare("SELECT * FROM campaign_partners WHERE campaign_id = ? AND partner_id = ? AND status = 'active'").bind(body.campaign_id, partner.id).first();
  if (!membership) return err("You are not an active partner on this campaign.", 403);
  let link = await env.DB.prepare("SELECT * FROM referral_links WHERE partner_id = ? AND campaign_id = ?").bind(partner.id, body.campaign_id).first();
  if (link) return json({ referral_link: link });
  const id = uuid();
  const code = partner.referral_code + "-" + randomCode(4);
  await env.DB.prepare("INSERT INTO referral_links (id, partner_id, campaign_id, code, destination_url) VALUES (?, ?, ?, ?, ?)").bind(id, partner.id, body.campaign_id, code, body.destination_url || "/").run();
  link = await env.DB.prepare("SELECT * FROM referral_links WHERE id = ?").bind(id).first();
  return json({ referral_link: link }, 201);
}

async function handlePartnerContentAssignmentSubmit(request, env, id) {
  const token = partnerTokenFromRequest(request);
  const partner = await getPartnerByToken(env, token);
  if (!partner) return err("Invalid or missing partner token.", 401);
  const assignment = await env.DB.prepare("SELECT * FROM content_assignments WHERE id = ? AND partner_id = ?").bind(id, partner.id).first();
  if (!assignment) return err("Assignment not found.", 404);
  const body = await request.json().catch(() => ({}));
  await env.DB.prepare("UPDATE content_assignments SET status = 'submitted', content_id = ?, submitted_at = datetime('now') WHERE id = ?").bind(body.content_id || null, id).run();
  const row = await env.DB.prepare("SELECT * FROM content_assignments WHERE id = ?").bind(id).first();
  return json({ assignment: row });
}


// ---------- Creator/Influencer Recommendation System: schema setup ----------

async function handleSetupRecommendationSchema(env) {
  const statements = [
    "ALTER TABLE partners ADD COLUMN bio TEXT",
    "ALTER TABLE partners ADD COLUMN languages TEXT",
    "ALTER TABLE partners ADD COLUMN availability TEXT",
    "ALTER TABLE partners ADD COLUMN rate_min REAL",
    "ALTER TABLE partners ADD COLUMN rate_max REAL",
    "ALTER TABLE partners ADD COLUMN account_verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE partners ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE partners ADD COLUMN creator_verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE partners ADD COLUMN verification_updated_at TEXT",
    "CREATE TABLE IF NOT EXISTS content_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    "CREATE TABLE IF NOT EXISTS partner_categories (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, category_id TEXT NOT NULL REFERENCES content_categories(id) ON DELETE CASCADE, UNIQUE(partner_id, category_id))",
    "CREATE TABLE IF NOT EXISTS partner_platforms (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, platform TEXT NOT NULL CHECK (platform IN ('instagram','facebook','youtube','tiktok','other')), handle_or_url TEXT, follower_count INTEGER, engagement_rate REAL, updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(partner_id, platform))",
    "ALTER TABLE campaigns ADD COLUMN required_categories TEXT",
    "ALTER TABLE campaigns ADD COLUMN required_platforms TEXT",
    "ALTER TABLE campaigns ADD COLUMN required_location TEXT",
    "ALTER TABLE campaigns ADD COLUMN required_language TEXT",
    "ALTER TABLE campaigns ADD COLUMN deliverables TEXT",
    "CREATE TABLE IF NOT EXISTS opportunity_applications (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','reviewing','accepted','declined','withdrawn')), message TEXT, applied_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT, UNIQUE(campaign_id, partner_id))",
    "CREATE TABLE IF NOT EXISTS creator_connections (id TEXT PRIMARY KEY, partner_a_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, partner_b_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, requested_by TEXT NOT NULL REFERENCES partners(id), met_city TEXT, met_country TEXT, met_date TEXT, status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','accepted','declined')), notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT)",
    "CREATE TABLE IF NOT EXISTS verification_codes (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, code TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), used_at TEXT, used_by_partner_id TEXT REFERENCES partners(id))",
    "ALTER TABLE content_assignments ADD COLUMN disclosure_type TEXT",
    "ALTER TABLE content_assignments ADD COLUMN disclosure_confirmed_at TEXT",
    "CREATE INDEX IF NOT EXISTS idx_partner_categories_partner ON partner_categories(partner_id)",
    "CREATE INDEX IF NOT EXISTS idx_partner_categories_category ON partner_categories(category_id)",
    "CREATE INDEX IF NOT EXISTS idx_partner_platforms_partner ON partner_platforms(partner_id)",
    "CREATE INDEX IF NOT EXISTS idx_opportunity_applications_campaign ON opportunity_applications(campaign_id)",
    "CREATE INDEX IF NOT EXISTS idx_opportunity_applications_partner ON opportunity_applications(partner_id)",
    "CREATE INDEX IF NOT EXISTS idx_creator_connections_a ON creator_connections(partner_a_id)",
    "CREATE INDEX IF NOT EXISTS idx_creator_connections_b ON creator_connections(partner_b_id)",
    "CREATE INDEX IF NOT EXISTS idx_verification_codes_partner ON verification_codes(partner_id)",
    "CREATE INDEX IF NOT EXISTS idx_verification_codes_code ON verification_codes(code)",
    "INSERT OR IGNORE INTO content_categories (id, name, sort_order) VALUES ('cat-travel','Travel',1),('cat-lifestyle','Lifestyle',2),('cat-fashion','Fashion',3),('cat-fitness','Fitness',4),('cat-food','Food',5),('cat-entertainment','Entertainment',6),('cat-photography','Photography',7),('cat-video','Video',8),('cat-technology','Technology',9),('cat-other','Other',10)"
  ];
  const results = [];
  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
      results.push({ ok: true, statement: sql.slice(0, 70) });
    } catch (e) {
      results.push({ ok: false, statement: sql.slice(0, 70), error: String((e && e.message) || e) });
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  return json({ ok: failed === 0, total: results.length, failed, results });
}

// ---------- Creator/Influencer Recommendation Engine ----------
// Transparent, rule-based scoring. Weights are defined once here so an
// admin settings screen can change them later without touching the engine.
// If a factor's underlying data is missing, it is EXCLUDED from scoring
// (not penalized to zero) and the score is renormalized across the
// factors that *do* have data -- this keeps new creators with little or
// no history from being unfairly buried at the bottom.

const RECOMMENDATION_WEIGHTS = {
  category: 30,
  audience: 25,
  performance: 20,
  platform: 10,
  location_language: 10,
  availability: 5,
};

function safeJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

async function getPartnerCategoryNames(env, partnerId) {
  const res = await env.DB.prepare(
    "SELECT cc.name AS name FROM partner_categories pc JOIN content_categories cc ON cc.id = pc.category_id WHERE pc.partner_id = ?"
  ).bind(partnerId).all();
  return (res.results || []).map((r) => r.name);
}

async function getPartnerPlatformRows(env, partnerId) {
  const res = await env.DB.prepare("SELECT * FROM partner_platforms WHERE partner_id = ?").bind(partnerId).all();
  return res.results || [];
}

async function computeCreatorCampaignMatch(env, partner, campaign) {
  const factors = [];

  const requiredCategories = safeJsonArray(campaign.required_categories).map((c) => String(c).toLowerCase());
  const partnerCategoryNames = (await getPartnerCategoryNames(env, partner.id)).map((c) => c.toLowerCase());
  if (partner.category) partnerCategoryNames.push(String(partner.category).toLowerCase());
  if (requiredCategories.length === 0) {
    factors.push({ key: "category", label: "Category match", weight: RECOMMENDATION_WEIGHTS.category, applicable: false, reason: "Opportunity did not specify required categories." });
  } else if (partnerCategoryNames.length === 0) {
    factors.push({ key: "category", label: "Category match", weight: RECOMMENDATION_WEIGHTS.category, applicable: false, reason: "Not enough data -- creator has not selected any content categories yet." });
  } else {
    const overlap = requiredCategories.filter((c) => partnerCategoryNames.includes(c));
    const earned = requiredCategories.length ? (overlap.length / requiredCategories.length) * RECOMMENDATION_WEIGHTS.category : 0;
    factors.push({ key: "category", label: "Category match", weight: RECOMMENDATION_WEIGHTS.category, applicable: true, earned, matched: overlap, detail: overlap.length ? ("Matches: " + overlap.join(", ")) : "No overlapping categories." });
  }

  if (!partner.audience_size) {
    factors.push({ key: "audience", label: "Audience match", weight: RECOMMENDATION_WEIGHTS.audience, applicable: false, reason: "Not enough data -- no audience size on file for this creator." });
  } else {
    const size = Number(partner.audience_size) || 0;
    const scale = Math.min(1, size / 10000);
    const earned = scale * RECOMMENDATION_WEIGHTS.audience;
    factors.push({ key: "audience", label: "Audience match", weight: RECOMMENDATION_WEIGHTS.audience, applicable: true, earned, detail: size.toLocaleString() + " recorded audience size (proxy only -- detailed audience demographics are not collected)." });
  }

  const perf = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt, COALESCE(SUM(revenue_amount),0) AS rev FROM referral_conversions WHERE partner_id = ? AND status = 'verified'"
  ).bind(partner.id).first();
  const verifiedCount = (perf && perf.cnt) || 0;
  if (verifiedCount === 0) {
    factors.push({ key: "performance", label: "Performance / engagement", weight: RECOMMENDATION_WEIGHTS.performance, applicable: false, reason: "Not enough historical performance data yet -- this does not count against a new creator.", newCreator: true });
  } else {
    const scale = Math.min(1, verifiedCount / 20);
    const earned = scale * RECOMMENDATION_WEIGHTS.performance;
    factors.push({ key: "performance", label: "Performance / engagement", weight: RECOMMENDATION_WEIGHTS.performance, applicable: true, earned, detail: verifiedCount + " verified conversion(s) on record." });
  }

  const requiredPlatforms = safeJsonArray(campaign.required_platforms).map((p) => String(p).toLowerCase());
  const partnerPlatformRows = await getPartnerPlatformRows(env, partner.id);
  const partnerPlatforms = partnerPlatformRows.map((p) => String(p.platform).toLowerCase());
  if (requiredPlatforms.length === 0) {
    factors.push({ key: "platform", label: "Platform match", weight: RECOMMENDATION_WEIGHTS.platform, applicable: false, reason: "Opportunity did not specify required platforms." });
  } else if (partnerPlatforms.length === 0) {
    factors.push({ key: "platform", label: "Platform match", weight: RECOMMENDATION_WEIGHTS.platform, applicable: false, reason: "Not enough data -- creator has not added any platforms yet." });
  } else {
    const overlap = requiredPlatforms.filter((p) => partnerPlatforms.includes(p));
    const earned = requiredPlatforms.length ? (overlap.length / requiredPlatforms.length) * RECOMMENDATION_WEIGHTS.platform : 0;
    factors.push({ key: "platform", label: "Platform match", weight: RECOMMENDATION_WEIGHTS.platform, applicable: true, earned, matched: overlap, detail: overlap.length ? ("Has: " + overlap.join(", ")) : "No overlapping platforms." });
  }

  const locReq = (campaign.required_location || "").toLowerCase().trim();
  const langReq = (campaign.required_language || "").toLowerCase().trim();
  const partnerLangs = safeJsonArray(partner.languages).map((l) => String(l).toLowerCase());
  if (!locReq && !langReq) {
    factors.push({ key: "location_language", label: "Location / language", weight: RECOMMENDATION_WEIGHTS.location_language, applicable: false, reason: "Opportunity did not specify location or language requirements." });
  } else {
    let subScores = [];
    if (locReq) {
      if (!partner.location) { subScores.push(0); } else { subScores.push(partner.location.toLowerCase().indexOf(locReq) !== -1 ? 1 : 0); }
    }
    if (langReq) {
      if (!partnerLangs.length) { subScores.push(0); } else { subScores.push(partnerLangs.includes(langReq) ? 1 : 0); }
    }
    const avg = subScores.length ? subScores.reduce((a, b) => a + b, 0) / subScores.length : 0;
    const earned = avg * RECOMMENDATION_WEIGHTS.location_language;
    factors.push({ key: "location_language", label: "Location / language", weight: RECOMMENDATION_WEIGHTS.location_language, applicable: true, earned, detail: "Location match: " + (locReq ? (partner.location || "not on file") : "not required") + "; Language match: " + (langReq ? (partnerLangs.join(", ") || "not on file") : "not required") });
  }

  if (!partner.availability) {
    factors.push({ key: "availability", label: "Availability", weight: RECOMMENDATION_WEIGHTS.availability, applicable: false, reason: "Not enough data -- creator has not set an availability status." });
  } else {
    const avail = String(partner.availability).toLowerCase();
    const scale = avail === "available" ? 1 : avail === "limited" ? 0.5 : 0;
    factors.push({ key: "availability", label: "Availability", weight: RECOMMENDATION_WEIGHTS.availability, applicable: true, earned: scale * RECOMMENDATION_WEIGHTS.availability, detail: "Creator-reported availability: " + partner.availability });
  }

  const applicableFactors = factors.filter((f) => f.applicable);
  const totalWeight = applicableFactors.reduce((sum, f) => sum + f.weight, 0);
  const totalEarned = applicableFactors.reduce((sum, f) => sum + f.earned, 0);
  const score = totalWeight > 0 ? Math.round((totalEarned / totalWeight) * 100) : null;

  let label = "Not enough data to score";
  if (score !== null) {
    if (score >= 75) label = "Strong match";
    else if (score >= 50) label = "Good match";
    else if (score >= 25) label = "Possible match";
    else label = "Low match";
  }

  return {
    score,
    label,
    factors,
    new_creator: factors.some((f) => f.newCreator),
    note: "Rule-based estimate for admin/partner review only. Missing data is excluded from scoring rather than penalized, so new creators remain eligible.",
  };
}

// ---------- Content categories (admin-managed) ----------

async function handleCategoriesList(env, activeOnly) {
  const sql = activeOnly ? "SELECT * FROM content_categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC" : "SELECT * FROM content_categories ORDER BY sort_order ASC, name ASC";
  const { results } = await env.DB.prepare(sql).all();
  return json({ categories: results });
}

async function handleCategoriesAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.name) return err("name is required.");
  const id = uuid();
  await env.DB.prepare("INSERT INTO content_categories (id, name, sort_order) VALUES (?, ?, ?)").bind(id, body.name, body.sort_order || 0).run();
  const row = await env.DB.prepare("SELECT * FROM content_categories WHERE id = ?").bind(id).first();
  return json({ category: row }, 201);
}

async function handleCategoriesAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const existing = await env.DB.prepare("SELECT * FROM content_categories WHERE id = ?").bind(id).first();
  if (!existing) return err("Category not found.", 404);
  const name = body.name !== undefined ? body.name : existing.name;
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
  const sortOrder = body.sort_order !== undefined ? body.sort_order : existing.sort_order;
  await env.DB.prepare("UPDATE content_categories SET name = ?, is_active = ?, sort_order = ? WHERE id = ?").bind(name, isActive, sortOrder, id).run();
  const row = await env.DB.prepare("SELECT * FROM content_categories WHERE id = ?").bind(id).first();
  return json({ category: row });
}

// ---------- Creator (partner) self-service profile ----------

async function handlePartnerProfileGet(env, partner) {
  const categories = await getPartnerCategoryNames(env, partner.id);
  const platforms = await getPartnerPlatformRows(env, partner.id);
  return json({ partner, categories, platforms });
}

async function handlePartnerProfileUpdate(request, env, partner) {
  const body = await request.json().catch(() => ({}));
  const fields = ["bio", "availability", "location", "category", "social_links", "audience_size"];
  const sets = [];
  const binds = [];
  fields.forEach((f) => {
    if (body[f] !== undefined) { sets.push(f + " = ?"); binds.push(body[f]); }
  });
  if (body.languages !== undefined) { sets.push("languages = ?"); binds.push(JSON.stringify(body.languages || [])); }
  if (body.rate_min !== undefined) { sets.push("rate_min = ?"); binds.push(body.rate_min); }
  if (body.rate_max !== undefined) { sets.push("rate_max = ?"); binds.push(body.rate_max); }
  if (sets.length === 0) return err("No recognized fields to update.");
  sets.push("updated_at = datetime('now')");
  binds.push(partner.id);
  await env.DB.prepare("UPDATE partners SET " + sets.join(", ") + " WHERE id = ?").bind(...binds).run();
  const row = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(partner.id).first();
  return json({ partner: row });
}

async function handlePartnerCategoriesSet(request, env, partner) {
  const body = await request.json().catch(() => ({}));
  const categoryIds = Array.isArray(body.category_ids) ? body.category_ids : [];
  await env.DB.prepare("DELETE FROM partner_categories WHERE partner_id = ?").bind(partner.id).run();
  for (const catId of categoryIds) {
    try {
      await env.DB.prepare("INSERT INTO partner_categories (id, partner_id, category_id) VALUES (?, ?, ?)").bind(uuid(), partner.id, catId).run();
    } catch (e) { /* skip invalid category id */ }
  }
  const categories = await getPartnerCategoryNames(env, partner.id);
  return json({ categories });
}

async function handlePartnerPlatformUpsert(request, env, partner) {
  const body = await request.json().catch(() => ({}));
  if (!body.platform) return err("platform is required.");
  const existing = await env.DB.prepare("SELECT * FROM partner_platforms WHERE partner_id = ? AND platform = ?").bind(partner.id, body.platform).first();
  if (existing) {
    await env.DB.prepare("UPDATE partner_platforms SET handle_or_url = ?, follower_count = ?, engagement_rate = ?, updated_at = datetime('now') WHERE id = ?").bind(body.handle_or_url || null, body.follower_count != null ? body.follower_count : null, body.engagement_rate != null ? body.engagement_rate : null, existing.id).run();
  } else {
    await env.DB.prepare("INSERT INTO partner_platforms (id, partner_id, platform, handle_or_url, follower_count, engagement_rate) VALUES (?, ?, ?, ?, ?, ?)").bind(uuid(), partner.id, body.platform, body.handle_or_url || null, body.follower_count != null ? body.follower_count : null, body.engagement_rate != null ? body.engagement_rate : null).run();
  }
  const platforms = await getPartnerPlatformRows(env, partner.id);
  return json({ platforms });
}

// ---------- Opportunity (campaign) requirements ----------

async function handleCampaignRequirementsUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const existing = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  if (!existing) return err("Campaign not found.", 404);
  const requiredCategories = body.required_categories !== undefined ? JSON.stringify(body.required_categories || []) : existing.required_categories;
  const requiredPlatforms = body.required_platforms !== undefined ? JSON.stringify(body.required_platforms || []) : existing.required_platforms;
  const requiredLocation = body.required_location !== undefined ? body.required_location : existing.required_location;
  const requiredLanguage = body.required_language !== undefined ? body.required_language : existing.required_language;
  const deliverables = body.deliverables !== undefined ? JSON.stringify(body.deliverables || []) : existing.deliverables;
  await env.DB.prepare("UPDATE campaigns SET required_categories = ?, required_platforms = ?, required_location = ?, required_language = ?, deliverables = ?, updated_at = datetime('now') WHERE id = ?").bind(requiredCategories, requiredPlatforms, requiredLocation, requiredLanguage, deliverables, id).run();
  const row = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  return json({ campaign: row });
}

// ---------- Two-way recommendation endpoints ----------

async function handleCampaignRecommendedCreators(env, campaignId) {
  const campaign = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(campaignId).first();
  if (!campaign) return err("Opportunity not found.", 404);
  const { results: partners } = await env.DB.prepare("SELECT * FROM partners WHERE status = 'active'").all();
  const matches = [];
  for (const p of partners) {
    const m = await computeCreatorCampaignMatch(env, p, campaign);
    matches.push({ partner_id: p.id, partner_name: p.name, level: p.level, score: m.score, label: m.label, new_creator: m.new_creator, factors: m.factors });
  }
  matches.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
  return json({ campaign_id: campaignId, campaign_name: campaign.name, matches, note: "Rule-based recommendations for admin/partner review. Not a guarantee of fit or approval." });
}

async function handlePartnerRecommendedOpportunities(env, partner) {
  const { results: campaigns } = await env.DB.prepare("SELECT * FROM campaigns WHERE status IN ('open','active')").all();
  const matches = [];
  for (const c of campaigns) {
    const m = await computeCreatorCampaignMatch(env, partner, c);
    matches.push({ campaign_id: c.id, campaign_name: c.name, campaign_type: c.campaign_type, budget: c.budget, score: m.score, label: m.label, new_creator: m.new_creator, factors: m.factors });
  }
  matches.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
  return json({ partner_id: partner.id, matches, note: "Rule-based recommendations for your review. Applying is not guaranteed acceptance." });
}

// ---------- Opportunity applications ----------

async function handleOpportunityApplicationCreate(request, env, partner, campaignId) {
  const body = await request.json().catch(() => ({}));
  const campaign = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(campaignId).first();
  if (!campaign) return err("Opportunity not found.", 404);
  const existing = await env.DB.prepare("SELECT * FROM opportunity_applications WHERE campaign_id = ? AND partner_id = ?").bind(campaignId, partner.id).first();
  if (existing) return err("You have already applied to this opportunity.", 409);
  const id = uuid();
  await env.DB.prepare("INSERT INTO opportunity_applications (id, campaign_id, partner_id, status, message) VALUES (?, ?, ?, 'applied', ?)").bind(id, campaignId, partner.id, body.message || null).run();
  const row = await env.DB.prepare("SELECT * FROM opportunity_applications WHERE id = ?").bind(id).first();
  return json({ application: row }, 201);
}

async function handlePartnerApplicationsList(env, partner) {
  const { results } = await env.DB.prepare(
    "SELECT oa.*, c.name AS campaign_name FROM opportunity_applications oa JOIN campaigns c ON c.id = oa.campaign_id WHERE oa.partner_id = ? ORDER BY oa.applied_at DESC"
  ).bind(partner.id).all();
  return json({ applications: results });
}

async function handleOpportunityApplicationsAdminList(env, campaignId) {
  const sql = campaignId
    ? "SELECT oa.*, p.name AS partner_name, c.name AS campaign_name FROM opportunity_applications oa JOIN partners p ON p.id = oa.partner_id JOIN campaigns c ON c.id = oa.campaign_id WHERE oa.campaign_id = ? ORDER BY oa.applied_at DESC"
    : "SELECT oa.*, p.name AS partner_name, c.name AS campaign_name FROM opportunity_applications oa JOIN partners p ON p.id = oa.partner_id JOIN campaigns c ON c.id = oa.campaign_id ORDER BY oa.applied_at DESC";
  const stmt = campaignId ? env.DB.prepare(sql).bind(campaignId) : env.DB.prepare(sql);
  const { results } = await stmt.all();
  return json({ applications: results });
}

async function handleOpportunityApplicationAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const app = await env.DB.prepare("SELECT * FROM opportunity_applications WHERE id = ?").bind(id).first();
  if (!app) return err("Application not found.", 404);
  const status = body.status;
  if (!["applied", "reviewing", "accepted", "declined", "withdrawn"].includes(status)) return err("Invalid status.");
  await env.DB.prepare("UPDATE opportunity_applications SET status = ?, decided_at = datetime('now') WHERE id = ?").bind(status, id).run();
  if (status === "accepted") {
    await env.DB.prepare("INSERT OR IGNORE INTO campaign_partners (campaign_id, partner_id) VALUES (?, ?)").bind(app.campaign_id, app.partner_id).run();
  }
  const row = await env.DB.prepare("SELECT * FROM opportunity_applications WHERE id = ?").bind(id).first();
  return json({ application: row });
}

// ---------- Consent-based creator verification (no facial recognition, no biometrics) ----------
// A creator generates a short-lived code and shows it (e.g. as a QR code
// rendered client-side) to someone they are meeting in person. The other
// person scans/enters the code from their OWN account to confirm they saw
// it. This only proves account presence/control -- it never captures or
// stores any photo, face, or biometric data.

function generateShortCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function handleVerificationCodeCreate(env, partner) {
  const code = generateShortCode();
  const id = uuid();
  const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  await env.DB.prepare("INSERT INTO verification_codes (id, partner_id, code, expires_at) VALUES (?, ?, ?, ?)").bind(id, partner.id, code, expiresAt).run();
  return json({
    code,
    expires_at: expiresAt,
    partner: { id: partner.id, name: partner.name, creator_verified: !!partner.creator_verified, account_verified: !!partner.account_verified },
    note: "Show this code (e.g. as a QR code) to the person you're meeting. It expires in 15 minutes and proves account presence only -- no photo or biometric data is involved.",
  });
}

async function handleVerificationCodeScan(request, env, scanningPartner) {
  const body = await request.json().catch(() => ({}));
  if (!body.code) return err("code is required.");
  const row = await env.DB.prepare("SELECT * FROM verification_codes WHERE code = ?").bind(String(body.code).toUpperCase()).first();
  if (!row) return err("Invalid code.", 404);
  if (row.used_at) return err("This code has already been used.", 409);
  if (new Date(row.expires_at).getTime() < Date.now()) return err("This code has expired.", 410);
  if (row.partner_id === scanningPartner.id) return err("You cannot scan your own verification code.");
  await env.DB.prepare("UPDATE verification_codes SET used_at = datetime('now'), used_by_partner_id = ? WHERE id = ?").bind(scanningPartner.id, row.id).run();
  const owner = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(row.partner_id).first();
  if (owner && !owner.account_verified) {
    await env.DB.prepare("UPDATE partners SET account_verified = 1, verification_updated_at = datetime('now') WHERE id = ?").bind(owner.id).run();
  }
  return json({
    verified: true,
    creator: owner ? { id: owner.id, name: owner.name, partner_type: owner.partner_type, level: owner.level, account_verified: true, creator_verified: !!(owner && owner.creator_verified) } : null,
    note: "Account presence confirmed by scan. This is not identity/biometric verification.",
  });
}

// ---------- Creator connections (meet in person -> mutual opt-in connect) ----------

async function handleConnectionCreate(request, env, partner) {
  const body = await request.json().catch(() => ({}));
  if (!body.to_partner_id) return err("to_partner_id is required.");
  if (body.to_partner_id === partner.id) return err("You cannot connect with yourself.");
  const other = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(body.to_partner_id).first();
  if (!other) return err("Creator not found.", 404);
  const id = uuid();
  await env.DB.prepare(
    "INSERT INTO creator_connections (id, partner_a_id, partner_b_id, requested_by, met_city, met_country, met_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, partner.id, other.id, partner.id, body.met_city || null, body.met_country || null, body.met_date || null, body.notes || null).run();
  const row = await env.DB.prepare("SELECT * FROM creator_connections WHERE id = ?").bind(id).first();
  return json({ connection: row }, 201);
}

async function handleCreatorConnectionsList(env, partner) {
  const { results } = await env.DB.prepare(
    "SELECT cc.*, pa.name AS partner_a_name, pb.name AS partner_b_name FROM creator_connections cc JOIN partners pa ON pa.id = cc.partner_a_id JOIN partners pb ON pb.id = cc.partner_b_id WHERE cc.partner_a_id = ? OR cc.partner_b_id = ? ORDER BY cc.created_at DESC"
  ).bind(partner.id, partner.id).all();
  return json({ connections: results });
}

async function handleConnectionRespond(request, env, partner, id) {
  const body = await request.json().catch(() => ({}));
  const conn = await env.DB.prepare("SELECT * FROM creator_connections WHERE id = ?").bind(id).first();
  if (!conn) return err("Connection not found.", 404);
  if (conn.partner_b_id !== partner.id) return err("Only the invited creator can respond to this connection request.", 403);
  const action = body.action;
  if (!["accept", "decline"].includes(action)) return err("action must be accept or decline.");
  const status = action === "accept" ? "accepted" : "declined";
  await env.DB.prepare("UPDATE creator_connections SET status = ?, decided_at = datetime('now') WHERE id = ?").bind(status, id).run();
  const row = await env.DB.prepare("SELECT * FROM creator_connections WHERE id = ?").bind(id).first();
  return json({ connection: row });
}

async function handleConnectionsAdminList(env) {
  const { results } = await env.DB.prepare(
    "SELECT cc.*, pa.name AS partner_a_name, pb.name AS partner_b_name FROM creator_connections cc JOIN partners pa ON pa.id = cc.partner_a_id JOIN partners pb ON pb.id = cc.partner_b_id ORDER BY cc.created_at DESC"
  ).all();
  return json({ connections: results });
}

// ---------- Partnership disclosures (FTC-style: sponsored/affiliate/free product/other) ----------

async function handleContentAssignmentDisclosureSet(request, env, partner, id) {
  const body = await request.json().catch(() => ({}));
  const allowed = ["sponsored", "affiliate", "free_product", "other"];
  if (!allowed.includes(body.disclosure_type)) return err("disclosure_type must be one of: " + allowed.join(", "));
  const assignment = await env.DB.prepare("SELECT * FROM content_assignments WHERE id = ?").bind(id).first();
  if (!assignment) return err("Content assignment not found.", 404);
  if (assignment.partner_id !== partner.id) return err("You can only set disclosures on your own content assignments.", 403);
  await env.DB.prepare("UPDATE content_assignments SET disclosure_type = ?, disclosure_confirmed_at = datetime('now') WHERE id = ?").bind(body.disclosure_type, id).run();
  const row = await env.DB.prepare("SELECT * FROM content_assignments WHERE id = ?").bind(id).first();
  return json({ content_assignment: row });
}
async function handlePublicPartnerRoutes(request, env, pathname, method) {
  if (pathname === "/api/public/earn-money" && method === "GET") return handleEarnMoneyList(env);
  if (pathname === "/api/public/partner-applications" && method === "POST") return handlePartnerApplicationCreate(request, env);
  if (pathname === "/api/partner/dashboard" && method === "GET") return handlePartnerDashboard(request, env);
  if (pathname === "/api/partner/referral-links" && method === "POST") return handlePartnerReferralLinkCreate(request, env);
  const am = pathname.match(/^\/api\/partner\/content-assignments\/([^/]+)\/submit$/);
  if (am && method === "POST") return handlePartnerContentAssignmentSubmit(request, env, am[1]);
  
  if (pathname === "/api/partner/categories" && method === "GET") return handleCategoriesList(env, true);

  if (pathname === "/api/partner/profile" && method === "GET") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handlePartnerProfileGet(env, partner);
  }
  if (pathname === "/api/partner/profile" && method === "PATCH") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handlePartnerProfileUpdate(request, env, partner);
  }
  if (pathname === "/api/partner/categories/set" && method === "POST") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handlePartnerCategoriesSet(request, env, partner);
  }
  if (pathname === "/api/partner/platforms" && method === "POST") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handlePartnerPlatformUpsert(request, env, partner);
  }
  if (pathname === "/api/partner/opportunities/recommended" && method === "GET") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handlePartnerRecommendedOpportunities(env, partner);
  }
  let oppApplyMatch = pathname.match(/^\/api\/partner\/opportunities\/([^/]+)\/apply$/);
  if (oppApplyMatch && method === "POST") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleOpportunityApplicationCreate(request, env, partner, oppApplyMatch[1]);
  }
  if (pathname === "/api/partner/applications" && method === "GET") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handlePartnerApplicationsList(env, partner);
  }
  if (pathname === "/api/partner/verification/code" && method === "POST") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleVerificationCodeCreate(env, partner);
  }
  if (pathname === "/api/partner/verification/scan" && method === "POST") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleVerificationCodeScan(request, env, partner);
  }
  if (pathname === "/api/partner/connections" && method === "POST") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleConnectionCreate(request, env, partner);
  }
  if (pathname === "/api/partner/connections" && method === "GET") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleCreatorConnectionsList(env, partner);
  }
  let connRespondMatch = pathname.match(/^\/api\/partner\/connections\/([^/]+)$/);
  if (connRespondMatch && method === "PATCH") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleConnectionRespond(request, env, partner, connRespondMatch[1]);
  }
  let disclosureMatch = pathname.match(/^\/api\/partner\/content-assignments\/([^/]+)\/disclosure$/);
  if (disclosureMatch && method === "PATCH") {
    const partner = await getPartnerByToken(env, partnerTokenFromRequest(request));
    if (!partner) return err("Invalid or missing partner token.", 401);
    return handleContentAssignmentDisclosureSet(request, env, partner, disclosureMatch[1]);
  }
return null;
}

async function handlePartnerOverview(env) {
  const partnerCount = await env.DB.prepare("SELECT COUNT(*) as n FROM partners WHERE status = 'active'").first();
  const pendingApps = await env.DB.prepare("SELECT COUNT(*) as n FROM partner_applications WHERE status = 'pending'").first();
  const openFlags = await env.DB.prepare("SELECT COUNT(*) as n FROM fraud_flags WHERE status = 'open'").first();
  const pendingEarnings = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) as total FROM earnings WHERE status = 'pending'").first();
  const paidEarnings = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) as total FROM earnings WHERE status = 'paid'").first();
  const totalClicks = await env.DB.prepare("SELECT COUNT(*) as n FROM referral_clicks").first();
  const totalConversions = await env.DB.prepare("SELECT COUNT(*) as n FROM referral_conversions WHERE status = 'verified'").first();
  return json({
    active_partners: partnerCount.n,
    pending_applications: pendingApps.n,
    open_fraud_flags: openFlags.n,
    pending_earnings_total: round2(pendingEarnings.total),
    paid_earnings_total: round2(paidEarnings.total),
    total_referral_clicks: totalClicks.n,
    verified_conversions: totalConversions.n,
    note: "All figures above are computed from real recorded clicks, admin-recorded conversions, and earnings/payouts in this database -- none are simulated.",
  });
}

async function handlePartnerAdminList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");
  let q = "SELECT * FROM partners";
  const conds = [];
  const binds = [];
  if (status) { conds.push("status = ?"); binds.push(status); }
  if (type) { conds.push("partner_type = ?"); binds.push(type); }
  if (conds.length) q += " WHERE " + conds.join(" AND ");
  q += " ORDER BY created_at DESC";
const { results } = await env.DB.prepare(q).bind(...binds).all();
  return json({ partners: results });
}

async function handlePartnerAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.name || !body.email) return err("name and email are required.");
  const id = uuid();
  const code = (body.referral_code || randomCode(6)).toUpperCase();
  const token = randomToken();
  await env.DB.prepare("INSERT INTO partners (id, name, email, phone, partner_type, status, level, referral_code, dashboard_token, default_commission_pct, social_links, audience_size, location, category, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, body.name, body.email, body.phone || null, body.partner_type || "affiliate", body.status || "pending", body.level || "new", code, token, body.default_commission_pct != null ? body.default_commission_pct : null, body.social_links || null, body.audience_size != null ? body.audience_size : null, body.location || null, body.category || null, body.notes || null).run();
  const row = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first();
  return json({ partner: row }, 201);
}

async function handlePartnerAdminDetail(env, id) {
  const partner = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first();
  if (!partner) return err("Partner not found.", 404);
  const { results: links } = await env.DB.prepare("SELECT * FROM referral_links WHERE partner_id = ?").bind(id).all();
  const { results: conversions } = await env.DB.prepare("SELECT * FROM referral_conversions WHERE partner_id = ? ORDER BY occurred_at DESC").bind(id).all();
  const { results: earnings } = await env.DB.prepare("SELECT * FROM earnings WHERE partner_id = ? ORDER BY created_at DESC").bind(id).all();
  const { results: payouts } = await env.DB.prepare("SELECT * FROM payouts WHERE partner_id = ? ORDER BY requested_at DESC").bind(id).all();
  const { results: notes } = await env.DB.prepare("SELECT * FROM partner_notes WHERE partner_id = ? ORDER BY created_at DESC").bind(id).all();
  const { results: flags } = await env.DB.prepare("SELECT * FROM fraud_flags WHERE partner_id = ? ORDER BY created_at DESC").bind(id).all();
  return json({ partner: partner, referral_links: links, conversions: conversions, earnings: earnings, payouts: payouts, notes: notes, fraud_flags: flags });
}

async function handlePartnerAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const fields = ["name","email","phone","partner_type","status","level","default_commission_pct","social_links","audience_size","location","category"];
  const sets = [];
  const binds = [];
  for (const f of fields) { if (body[f] !== undefined) { sets.push(f + " = ?"); binds.push(body[f]); } }
  if (!sets.length) return err("No updatable fields provided.");
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await env.DB.prepare("UPDATE partners SET " + sets.join(", ") + " WHERE id = ?").bind(...binds).run();
  const row = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(id).first();
  return json({ partner: row });
}

async function handlePartnerAdminAddNote(request, env, id) {
  const body = await request.json().catch(() => ({}));
  if (!body.note) return err("note is required.");
  const noteId = uuid();
  await env.DB.prepare("INSERT INTO partner_notes (id, partner_id, note) VALUES (?, ?, ?)").bind(noteId, id, body.note).run();
  const row = await env.DB.prepare("SELECT * FROM partner_notes WHERE id = ?").bind(noteId).first();
  return json({ note: row }, 201);
}

async function handleApplicationsList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM partner_applications ORDER BY created_at DESC").all();
  return json({ applications: results });
}

async function handleApplicationApprove(request, env, id) {
  const app = await env.DB.prepare("SELECT * FROM partner_applications WHERE id = ?").bind(id).first();
  if (!app) return err("Application not found.", 404);
  if (app.status !== "pending") return err("Application already reviewed.", 409);
  const body = await request.json().catch(() => ({}));
  let partner = await env.DB.prepare("SELECT * FROM partners WHERE email = ?").bind(app.applicant_email).first();
  if (!partner) {
    const id2 = uuid();
    const code = randomCode(6);
    const token = randomToken();
    await env.DB.prepare("INSERT INTO partners (id, name, email, partner_type, status, level, referral_code, dashboard_token, default_commission_pct) VALUES (?, ?, ?, ?, 'active', 'new', ?, ?, ?)").bind(id2, app.applicant_name, app.applicant_email, app.requested_partner_type, code, token, body.default_commission_pct != null ? body.default_commission_pct : null).run();
    partner = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(id2).first();
  } else {
    await env.DB.prepare("UPDATE partners SET status = 'active', updated_at = datetime('now') WHERE id = ?").bind(partner.id).run();
  }
  if (app.campaign_id) {
    await env.DB.prepare("INSERT OR IGNORE INTO campaign_partners (campaign_id, partner_id, status) VALUES (?, ?, 'active')").bind(app.campaign_id, partner.id).run();
  }
  await env.DB.prepare("UPDATE partner_applications SET status = 'approved', partner_id = ?, review_notes = ?, reviewed_at = datetime('now') WHERE id = ?").bind(partner.id, body.review_notes || null, id).run();
  const row = await env.DB.prepare("SELECT * FROM partner_applications WHERE id = ?").bind(id).first();
  return json({ application: row, partner: partner });
}

async function handleApplicationReject(request, env, id) {
  const app = await env.DB.prepare("SELECT * FROM partner_applications WHERE id = ?").bind(id).first();
  if (!app) return err("Application not found.", 404);
  const body = await request.json().catch(() => ({}));
  await env.DB.prepare("UPDATE partner_applications SET status = 'rejected', review_notes = ?, reviewed_at = datetime('now') WHERE id = ?").bind(body.review_notes || null, id).run();
  const row = await env.DB.prepare("SELECT * FROM partner_applications WHERE id = ?").bind(id).first();
  return json({ application: row });
}

async function handleCampaignsAdminList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all();
  return json({ campaigns: results });
}

async function handleCampaignsAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.name) return err("name is required.");
  const id = uuid();
  await env.DB.prepare("INSERT INTO campaigns (id, name, description, campaign_type, status, commission_type, commission_value, fixed_payment_amount, budget, starts_at, ends_at, requirements, bonus_rules, eligibility, target_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, body.name, body.description || null, body.campaign_type || "affiliate", body.status || "draft", body.commission_type || "percentage", body.commission_value != null ? body.commission_value : null, body.fixed_payment_amount != null ? body.fixed_payment_amount : null, body.budget != null ? body.budget : null, body.starts_at || null, body.ends_at || null, body.requirements || null, body.bonus_rules || null, body.eligibility || null, body.target_url || "/").run();
  const row = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  return json({ campaign: row }, 201);
}

async function handleCampaignsAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const fields = ["name","description","campaign_type","status","commission_type","commission_value","fixed_payment_amount","budget","starts_at","ends_at","requirements","bonus_rules","eligibility","target_url"];
  const sets = [];
  const binds = [];
  for (const f of fields) { if (body[f] !== undefined) { sets.push(f + " = ?"); binds.push(body[f]); } }
  if (!sets.length) return err("No updatable fields provided.");
  sets.push("updated_at = datetime('now')");
  binds.push(id);
  await env.DB.prepare("UPDATE campaigns SET " + sets.join(", ") + " WHERE id = ?").bind(...binds).run();
  const row = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first();
  return json({ campaign: row });
}

async function handleCampaignAddPartner(request, env, campaignId) {
  const body = await request.json().catch(() => ({}));
  if (!body.partner_id) return err("partner_id is required.");
  const existing = await env.DB.prepare("SELECT * FROM campaign_partners WHERE campaign_id = ? AND partner_id = ?").bind(campaignId, body.partner_id).first();
  if (existing) {
    await env.DB.prepare("UPDATE campaign_partners SET status = 'active', commission_override_type = ?, commission_override_value = ?, fixed_payment_override = ? WHERE campaign_id = ? AND partner_id = ?").bind(body.commission_override_type || null, body.commission_override_value != null ? body.commission_override_value : null, body.fixed_payment_override != null ? body.fixed_payment_override : null, campaignId, body.partner_id).run();
  } else {
    await env.DB.prepare("INSERT INTO campaign_partners (campaign_id, partner_id, status, commission_override_type, commission_override_value, fixed_payment_override) VALUES (?, ?, 'active', ?, ?, ?)").bind(campaignId, body.partner_id, body.commission_override_type || null, body.commission_override_value != null ? body.commission_override_value : null, body.fixed_payment_override != null ? body.fixed_payment_override : null).run();
  }
  const row = await env.DB.prepare("SELECT * FROM campaign_partners WHERE campaign_id = ? AND partner_id = ?").bind(campaignId, body.partner_id).first();
  return json({ campaign_partner: row }, 201);
}

async function handleConversionsAdminList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  let q = "SELECT * FROM referral_conversions";
  const binds = [];
  if (status) { q += " WHERE status = ?"; binds.push(status); }
  q += " ORDER BY occurred_at DESC";
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return json({ conversions: results });
}

async function handleConversionsAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.referral_link_id || !body.conversion_type) return err("referral_link_id and conversion_type are required.");
  const link = await env.DB.prepare("SELECT * FROM referral_links WHERE id = ?").bind(body.referral_link_id).first();
  if (!link) return err("referral_link_id not found.", 404);
  const partner = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(link.partner_id).first();
  const campaign = link.campaign_id ? await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(link.campaign_id).first() : null;
  const id = uuid();
  const revenue = Number(body.revenue_amount) || 0;
  await env.DB.prepare("INSERT INTO referral_conversions (id, referral_link_id, partner_id, campaign_id, conversion_type, reference_id, revenue_amount) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, link.id, partner.id, link.campaign_id || null, body.conversion_type, body.reference_id || null, revenue).run();
  await checkConversionVelocityFraud(env, partner.id, id);
  const conversion = await env.DB.prepare("SELECT * FROM referral_conversions WHERE id = ?").bind(id).first();
  const amount = await computeCommissionAmount(env, campaign, partner, conversion);
  const earningId = uuid();
  await env.DB.prepare("INSERT INTO earnings (id, partner_id, campaign_id, conversion_id, earning_type, amount, status, notes) VALUES (?, ?, ?, ?, 'commission', ?, 'pending', ?)").bind(earningId, partner.id, link.campaign_id || null, id, amount, "Auto-calculated from conversion; pending admin verification.").run();
  const earning = await env.DB.prepare("SELECT * FROM earnings WHERE id = ?").bind(earningId).first();
  return json({ conversion: conversion, earning: earning }, 201);
}

async function handleConversionsAdminUpdate(request, env, id) {
  const conv = await env.DB.prepare("SELECT * FROM referral_conversions WHERE id = ?").bind(id).first();
  if (!conv) return err("Conversion not found.", 404);
  const body = await request.json().catch(() => ({}));
  if (!body.status) return err("status is required.");
  await env.DB.prepare("UPDATE referral_conversions SET status = ?, flagged_reason = ?, verified_at = CASE WHEN ? = 'verified' THEN datetime('now') ELSE verified_at END WHERE id = ?").bind(body.status, body.flagged_reason || null, body.status, id).run();
  if (body.status === "verified") {
    await env.DB.prepare("UPDATE earnings SET status = 'approved', approved_at = datetime('now') WHERE conversion_id = ? AND status = 'pending'").bind(id).run();
  } else if (body.status === "rejected") {
    await env.DB.prepare("UPDATE earnings SET status = 'failed', notes = 'Underlying conversion was rejected by admin.' WHERE conversion_id = ? AND status = 'pending'").bind(id).run();
  } else if (body.status === "flagged") {
    await env.DB.prepare("INSERT INTO fraud_flags (id, partner_id, referral_conversion_id, reason) VALUES (?, ?, ?, ?)").bind(uuid(), conv.partner_id, id, body.flagged_reason || "Flagged by admin for review.").run();
  }
  await recalculatePartnerLevel(env, conv.partner_id);
  const row = await env.DB.prepare("SELECT * FROM referral_conversions WHERE id = ?").bind(id).first();
  return json({ conversion: row });
}

async function handleEarningsAdminList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const partnerId = url.searchParams.get("partner_id");
  let q = "SELECT * FROM earnings";
  const conds = [];
  const binds = [];
  if (status) { conds.push("status = ?"); binds.push(status); }
  if (partnerId) { conds.push("partner_id = ?"); binds.push(partnerId); }
  if (conds.length) q += " WHERE " + conds.join(" AND ");
  q += " ORDER BY created_at DESC";
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return json({ earnings: results });
}

async function handleEarningsAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  if (!body.status) return err("status is required.");
  await env.DB.prepare("UPDATE earnings SET status = ?, notes = COALESCE(?, notes), approved_at = CASE WHEN ? = 'approved' THEN datetime('now') ELSE approved_at END, paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END WHERE id = ?").bind(body.status, body.notes || null, body.status, body.status, id).run();
  const row = await env.DB.prepare("SELECT * FROM earnings WHERE id = ?").bind(id).first();
  return json({ earning: row });
}

async function handlePayoutsAdminList(request, env) {
  const url = new URL(request.url);
  const partnerId = url.searchParams.get("partner_id");
  let q = "SELECT * FROM payouts";
  const binds = [];
  if (partnerId) { q += " WHERE partner_id = ?"; binds.push(partnerId); }
  q += " ORDER BY requested_at DESC";
  const { results } = await env.DB.prepare(q).bind(...binds).all();
  return json({ payouts: results });
}

async function handlePayoutsAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.partner_id || !Array.isArray(body.earning_ids) || !body.earning_ids.length) return err("partner_id and earning_ids[] are required.");
  const placeholders = body.earning_ids.map(() => "?").join(",");
  const { results: earningsRows } = await env.DB.prepare("SELECT * FROM earnings WHERE id IN (" + placeholders + ") AND partner_id = ? AND status = 'approved'").bind(...body.earning_ids, body.partner_id).all();
  if (!earningsRows.length) return err("No approved earnings found for that partner with those ids.", 400);
  const total = round2(earningsRows.reduce((s, e) => s + e.amount, 0));
  const payoutId = uuid();
  await env.DB.prepare("INSERT INTO payouts (id, partner_id, amount, status, method, reference_note) VALUES (?, ?, ?, 'pending', ?, ?)").bind(payoutId, body.partner_id, total, body.method || null, body.reference_note || null).run();
  for (const e of earningsRows) {
    await env.DB.prepare("INSERT INTO payout_earnings (payout_id, earning_id) VALUES (?, ?)").bind(payoutId, e.id).run();
    await env.DB.prepare("UPDATE earnings SET status = 'processing' WHERE id = ?").bind(e.id).run();
  }
  const row = await env.DB.prepare("SELECT * FROM payouts WHERE id = ?").bind(payoutId).first();
  return json({ payout: row }, 201);
}

async function handlePayoutsAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  if (!body.status) return err("status is required.");
  await env.DB.prepare("UPDATE payouts SET status = ?, method = COALESCE(?, method), reference_note = COALESCE(?, reference_note), paid_at = CASE WHEN ? = 'paid' THEN datetime('now') ELSE paid_at END WHERE id = ?").bind(body.status, body.method || null, body.reference_note || null, body.status, id).run();
  if (body.status === "paid") {
    await env.DB.prepare("UPDATE earnings SET status = 'paid', paid_at = datetime('now') WHERE id IN (SELECT earning_id FROM payout_earnings WHERE payout_id = ?)").bind(id).run();
  } else if (body.status === "failed" || body.status === "disputed") {
    await env.DB.prepare("UPDATE earnings SET status = 'approved' WHERE id IN (SELECT earning_id FROM payout_earnings WHERE payout_id = ?) AND status = 'processing'").bind(id).run();
  }
  const row = await env.DB.prepare("SELECT * FROM payouts WHERE id = ?").bind(id).first();
  return json({ payout: row });
}

async function handleBonusRulesAdminList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM bonus_rules ORDER BY created_at DESC").all();
  return json({ bonus_rules: results });
}

async function handleBonusRulesAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.metric || body.threshold === undefined || body.bonus_amount === undefined) return err("metric, threshold, and bonus_amount are required.");
  const id = uuid();
  await env.DB.prepare("INSERT INTO bonus_rules (id, campaign_id, metric, threshold, bonus_amount, description) VALUES (?, ?, ?, ?, ?, ?)").bind(id, body.campaign_id || null, body.metric, body.threshold, body.bonus_amount, body.description || null).run();
  const row = await env.DB.prepare("SELECT * FROM bonus_rules WHERE id = ?").bind(id).first();
  return json({ bonus_rule: row }, 201);
}

async function handleFraudFlagsAdminList(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "open";
  const { results } = await env.DB.prepare("SELECT * FROM fraud_flags WHERE status = ? ORDER BY created_at DESC").bind(status).all();
  return json({ fraud_flags: results, note: "Flags are for admin review only; nothing here has auto-banned a partner or withheld any payout." });
}

async function handleFraudFlagsAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  if (!body.status) return err("status is required.");
  await env.DB.prepare("UPDATE fraud_flags SET status = ?, reviewed_at = datetime('now') WHERE id = ?").bind(body.status, id).run();
  const row = await env.DB.prepare("SELECT * FROM fraud_flags WHERE id = ?").bind(id).first();
  return json({ fraud_flag: row });
}

async function handleContentAssignmentsAdminList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM content_assignments ORDER BY created_at DESC").all();
  return json({ content_assignments: results });
}

async function handleContentAssignmentsAdminCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.campaign_id || !body.partner_id || !body.requirement_label) return err("campaign_id, partner_id, and requirement_label are required.");
  const id = uuid();
  await env.DB.prepare("INSERT INTO content_assignments (id, campaign_id, partner_id, requirement_label, platform, due_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, body.campaign_id, body.partner_id, body.requirement_label, body.platform || null, body.due_at || null).run();
  const row = await env.DB.prepare("SELECT * FROM content_assignments WHERE id = ?").bind(id).first();
  return json({ content_assignment: row }, 201);
}

async function handleContentAssignmentsAdminUpdate(request, env, id) {
  const body = await request.json().catch(() => ({}));
  const fields = ["status","content_id","due_at","published_at"];
  const sets = [];
  const binds = [];
  for (const f of fields) { if (body[f] !== undefined) { sets.push(f + " = ?"); binds.push(body[f]); } }
  if (!sets.length) return err("No updatable fields provided.");
  binds.push(id);
  await env.DB.prepare("UPDATE content_assignments SET " + sets.join(", ") + " WHERE id = ?").bind(...binds).run();
  const row = await env.DB.prepare("SELECT * FROM content_assignments WHERE id = ?").bind(id).first();
  return json({ content_assignment: row });
}

async function handleSetupPartnerSchema(env) {
  const statements = [
  "CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT, partner_type TEXT NOT NULL DEFAULT 'affiliate' CHECK (partner_type IN ('affiliate','ambassador','creator','paid_partner','vip')), status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','rejected','terminated')), level TEXT NOT NULL DEFAULT 'new' CHECK (level IN ('new','bronze','silver','gold','elite','vip')), referral_code TEXT NOT NULL UNIQUE, dashboard_token TEXT NOT NULL UNIQUE, default_commission_pct REAL, social_links TEXT, audience_size INTEGER, location TEXT, category TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), last_active_at TEXT)",
  "CREATE TABLE IF NOT EXISTS partner_levels (level TEXT PRIMARY KEY CHECK (level IN ('new','bronze','silver','gold','elite','vip')), min_revenue REAL NOT NULL DEFAULT 0, min_conversions INTEGER NOT NULL DEFAULT 0, commission_pct REAL, perks TEXT, sort_order INTEGER NOT NULL DEFAULT 0)",
  "INSERT OR IGNORE INTO partner_levels (level, min_revenue, min_conversions, commission_pct, perks, sort_order) VALUES ('new', 0, 0, 5, '[\"Standard referral link\"]', 0), ('bronze', 250, 5, 7, '[\"Standard referral link\",\"Access to open campaigns\"]', 1), ('silver', 1000, 20, 10, '[\"Higher commission\",\"Early campaign access\"]', 2), ('gold', 3000, 50, 12, '[\"Higher commission\",\"Early campaign access\",\"Priority for paid campaigns\"]', 3), ('elite', 7500, 100, 15, '[\"Highest standard commission\",\"Early access\",\"Priority paid campaigns\"]', 4), ('vip', 15000, 200, 0, '[\"Individually negotiated compensation and benefits\"]', 5)",
  "CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, campaign_type TEXT NOT NULL DEFAULT 'affiliate' CHECK (campaign_type IN ('affiliate','paid_partnership','ambassador','creator_content')), status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','active','paused','completed','cancelled')), commission_type TEXT NOT NULL DEFAULT 'percentage' CHECK (commission_type IN ('percentage','fixed_per_referral','fixed_per_sale','fixed_payment','custom')), commission_value REAL, fixed_payment_amount REAL, budget REAL, starts_at TEXT, ends_at TEXT, requirements TEXT, bonus_rules TEXT, eligibility TEXT, target_url TEXT NOT NULL DEFAULT '/', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS partner_applications (id TEXT PRIMARY KEY, applicant_name TEXT NOT NULL, applicant_email TEXT NOT NULL, requested_partner_type TEXT NOT NULL DEFAULT 'affiliate' CHECK (requested_partner_type IN ('affiliate','ambassador','creator','paid_partner','vip')), campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL, message TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')), review_notes TEXT, partner_id TEXT REFERENCES partners(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT)",
  "CREATE TABLE IF NOT EXISTS campaign_partners (campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','removed')), commission_override_type TEXT, commission_override_value REAL, fixed_payment_override REAL, joined_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (campaign_id, partner_id))",
  "CREATE TABLE IF NOT EXISTS referral_links (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL, code TEXT NOT NULL UNIQUE, destination_url TEXT NOT NULL DEFAULT '/', created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS referral_clicks (id TEXT PRIMARY KEY, referral_link_id TEXT NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE, ip_hash TEXT, user_agent TEXT, referer TEXT, clicked_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS referral_conversions (id TEXT PRIMARY KEY, referral_link_id TEXT NOT NULL REFERENCES referral_links(id) ON DELETE CASCADE, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL, conversion_type TEXT NOT NULL CHECK (conversion_type IN ('signup','ticket_sale','membership','other_purchase')), reference_id TEXT, revenue_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','verified','rejected','flagged')), flagged_reason TEXT, occurred_at TEXT NOT NULL DEFAULT (datetime('now')), verified_at TEXT)",
  "CREATE TABLE IF NOT EXISTS earnings (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL, conversion_id TEXT REFERENCES referral_conversions(id) ON DELETE SET NULL, earning_type TEXT NOT NULL DEFAULT 'commission' CHECK (earning_type IN ('commission','fixed_payment','bonus','adjustment')), amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','processing','paid','failed','disputed')), notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), approved_at TEXT, paid_at TEXT)",
  "CREATE TABLE IF NOT EXISTS payouts (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','processing','paid','failed','disputed')), method TEXT, reference_note TEXT, requested_at TEXT NOT NULL DEFAULT (datetime('now')), paid_at TEXT)",
  "CREATE TABLE IF NOT EXISTS payout_earnings (payout_id TEXT NOT NULL REFERENCES payouts(id) ON DELETE CASCADE, earning_id TEXT NOT NULL REFERENCES earnings(id) ON DELETE CASCADE, PRIMARY KEY (payout_id, earning_id))",
  "CREATE TABLE IF NOT EXISTS bonus_rules (id TEXT PRIMARY KEY, campaign_id TEXT REFERENCES campaigns(id) ON DELETE CASCADE, metric TEXT NOT NULL CHECK (metric IN ('referrals','sales','revenue')), threshold REAL NOT NULL, bonus_amount REAL NOT NULL, description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS content_assignments (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, requirement_label TEXT NOT NULL, content_id TEXT REFERENCES creator_content(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','submitted','approved','revision_requested','rejected','published')), platform TEXT, due_at TEXT, submitted_at TEXT, published_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS partner_notes (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE, note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS fraud_flags (id TEXT PRIMARY KEY, partner_id TEXT REFERENCES partners(id) ON DELETE CASCADE, referral_conversion_id TEXT REFERENCES referral_conversions(id) ON DELETE CASCADE, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed_ok','reviewed_confirmed')), created_at TEXT NOT NULL DEFAULT (datetime('now')), reviewed_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_referral_links_partner ON referral_links(partner_id)",
  "CREATE INDEX IF NOT EXISTS idx_referral_clicks_link ON referral_clicks(referral_link_id)",
  "CREATE INDEX IF NOT EXISTS idx_referral_conversions_partner ON referral_conversions(partner_id)",
  "CREATE INDEX IF NOT EXISTS idx_referral_conversions_link ON referral_conversions(referral_link_id)",
  "CREATE INDEX IF NOT EXISTS idx_earnings_partner ON earnings(partner_id)",
  "CREATE INDEX IF NOT EXISTS idx_earnings_status ON earnings(status)",
  "CREATE INDEX IF NOT EXISTS idx_payouts_partner ON payouts(partner_id)",
  "CREATE INDEX IF NOT EXISTS idx_partner_applications_status ON partner_applications(status)",
  "CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)",
  "CREATE INDEX IF NOT EXISTS idx_content_assignments_campaign ON content_assignments(campaign_id)",
  "CREATE INDEX IF NOT EXISTS idx_content_assignments_partner ON content_assignments(partner_id)",
  "CREATE INDEX IF NOT EXISTS idx_fraud_flags_status ON fraud_flags(status)"
  ];
  const results = [];
  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
      results.push({ ok: true, statement: sql.slice(0, 70) });
    } catch (e) {
      results.push({ ok: false, statement: sql.slice(0, 70), error: String((e && e.message) || e) });
    }
  }
  const failed = results.filter(function (r) { return !r.ok; });
  return json({ ok: failed.length === 0, total: statements.length, failed: failed.length, results: results });
}

async function recalculatePartnerLevel(env, partnerId) {
  const partner = await env.DB.prepare("SELECT * FROM partners WHERE id = ?").bind(partnerId).first();
  if (!partner) return null;
  const totals = await env.DB.prepare("SELECT COALESCE(SUM(revenue_amount), 0) AS rev, COUNT(*) AS cnt FROM referral_conversions WHERE partner_id = ? AND status = 'verified'").bind(partnerId).first();
  const levels = await env.DB.prepare("SELECT * FROM partner_levels ORDER BY sort_order DESC").all();
  let newLevel = partner.level;
  for (const lvl of levels.results) {
    if (totals.rev >= lvl.min_revenue && totals.cnt >= lvl.min_conversions) { newLevel = lvl.level; break; }
  }
  if (newLevel !== partner.level) {
    await env.DB.prepare("UPDATE partners SET level = ?, updated_at = datetime('now') WHERE id = ?").bind(newLevel, partnerId).run();
    await env.DB.prepare("INSERT INTO partner_notes (id, partner_id, note) VALUES (?, ?, ?)").bind(uuid(), partnerId, "Automatic level update (rule-based, from verified revenue/conversions): " + partner.level + " -> " + newLevel + " (verified revenue $" + totals.rev.toFixed(2) + ", " + totals.cnt + " verified conversions).").run();
  }
  return newLevel;
}

async function checkClickVelocityFraud(env, link, ipHash) {
  if (!ipHash) return;
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM referral_clicks WHERE referral_link_id = ? AND ip_hash = ? AND clicked_at >= ?").bind(link.id, ipHash, since).first();
  if (recent.c > 20) {
    const already = await env.DB.prepare("SELECT id FROM fraud_flags WHERE partner_id = ? AND reason LIKE 'Unusually high click volume%' AND status = 'open' AND created_at >= datetime('now', '-1 day')").bind(link.partner_id).first();
    if (!already) {
      await env.DB.prepare("INSERT INTO fraud_flags (id, partner_id, reason) VALUES (?, ?, ?)").bind(uuid(), link.partner_id, "Unusually high click volume: " + recent.c + " clicks from one source on referral link '" + link.code + "' within the last hour. Rule-based flag, for review only -- nothing has been blocked or paused.").run();
    }
  }
}

async function checkConversionVelocityFraud(env, partnerId, conversionId) {
  const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM referral_conversions WHERE partner_id = ? AND occurred_at >= datetime('now', '-1 hour')").bind(partnerId).first();
  if (recent.c > 5) {
    const already = await env.DB.prepare("SELECT id FROM fraud_flags WHERE partner_id = ? AND reason LIKE 'Unusually high conversion volume%' AND status = 'open' AND created_at >= datetime('now', '-1 day')").bind(partnerId).first();
    if (!already) {
      await env.DB.prepare("INSERT INTO fraud_flags (id, partner_id, referral_conversion_id, reason) VALUES (?, ?, ?, ?)").bind(uuid(), partnerId, conversionId, "Unusually high conversion volume: " + recent.c + " conversions recorded for this partner within the last hour. Rule-based flag, for review only -- nothing has been blocked or paused.").run();
    }
  }
}

async function handlePartnerLevelsRecalculateAll(env) {
  const { results } = await env.DB.prepare("SELECT id FROM partners").all();
  const updates = [];
  for (const p of results) {
    const newLevel = await recalculatePartnerLevel(env, p.id);
    updates.push({ partner_id: p.id, level: newLevel });
  }
  return json({ ok: true, count: updates.length, updates: updates });
}

// ---------- AI Partner Manager / AI Matching / AI Alerts (rule-based, not real ML) ----------

async function handlePartnerInsights(env) {
  const insights = [];
  const partnersRes = await env.DB.prepare("SELECT * FROM partners").all();
  const partners = partnersRes.results || [];
  const levelsRes = await env.DB.prepare("SELECT * FROM partner_levels ORDER BY sort_order ASC").all();
  const levels = levelsRes.results || [];
  const now = Date.now();

  for (const p of partners) {
    const flagRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM fraud_flags WHERE partner_id = ? AND status = 'open'").bind(p.id).first();
    if (flagRow && flagRow.c > 0) {
      insights.push({
        partner_id: p.id,
        partner_name: p.name,
        type: "fraud_review",
        severity: "high",
        message: p.name + " has " + flagRow.c + " open fraud flag(s) awaiting admin review. Rule-based flags only -- nothing has been blocked or paused automatically.",
      });
    }

    if (p.status === "active") {
      const lastActive = p.last_active_at ? new Date(p.last_active_at).getTime() : null;
      const daysSince = lastActive ? Math.floor((now - lastActive) / 86400000) : null;
      if (daysSince === null || daysSince > 30) {
        insights.push({
          partner_id: p.id,
          partner_name: p.name,
          type: "inactive",
          severity: "medium",
          message: p.name + " has shown no recorded activity" + (daysSince !== null ? (" in " + daysSince + " days") : "") + ". Consider manual outreach -- this is a suggestion only, no message has been sent automatically.",
        });
      }
    }

    const totals = await env.DB.prepare("SELECT COALESCE(SUM(revenue_amount), 0) AS rev, COUNT(*) AS cnt FROM referral_conversions WHERE partner_id = ? AND status = 'verified'").bind(p.id).first();
    const currentIdx = levels.findIndex(function (l) { return l.level === p.level; });
    const nextLevel = currentIdx >= 0 ? levels[currentIdx + 1] : null;
    if (nextLevel && totals) {
      const revNeeded = nextLevel.min_revenue - totals.rev;
      const closeToRevenue = revNeeded > 0 && nextLevel.min_revenue > 0 && revNeeded <= nextLevel.min_revenue * 0.2;
      if (closeToRevenue) {
        insights.push({
          partner_id: p.id,
          partner_name: p.name,
          type: "near_level_up",
          severity: "low",
          message: p.name + " is close to reaching " + nextLevel.level + " level (about $" + revNeeded.toFixed(2) + " more in verified revenue needed). Estimate only, not guaranteed.",
        });
      }
    }
  }

  const staleAppsRes = await env.DB.prepare("SELECT * FROM partner_applications WHERE status = 'pending' AND created_at <= datetime('now','-7 days')").all();
  const staleApps = staleAppsRes.results || [];
  for (const a of staleApps) {
    insights.push({
      partner_id: null,
      application_id: a.id,
      partner_name: a.applicant_name,
      type: "stale_application",
      severity: "medium",
      message: "Application from " + a.applicant_name + " has been pending review for over 7 days.",
    });
  }

  return json({
    insights: insights,
    generated_at: new Date().toISOString(),
    note: "Rule-based insights for admin review only. Nothing here takes automatic action on a partner's behalf.",
  });
}

async function handleCampaignMatches(env, campaignId) {
  const campaign = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(campaignId).first();
  if (!campaign) return err("Campaign not found.", 404);

  const partnersRes = await env.DB.prepare("SELECT * FROM partners WHERE status = 'active'").all();
  const partners = partnersRes.results || [];
  const levelsRes = await env.DB.prepare("SELECT * FROM partner_levels").all();
  const levelWeight = {};
  (levelsRes.results || []).forEach(function (l) { levelWeight[l.level] = l.sort_order; });

  const haystack = ((campaign.eligibility || "") + " " + (campaign.requirements || "") + " " + (campaign.description || "")).toLowerCase();

  const matches = [];
  for (const p of partners) {
    let score = 0;
    const reasons = [];

    if (p.category && haystack.indexOf(p.category.toLowerCase()) !== -1) {
      score += 50;
      reasons.push("category '" + p.category + "' matches campaign eligibility/requirements text");
    }

    const weight = levelWeight[p.level] || 0;
    score += weight * 5;
    if (weight > 0) reasons.push("partner level: " + p.level);

    const convStats = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM referral_conversions WHERE partner_id = ? AND status = 'verified'").bind(p.id).first();
    const verifiedCount = (convStats && convStats.cnt) || 0;
    score += Math.min(verifiedCount, 20) * 2;
    if (verifiedCount > 0) reasons.push(verifiedCount + " verified conversion(s) on record");

    if (score > 0) {
      matches.push({
        partner_id: p.id,
        partner_name: p.name,
        partner_type: p.partner_type,
        level: p.level,
        match_score: score,
        reasons: reasons,
      });
    }
  }

  matches.sort(function (a, b) { return b.match_score - a.match_score; });

  return json({
    campaign_id: campaignId,
    campaign_name: campaign.name,
    matches: matches.slice(0, 25),
    note: "Rule-based suggestions ranked by simple scoring (category overlap, partner level, verified performance). Not a guarantee of fit or approval -- admin review is required before inviting any partner to a campaign.",
  });
}

async function handleAdminAlerts(env) {
  const alerts = [];

  const openFlagsRes = await env.DB.prepare(
    "SELECT f.id, f.partner_id, f.reason, f.created_at, p.name AS partner_name FROM fraud_flags f LEFT JOIN partners p ON p.id = f.partner_id WHERE f.status = 'open' ORDER BY f.created_at DESC LIMIT 50"
  ).all();
  (openFlagsRes.results || []).forEach(function (f) {
    alerts.push({
      type: "fraud_flag_open",
      severity: "high",
      message: "Open fraud flag for " + (f.partner_name || "unknown partner") + ": " + f.reason,
      entity_id: f.id,
      created_at: f.created_at,
    });
  });

  const staleAppsRes2 = await env.DB.prepare(
    "SELECT id, applicant_name, created_at FROM partner_applications WHERE status = 'pending' AND created_at <= datetime('now','-7 days') ORDER BY created_at ASC LIMIT 50"
  ).all();
  (staleAppsRes2.results || []).forEach(function (a) {
    alerts.push({
      type: "stale_application",
      severity: "medium",
      message: "Application from " + a.applicant_name + " has been pending for over 7 days.",
      entity_id: a.id,
      created_at: a.created_at,
    });
  });

  const endingSoonRes = await env.DB.prepare(
    "SELECT id, name, ends_at FROM campaigns WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= datetime('now','+7 days') AND ends_at >= datetime('now') ORDER BY ends_at ASC LIMIT 50"
  ).all();
  (endingSoonRes.results || []).forEach(function (c) {
    alerts.push({
      type: "campaign_ending_soon",
      severity: "low",
      message: "Campaign '" + c.name + "' ends on " + c.ends_at + ".",
      entity_id: c.id,
      created_at: c.ends_at,
    });
  });

  const recentLevelChangesRes = await env.DB.prepare(
    "SELECT pn.id, pn.partner_id, pn.note, pn.created_at, p.name AS partner_name FROM partner_notes pn LEFT JOIN partners p ON p.id = pn.partner_id WHERE pn.note LIKE 'Automatic level update%' AND pn.created_at >= datetime('now','-7 days') ORDER BY pn.created_at DESC LIMIT 50"
  ).all();
  (recentLevelChangesRes.results || []).forEach(function (n) {
    alerts.push({
      type: "level_change",
      severity: "low",
      message: (n.partner_name || "A partner") + ": " + n.note,
      entity_id: n.partner_id,
      created_at: n.created_at,
    });
  });

  alerts.sort(function (a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });

  return json({
    alerts: alerts,
    generated_at: new Date().toISOString(),
    note: "Rule-based alert feed for admin awareness only. No automated actions are taken as a result of these alerts.",
  });
}
function handleAdminPartnerRoutes(request, env, pathname, method) {
  if (pathname === "/api/admin/partners/recalculate-levels" && method === "POST") return handlePartnerLevelsRecalculateAll(env);

  if (pathname === "/api/admin/setup-partner-schema" && method === "POST") return handleSetupPartnerSchema(env);

  if (pathname === "/api/admin/partners/overview" && method === "GET") return handlePartnerOverview(env);
  if (pathname === "/api/admin/partners" && method === "GET") return handlePartnerAdminList(request, env);
  if (pathname === "/api/admin/partners" && method === "POST") return handlePartnerAdminCreate(request, env);
  let m = pathname.match(/^\/api\/admin\/partners\/([^/]+)\/notes$/);
  if (m && method === "POST") return handlePartnerAdminAddNote(request, env, m[1]);
  m = pathname.match(/^\/api\/admin\/partners\/([^/]+)$/);
  if (m && method === "GET") return handlePartnerAdminDetail(env, m[1]);
  if (m && method === "PATCH") return handlePartnerAdminUpdate(request, env, m[1]);
  if (pathname === "/api/admin/applications" && method === "GET") return handleApplicationsList(env);
  m = pathname.match(/^\/api\/admin\/applications\/([^/]+)\/approve$/);
  if (m && method === "POST") return handleApplicationApprove(request, env, m[1]);
  m = pathname.match(/^\/api\/admin\/applications\/([^/]+)\/reject$/);
  if (m && method === "POST") return handleApplicationReject(request, env, m[1]);
  if (pathname === "/api/admin/campaigns" && method === "GET") return handleCampaignsAdminList(env);
  if (pathname === "/api/admin/campaigns" && method === "POST") return handleCampaignsAdminCreate(request, env);
  m = pathname.match(/^\/api\/admin\/campaigns\/([^/]+)\/partners$/);
  if (m && method === "POST") return handleCampaignAddPartner(request, env, m[1]);
  m = pathname.match(/^\/api\/admin\/campaigns\/([^/]+)$/);
  if (m && method === "PATCH") return handleCampaignsAdminUpdate(request, env, m[1]);
  if (pathname === "/api/admin/conversions" && method === "GET") return handleConversionsAdminList(request, env);
  if (pathname === "/api/admin/conversions" && method === "POST") return handleConversionsAdminCreate(request, env);
  m = pathname.match(/^\/api\/admin\/conversions\/([^/]+)$/);
  if (m && method === "PATCH") return handleConversionsAdminUpdate(request, env, m[1]);
  if (pathname === "/api/admin/earnings" && method === "GET") return handleEarningsAdminList(request, env);
  m = pathname.match(/^\/api\/admin\/earnings\/([^/]+)$/);
  if (m && method === "PATCH") return handleEarningsAdminUpdate(request, env, m[1]);
  if (pathname === "/api/admin/payouts" && method === "GET") return handlePayoutsAdminList(request, env);
  if (pathname === "/api/admin/payouts" && method === "POST") return handlePayoutsAdminCreate(request, env);
  m = pathname.match(/^\/api\/admin\/payouts\/([^/]+)$/);
  if (m && method === "PATCH") return handlePayoutsAdminUpdate(request, env, m[1]);
  if (pathname === "/api/admin/bonus-rules" && method === "GET") return handleBonusRulesAdminList(env);
  if (pathname === "/api/admin/bonus-rules" && method === "POST") return handleBonusRulesAdminCreate(request, env);
  if (pathname === "/api/admin/fraud-flags" && method === "GET") return handleFraudFlagsAdminList(request, env);
  m = pathname.match(/^\/api\/admin\/fraud-flags\/([^/]+)$/);
  if (m && method === "PATCH") return handleFraudFlagsAdminUpdate(request, env, m[1]);
  if (pathname === "/api/admin/content-assignments" && method === "GET") return handleContentAssignmentsAdminList(env);
  if (pathname === "/api/admin/content-assignments" && method === "POST") return handleContentAssignmentsAdminCreate(request, env);
  m = pathname.match(/^\/api\/admin\/content-assignments\/([^/]+)$/);
  if (m && method === "PATCH") return handleContentAssignmentsAdminUpdate(request, env, m[1]);
  
  if (pathname === "/api/admin/ai/partner-insights" && method === "GET") return handlePartnerInsights(env);
  if (pathname === "/api/admin/ai/alerts" && method === "GET") return handleAdminAlerts(env);
  m = pathname.match(/^\/api\/admin\/ai\/campaign-matches\/([^/]+)$/);
  if (m && method === "GET") return handleCampaignMatches(env, m[1]);

  if (pathname === "/api/admin/setup-recommendation-schema" && method === "POST") return handleSetupRecommendationSchema(env);

  if (pathname === "/api/admin/categories" && method === "GET") return handleCategoriesList(env, false);
  if (pathname === "/api/admin/categories" && method === "POST") return handleCategoriesAdminCreate(request, env);
  m = pathname.match(/^\/api\/admin\/categories\/([^/]+)$/);
  if (m && method === "PATCH") return handleCategoriesAdminUpdate(request, env, m[1]);

  m = pathname.match(/^\/api\/admin\/campaigns\/([^/]+)\/requirements$/);
  if (m && method === "PATCH") return handleCampaignRequirementsUpdate(request, env, m[1]);
  m = pathname.match(/^\/api\/admin\/campaigns\/([^/]+)\/recommended-creators$/);
  if (m && method === "GET") return handleCampaignRecommendedCreators(env, m[1]);

  if (pathname === "/api/admin/opportunity-applications" && method === "GET") {
    const qUrl = new URL(request.url);
    return handleOpportunityApplicationsAdminList(env, qUrl.searchParams.get("campaign_id"));
  }
  m = pathname.match(/^\/api\/admin\/opportunity-applications\/([^/]+)$/);
  if (m && method === "PATCH") return handleOpportunityApplicationAdminUpdate(request, env, m[1]);

  if (pathname === "/api/admin/connections" && method === "GET") return handleConnectionsAdminList(env);
return null;
}
