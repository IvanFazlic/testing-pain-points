/**
 * One-time seed: export enriched contacts + companies from MXD Compass SQLite → Railway PostgreSQL.
 * Reads the source DB read-only. Does NOT modify the Compass project.
 */
import { Command } from "commander";
import Database from "better-sqlite3";
import { pool, shutdown } from "../src/db/connection.js";

const COMPASS_DB_PATH =
  "/home/kali/mxdcompass_gtm_linkedin/data/linkedin_ads.sqlite";

interface CompassRow {
  person_linkedin_url: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  email: string | null;
  role_seniority: string | null;
  buyer_persona: string | null;
  company_name: string | null;
  company_domain: string | null;
  linkedin_company_id: string | null;
  normalized_industry: string | null;
  employee_count_band: string | null;
  microsegment_id: string;
  microsegment_label: string;
}

const EXTRACT_SQL = `
  SELECT DISTINCT
    c.person_linkedin_url,
    c.first_name,
    c.last_name,
    c.full_name,
    c.title,
    c.email,
    c.role_seniority,
    op.buyer_persona,
    COALESCE(cc.display_company_name, op.company_name) AS company_name,
    COALESCE(cc.primary_domain, op.company_domain)     AS company_domain,
    COALESCE(cc.linkedin_company_id, op.linkedin_company_id) AS linkedin_company_id,
    COALESCE(cc.normalized_industry, op.industry)      AS normalized_industry,
    COALESCE(cc.employee_count_band, op.company_size_cluster) AS employee_count_band,
    m.microsegment_id,
    m.display_name AS microsegment_label
  FROM contacts c
  JOIN organization_microsegment_memberships omm
    ON c.segment_id = omm.segment_id AND c.organization_key = omm.organization_key
  JOIN microsegments m
    ON omm.microsegment_id = m.microsegment_id AND m.review_status = 'ACTIVE'
  LEFT JOIN organization_profiles op
    ON c.segment_id = op.segment_id AND c.organization_key = op.organization_key
  LEFT JOIN canonical_companies cc
    ON (op.company_domain IS NOT NULL AND op.company_domain = cc.primary_domain)
    OR (op.linkedin_company_id IS NOT NULL AND op.linkedin_company_id = cc.linkedin_company_id)
  WHERE c.person_linkedin_url IS NOT NULL
    AND c.person_linkedin_url != ''
`;

async function seed(opts: { microsegment?: string; dryRun: boolean }) {
  console.log("Opening Compass SQLite (read-only)...");
  const sqlite = new Database(COMPASS_DB_PATH, { readonly: true });

  let rows: CompassRow[];
  if (opts.microsegment) {
    rows = sqlite
      .prepare(EXTRACT_SQL + " AND m.microsegment_id = ?")
      .all(opts.microsegment) as CompassRow[];
  } else {
    rows = sqlite.prepare(EXTRACT_SQL).all() as CompassRow[];
  }
  sqlite.close();

  // Deduplicate: a contact may appear in multiple microsegments via JOIN.
  // Keep the first occurrence per person_linkedin_url (we store one microsegment per contact).
  const seen = new Map<string, CompassRow>();
  for (const row of rows) {
    if (!seen.has(row.person_linkedin_url)) {
      seen.set(row.person_linkedin_url, row);
    }
  }
  const uniqueContacts = Array.from(seen.values());

  // Collect unique companies by domain
  const companyMap = new Map<
    string,
    {
      display_name: string;
      primary_domain: string | null;
      linkedin_company_id: string | null;
      normalized_industry: string | null;
      employee_count_band: string | null;
    }
  >();
  for (const row of uniqueContacts) {
    const key = row.company_domain ?? row.company_name ?? "unknown";
    if (!companyMap.has(key)) {
      companyMap.set(key, {
        display_name: row.company_name ?? key,
        primary_domain: row.company_domain,
        linkedin_company_id: row.linkedin_company_id,
        normalized_industry: row.normalized_industry,
        employee_count_band: row.employee_count_band,
      });
    }
  }

  console.log(
    `Extracted ${uniqueContacts.length} unique contacts from ${companyMap.size} companies`,
  );
  if (opts.dryRun) {
    console.log("Dry run — not writing to PostgreSQL.");
    console.log(
      "Sample:",
      JSON.stringify(uniqueContacts.slice(0, 3), null, 2),
    );
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Upsert companies
    let companyCount = 0;
    const domainToId = new Map<string, number>();
    for (const [key, co] of companyMap) {
      const res = await client.query(
        `INSERT INTO companies (display_name, primary_domain, linkedin_company_id, normalized_industry, employee_count_band)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (primary_domain) WHERE primary_domain IS NOT NULL
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           linkedin_company_id = COALESCE(EXCLUDED.linkedin_company_id, companies.linkedin_company_id),
           normalized_industry = COALESCE(EXCLUDED.normalized_industry, companies.normalized_industry),
           employee_count_band = COALESCE(EXCLUDED.employee_count_band, companies.employee_count_band)
         RETURNING id`,
        [
          co.display_name,
          co.primary_domain,
          co.linkedin_company_id,
          co.normalized_industry,
          co.employee_count_band,
        ],
      );
      domainToId.set(key, res.rows[0].id);
      companyCount++;
    }
    console.log(`Upserted ${companyCount} companies`);

    // Upsert contacts
    let contactCount = 0;
    for (const row of uniqueContacts) {
      const companyKey =
        row.company_domain ?? row.company_name ?? "unknown";
      const companyId = domainToId.get(companyKey) ?? null;

      await client.query(
        `INSERT INTO contacts (person_linkedin_url, first_name, last_name, full_name, title, email,
                               role_seniority, buyer_persona, company_id, microsegment_id, microsegment_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (person_linkedin_url)
         DO UPDATE SET
           title = COALESCE(EXCLUDED.title, contacts.title),
           email = COALESCE(EXCLUDED.email, contacts.email),
           role_seniority = COALESCE(EXCLUDED.role_seniority, contacts.role_seniority),
           company_id = COALESCE(EXCLUDED.company_id, contacts.company_id),
           microsegment_id = EXCLUDED.microsegment_id,
           microsegment_label = EXCLUDED.microsegment_label`,
        [
          row.person_linkedin_url,
          row.first_name,
          row.last_name,
          row.full_name,
          row.title,
          row.email,
          row.role_seniority,
          row.buyer_persona,
          companyId,
          row.microsegment_id,
          row.microsegment_label,
        ],
      );
      contactCount++;
      if (contactCount % 500 === 0) {
        console.log(`  ... ${contactCount} contacts upserted`);
      }
    }

    await client.query("COMMIT");
    console.log(
      `Seed complete: ${companyCount} companies, ${contactCount} contacts`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", err);
    throw err;
  } finally {
    client.release();
  }

  await shutdown();
}

const program = new Command()
  .name("seed-from-compass")
  .description("Export enriched contacts from MXD Compass SQLite → PostgreSQL")
  .option(
    "--microsegment <id>",
    "Only seed contacts from this microsegment (default: all active)",
  )
  .option("--dry-run", "Preview without writing to PG", false)
  .action(seed);

program.parse();
