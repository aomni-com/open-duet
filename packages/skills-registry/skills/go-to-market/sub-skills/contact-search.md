# Researching a Person

Turn a name into a one-page professional dossier: a confirmed identity, a work history, a face, and the contact channels the user is allowed to spend on. Also the method for choosing *which* people at an account are worth a dossier at all.

## Input

- **Contact name**: full name of the person
- **Company name** or **domain**: where they work now
- **Contact title** (optional): job title if known
- **LinkedIn URL** (optional): a precise identifier to verify against the returned profile

## Step 1: Confirm the person before contact enrichment

Every downstream call inherits this decision. A wrong match produces a dossier that is entirely well-sourced and entirely about somebody else, and the email and the photo are what make it convincing.

**With a LinkedIn URL**, use Person Enrichment (`POST /person/enrich` with a `professional_network_profile_urls` array) — see [../reference/crustdata-people-api.md](../reference/crustdata-people-api.md). Verify the returned match and profile URL; an empty match is not an identity confirmation.

**With a name and company**, search first: FullEnrich `POST /people/search` with `person_names` plus `current_company_names` or `current_company_domains` ([../reference/fullenrich-search-api.md](../reference/fullenrich-search-api.md)) is the cheap way to list candidates, or Crustdata `POST /person/search` when you already work in Crustdata ids. Search filters are noisy: verify the returned employer domain against the filter: FullEnrich uses `employment.current.company.domain`; Crustdata search uses `experience.employment_details.current[].company_website` (normalize the URL to its hostname; enrichment also returns `company_website_domain`).

Then decide by how many candidates survive verification:

| Survivors | Action |
| --- | --- |
| Exactly one | Proceed. Record the profile URL as the identity key. |
| Two or more | Stop. Show name, current title, employer, and profile URL for each, and let the user pick. |
| None | Stop and say so. Do not fall back to the closest name. |

Common names, common employers, and people who changed jobs this quarter are where this fails. Use `POST /person/professional_network/enrich/live` deliberately when the database copy looks stale; it costs more and uses the identifier-array body from the People API reference.

## Step 2: Build the work history

For Crustdata, explicitly request `experience`, `education`, and `skills` alongside `basic_profile` and `social_handles`. Read the selected `matches[].person_data`: roles are in `experience.employment_details.current[]` and `.past[]`, education in `education.schools`, and skills in `skills.professional_network_skills`. FullEnrich returns the same substance as `profile.employment.all` — but only when a LinkedIn URL was the input, so a search-only contact has no employment history until you enrich the URL the search returned.

Normalize every position to `title`, `company`, `start`, `end` and keep them newest-first. Leave a missing date empty. Do not compute a tenure that the dates do not support, and do not smooth a gap: an unexplained gap is a fact about the record, not an error to fix.

## Step 3: Get a face

A dossier is read by somebody about to meet this person, so a photo does real work. Two sources, both optional, neither worth a second call if the first lands:

**LinkedIn** — `basic_profile.profile_picture_permalink` under the matched Crustdata `person_data`. Download the returned image and keep a local file for the dossier:

```bash
curl -sSL --max-time 20 "<profile_picture_permalink>" -o avatar.jpg
```

**X** — resolve the handle with `GET /twitter/search-users?query=` then read the profile with `GET /twitter/user/{handle}`; the user object carries the avatar as `profile_image_url_https`, and swapping the `_normal` suffix for `_400x400` gets the full-size original. See the `socialapi` skill for auth and cost. Read the object rather than assuming a field is present.

**Attach a photo only to a confirmed handle.** A LinkedIn avatar inherits the identity confirmation from step 1 and is safe. An X handle does not: matching a name is not matching a person, and the wrong face is the one error in a dossier a reader will never catch. Accept a handle only when the profile itself ties it to the person — the employer in the bio, a link to the same company site, or a link from their LinkedIn — and otherwise ship the dossier without one. Record which source the photo came from and the profile URL it came from, so the reader can check it.

## Step 4: Enrich the contact channels

`POST /contact/enrich/bulk` with `enrich_fields`, then poll `GET /contact/enrich/bulk/{id}` until `FINISHED` ([../reference/fullenrich-enrich-api.md](../reference/fullenrich-enrich-api.md)). Batch every person you already intend to research into one call.

| Field | When |
| --- | --- |
| `contact.work_emails` | Default. Cheapest field, and the one the user asked for. |
| `contact.personal_emails` | Only when work email came back `unfound` and the user wants a personal address. |
| `contact.phones` | **Only on the user's explicit word.** An order of magnitude dearer than a work email — the most expensive field in this API. |

Never bundle phones into the default enrichment because you expect to be asked. Ask, or expose a per-person action the user triggers, and enrich one person at a time when they do.

Carry the provider's own verdict through to the deliverable rather than flattening it. `DELIVERABLE` was verified; `HIGH_PROBABILITY` and `CATCH_ALL` were not, and a reader planning a first-touch email needs to know which one they are holding. An address the provider did not return is `unfound` — never a pattern you assembled from `first.last@domain`.

Re-enriching a person already in the artifacts costs money and buys nothing; FullEnrich retains a result for three months.

## Step 5: Corroborate with public activity

Structured data says what someone's title is. Public activity says what they are working on, which is the half a reader can actually open a conversation with.

- LinkedIn posts: `POST /social_post/professional_network/enrich/live` with `professional_network_profile_url` and `limit: 10` in the JSON body ([../reference/crustdata-linkedin-api.md](../reference/crustdata-linkedin-api.md)).
- X: their recent posts through the `socialapi` skill, once the handle is confirmed.
- Web search, three queries — these reach what no people database holds:
  1. `"<Full Name>" "<Company>" interview OR podcast OR conference` — what they say out loud
  2. `"<Full Name>" "<Company>" article OR blog OR wrote` — what they publish
  3. `"<Full Name>" <industry keywords>` — where they show up in their field

WebFetch anything that looks substantive — a talk, an article, a podcast page — and take the topics, the positions they argued, the problems they named, and the priorities they stated. A search snippet is a pointer; open the page before quoting from it.

Keep what is dated, attributable, and professional. **A professional dossier covers the professional record.** Home address, family, health, politics, religion, and anything about their private life stay out of it — no matter how public the source — because none of it belongs in a document about doing business with someone.

## Step 6: Write the one-pager

Fill [../templates/contact-dossier.md](../templates/contact-dossier.md). It is one page on purpose: a reader skims it in the minute before a call. Everything on it is retrieved, `unfound`, or explicitly labelled as inference.

## Recommending who to contact at an account

When the deliverable is a contact *set* rather than one person — the buying group for a named account — the ranking is the work, not the search.

1. **Derive the personas from the seller's solution.** Which functions feel the problem, which one signs, which one blocks. Without solution context this is unanswerable; ask for it rather than defaulting to "VP Sales, CTO, CFO".
2. **Search once, wide.** `POST /people/search` filtered by `current_company_domains` plus `current_position_seniority_level` and `current_position_titles`, `limit` 20–30. Results cost per result, so one well-built query beats five narrow ones.
3. **Verify the employer on every hit** before it enters the set, per the caveat above.
4. **Rank, then cut to 5–10.** Score each candidate on fit to the evidenced problem, seniority relative to the decision, and whether anything public ties them to it. A set of ten VPs from one department is one contact repeated ten times: cover the *roles* — an owner of the problem, an economic buyer, and a practitioner who will be asked to evaluate.
5. **Enrich the survivors in one batch.** Work emails for the whole set in a single call; phones never as part of it.
6. **Say why each person is on the list**, in one line tied to a retrieved fact. "VP Engineering" is a title, not a reason. If nothing about a candidate connects to the account's evidenced problem, they are a name, and the list is better without them.

## Quality checklist

- [ ] Exactly one candidate survived identity verification, or the user chose
- [ ] Work history is newest-first with dates as retrieved, gaps intact
- [ ] The photo's source and profile URL are recorded, or there is no photo
- [ ] Email carries the provider's verification status, and `unfound` is written as `unfound`
- [ ] No phone was enriched without the user asking for it
- [ ] Every public-activity claim is dated and links to something opened
- [ ] Nothing on the page is about the person's private life
- [ ] For a contact set: 5–10 people, distinct roles, one evidenced reason each

## When the record is thin

Some people barely exist online, and that is a finding rather than a failure. Say what was searched and what came back empty, keep the role-based reading of what they likely own, and recommend the approach that suits a cold record — a warm introduction or an event over a cold email built on nothing.
