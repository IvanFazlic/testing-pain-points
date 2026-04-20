/**
 * Seeds a handful of known-active UK tech figures as contacts in a dedicated
 * "pilot-test" microsegment. Used to validate the scrape → analyze → dashboard
 * pipeline end-to-end with real posts.
 */
import { query, shutdown } from "../src/db/connection.js";

const MS_ID = "pilot-test::active-uk-founders";
const MS_LABEL = "Pilot Test — Active UK Founders";

const CONTACTS = [
  {
    url: "https://www.linkedin.com/in/taavethinrikus",
    first: "Taavet",
    last: "Hinrikus",
    title: "Partner, Co-founder Wise",
    company: "Plural",
    domain: "plural.vc",
  },
  {
    url: "https://www.linkedin.com/in/eileenburbidge",
    first: "Eileen",
    last: "Burbidge",
    title: "Partner",
    company: "Passion Capital",
    domain: "passioncapital.com",
  },
  {
    url: "https://www.linkedin.com/in/rbranson",
    first: "Richard",
    last: "Branson",
    title: "Founder",
    company: "Virgin Group",
    domain: "virgin.com",
  },
];

for (const c of CONTACTS) {
  const coRes = await query(
    `INSERT INTO companies (display_name, primary_domain)
     VALUES ($1, $2)
     ON CONFLICT (primary_domain) WHERE primary_domain IS NOT NULL
     DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [c.company, c.domain],
  );
  const companyId = coRes.rows[0].id;

  await query(
    `INSERT INTO contacts (person_linkedin_url, first_name, last_name, full_name,
                           title, role_seniority, buyer_persona, company_id,
                           microsegment_id, microsegment_label)
     VALUES ($1, $2, $3, $4, $5, 'executive', 'company', $6, $7, $8)
     ON CONFLICT (person_linkedin_url) DO UPDATE SET
       microsegment_id = EXCLUDED.microsegment_id,
       microsegment_label = EXCLUDED.microsegment_label,
       company_id = EXCLUDED.company_id`,
    [c.url, c.first, c.last, `${c.first} ${c.last}`, c.title, companyId, MS_ID, MS_LABEL],
  );
  console.log(`Upserted: ${c.first} ${c.last} → ${c.company}`);
}

const { rows } = await query(
  `SELECT COUNT(*) AS n FROM contacts WHERE microsegment_id = $1`,
  [MS_ID],
);
console.log(`\nMicrosegment ${MS_ID} now has ${rows[0].n} contacts`);

await shutdown();
