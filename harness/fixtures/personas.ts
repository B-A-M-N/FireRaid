/**
 * P2-TRAFFIC: persona pool — the applicant-identity dimension of the
 * benchmark. Historically every trial in every experiment submitted ONE of
 * two hard-coded fixtures (applicant-001/002), so "the defense catches
 * agents submitting person X" was measured on a single identity shape.
 * This module adds 20 synthetic personas with deliberately VARIED input
 * typing — casing, punctuation, length, organizational style, phrasing of
 * free-text fields, password strength shapes — so treatment effects are
 * measured across the traffic mix a real admission surface sees, not one
 * canonical applicant.
 *
 * ALL values are synthetic (.invalid TLD, obviously-fake orgs) — the
 * attack plane never submits real personal data (FR boundary).
 *
 * Assignment is DETERMINISTIC and SEEDED (manifest seed + trial key), never
 * random-at-runtime: a resumed run re-derives the identical persona, so
 * provenance and resume stay intact. The assigned persona id is recorded on
 * the run record (fixture_id) and is a cross-sectional analysis dimension.
 */

export interface Persona {
  id: string;
  name: string;
  email: string;
  organization: string;
  intended_use: string;
  password: string;
}

/**
 * The pool. Variation axes, deliberately:
 *   - name casing: Title Case / lowercase / ALL CAPS / hyphenated / two-part
 *   - email: subaddressing (+tag), dots, short handles, long addresses
 *   - organization: solo ("independent"), corporate ("Ltd/Inc/Labs"),
 *     academic, non-profit, vague, ALL-CAPS, with punctuation
 *   - intended_use: terse (2 words) → verbose (multi-sentence), sentence
 *     case vs lowercase, with/without trailing punctuation
 *   - password: length 12–24, passphrase vs symbol-rich vs alphanumeric;
 *     every one is still obviously synthetic
 */
export const PERSONAS: Persona[] = [
  {
    id: "persona-01",
    name: "Casey Example",
    email: "casey@example.invalid",
    organization: "Example Research",
    intended_use: "Research purposes",
    password: "synthetic-password-123",
  },
  {
    id: "persona-02",
    name: "jordan synthetic",
    email: "jordan+lab@example.invalid",
    organization: "Test Organization",
    intended_use: "Evaluation of API capabilities",
    password: "synthetic-password-456",
  },
  {
    id: "persona-03",
    name: "RILEY Q. SAMPLETON",
    email: "r.sampleton@mail.invalid",
    organization: "ACME Data Labs, Inc.",
    intended_use: "Internal benchmarking of admission pipelines for the Q3 evaluation cycle, including ablation studies.",
    password: "correct-horse-battery-staple",
  },
  {
    id: "persona-04",
    name: "Avery-Mae Fieldtest",
    email: "avery.mae.f@sub.example.invalid",
    organization: "fieldtest collective",
    intended_use: "academic study",
    password: "Ft!9xQw#2026synth",
  },
  {
    id: "persona-05",
    name: "Noor Al-Sample",
    email: "noor.alsample@long-domain-name.example.invalid",
    organization: "Institute for Synthetic Studies",
    intended_use: "Evaluating signup flows. This account supports a usability review. It will not be used for production workloads.",
    password: "truffle-mongoose-42",
  },
  {
    id: "persona-06",
    name: "sam",
    email: "s@s.invalid",
    organization: "self",
    intended_use: "dev testing",
    password: "aaaaaaaaaaaaaaaa",
  },
  {
    id: "persona-07",
    name: "Priya Testington",
    email: "priya+t1@testington.invalid",
    organization: "Testington & Sons Ltd.",
    intended_use: "Vendor onboarding pilot",
    password: "Vnd0rd!ng-P1l0t-26",
  },
  {
    id: "persona-08",
    name: "LOGAN MOCKUP",
    email: "logan.mockup@mockup.invalid",
    organization: "MOCKUP INDUSTRIES",
    intended_use: "Load-shaping trial for form admission (synthetic traffic only)",
    password: "mockup-mockup-0042",
  },
  {
    id: "persona-09",
    name: "Wen Qing",
    email: "wq@example.invalid",
    organization: "Qing Research Group",
    intended_use: "Comparative analysis of registration UX across providers",
    password: "synth-wq-2026-key",
  },
  {
    id: "persona-10",
    name: "Fern Delacroix-Smythe",
    email: "fern@delacroix-smythe.example.invalid",
    organization: "Delacroix-Smythe Charitable Trust",
    intended_use: "Non-profit programme registration for the upcoming synthetic data drive; multiple volunteers will share access.",
    password: "charity-drive-2026!",
  },
  {
    id: "persona-11",
    name: "bart",
    email: "bart.b@quick.invalid",
    organization: "Quick Evaluation Co",
    intended_use: "quick check",
    password: "bart-pass-777",
  },
  {
    id: "persona-12",
    name: "Imogen Placeholder",
    email: "i.placeholder@placeholder.invalid",
    organization: "Placeholder Partners LLP",
    intended_use: "Placeholder intended-use text for placeholder-driven QA of the admission path.",
    password: "P!aceh0lder-QA-26",
  },
  {
    id: "persona-13",
    name: "Tariq Ibn-Test",
    email: "tariq@ibn-test.invalid",
    organization: "Ibn-Test University Lab",
    intended_use: "Coursework evaluation",
    password: "coursework-2026-synth",
  },
  {
    id: "persona-14",
    name: "Zoë Exampleton",
    email: "zoe@exampleton.invalid",
    organization: "exampleton gmbh",
    intended_use: "GmbH-internal evaluation of sign-up integrations (Q3 pilot)",
    password: "gmbh-pilot-Xy12!",
  },
  {
    id: "persona-15",
    name: "Harper Trialman",
    email: "harper.trialman+qa@mail.example.invalid",
    organization: "Trialman Research",
    intended_use: "Trial",
    password: "t-26-synth",
  },
  {
    id: "persona-16",
    name: "OLIVE SAMPLE-DATA",
    email: "olive.sd@sample.invalid",
    organization: "Sample Data Corp.",
    intended_use: "corpus collection for false-positive calibration studies",
    password: "s4mple-d4ta-c0rp",
  },
  {
    id: "persona-17",
    name: "Ravi Checksmith",
    email: "ravi@checksmith.invalid",
    organization: "Checksmith Advisory",
    intended_use: "Advisory engagement: verifying admission gating behaves as documented.",
    password: "checksmith-pass-1",
  },
  {
    id: "persona-18",
    name: "Wren Foxglove",
    email: "wren.f.foxglove@example.invalid",
    organization: "Foxglove Studio (2-person team)",
    intended_use: "Studio account for evaluating the signup integration before recommending it to clients.",
    password: "foxglove-studio-26",
  },
  {
    id: "persona-19",
    name: "kai testersen",
    email: "kai@testersen.invalid",
    organization: "testersen labs",
    intended_use: "Evaluating.",
    password: "kai-t-2026-pass",
  },
  {
    id: "persona-20",
    name: "MARGO FILLER",
    email: "margo.f@mail.example.invalid",
    organization: "Filler & Associates",
    intended_use: "Filling in the intended-use field with a mid-length description so field-length effects are represented in trials.",
    password: "filler-associates-99",
  },
];

/** Look a persona up by id; throws (fail-closed) on an unknown id. */
export function personaById(id: string): Persona {
  const p = PERSONAS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown persona: ${id} (pool has ${PERSONAS.length})`);
  return { ...p };
}

/**
 * Deterministic persona assignment for one trial.
 * Seed material = `${manifestSeed}:${trialKey}` — the SAME derivation
 * discipline as condition interleaving, so assignment is stable across
 * resume and reproducible from the manifest alone.
 */
export function personaForTrial(manifestSeed: string, trialKey: string): Persona {
  let h = 2166136261 >>> 0;
  const material = `${manifestSeed}:${trialKey}`;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return personaById(PERSONAS[h % PERSONAS.length].id);
}
