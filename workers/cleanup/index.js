// exodia-cleanup: daily data-retention job for the EXODIA DIGITAL chatbot (Workers Free).
//
// Set up in the Cloudflare dashboard (no Node.js needed):
//   Workers & Pages > Create > Worker > name "exodia-cleanup" > paste this file > Deploy
//   Settings > Bindings > D1 database: variable name DB, database exodia-leads
//   Settings > Trigger events > Cron: 0 19 * * *   (19:00 UTC = 3:00 AM Philippine time)
//   Settings > Domains & Routes: disable the workers.dev route (it is not needed)
//
// Deletes: leads older than 12 months, rate-limit rows older than 2 days, usage rows older than
// 90 days, and email status rows whose lead was deleted. Each run is recorded in cleanup_runs.

export default {
  async scheduled(controller, env, ctx) {
    const db = env.DB;
    const results = await db.batch([
      db.prepare("DELETE FROM leads WHERE created_at < datetime('now', '-12 months')"),
      db.prepare("DELETE FROM rate_limits WHERE window_start < CAST(strftime('%s', 'now', '-2 days') AS INTEGER)"),
      db.prepare("DELETE FROM ai_usage WHERE day < date('now', '-90 days')"),
    ]);
    const [leads, limits, usage] = results.map((r) => r.meta?.changes ?? 0);
    // Email status rows whose lead is gone. Separate, so a database without this table still cleans up.
    try {
      await db.prepare("DELETE FROM lead_notifications WHERE ref NOT IN (SELECT ref FROM leads)").run();
    } catch {
      /* table not created in this database */
    }
    await db
      .prepare("INSERT INTO cleanup_runs (leads_deleted, rate_limits_deleted, usage_deleted) VALUES (?1, ?2, ?3)")
      .bind(leads, limits, usage)
      .run();
  },

  // No public endpoint: any web request gets a 404.
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
