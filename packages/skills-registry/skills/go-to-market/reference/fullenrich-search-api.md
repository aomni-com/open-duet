# FullEnrich Search API Reference

> **Relevance caveat:** People search filters (including `current_company_names` with `exact_match: true`) can return noisy hits whose current employer doesn't actually match. Before trusting a result, verify `employment.current.company.domain` (or `.name`) against the company you filtered on, especially for outbound or list-building use cases.

## People Search

Search for people with company, person, and position filters. Costs 0.25 credits per result.

```
POST /people/search
```

### Request

```bash
curl -X POST $DUET_API_URL/v1/services/fullenrich/api/v2/people/search \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 20,
    "offset": 0,
    "current_company_names": [
      {"value": "Anthropic", "exact_match": true}
    ],
    "current_position_seniority_level": [
      {"value": "C-level", "exact_match": false}
    ],
    "person_locations": [
      {"value": "San Francisco", "exact_match": false}
    ]
  }'
```

### Pagination

| Parameter      | Type    | Default | Description                                 |
| -------------- | ------- | ------- | ------------------------------------------- |
| `offset`       | integer | 0       | Skip N results (max 10,000)                 |
| `limit`        | integer | 10      | Results per page (max 100)                  |
| `search_after` | string  | —       | Cursor for pagination beyond 10,000 results |

Use the `search_after` value from the response `metadata` to paginate beyond the 10,000 offset limit.

### Filter Object Structure

Each filter is an array of objects supporting these fields:

| Field         | Type    | Description                               |
| ------------- | ------- | ----------------------------------------- |
| `value`       | string  | Search term                               |
| `exact_match` | boolean | Strict matching when true                 |
| `exclude`     | boolean | Exclude matching results when true        |
| `min`         | integer | Minimum value (for numeric range filters) |
| `max`         | integer | Maximum value (for numeric range filters) |

### Company Filters (Current Employment)

| Filter                                       | Description                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `current_company_names`                      | Company names                                                                              |
| `current_company_domains`                    | Company domains (e.g., `google.com`)                                                       |
| `current_company_professional_network_urls`  | Company LinkedIn URLs                                                                      |
| `current_company_specialties`                | Specialty keywords                                                                         |
| `current_company_industries`                 | LinkedIn-standard broad industry categories (see Company Search filters for common values) |
| `current_company_types`                      | `Public Company`, `Privately Held`, `Non-profit`                                           |
| `current_company_headquarters`               | HQ location (city/region/country)                                                          |
| `current_company_headcounts`                 | Employee range (use `min`/`max`)                                                           |
| `current_company_founded_years`              | Founding year range (use `min`/`max`)                                                      |
| `current_company_ids`                        | Specific company IDs                                                                       |
| `current_company_days_since_last_job_change` | Days since job change (use `min`/`max`)                                                    |

### Company Filters (Past Employment)

| Filter                 | Description             |
| ---------------------- | ----------------------- |
| `past_company_names`   | Former employer names   |
| `past_company_domains` | Former employer domains |

### Person Filters

| Filter                             | Description                |
| ---------------------------------- | -------------------------- |
| `person_ids`                       | Specific person IDs        |
| `person_names`                     | First, last, or full names |
| `person_professional_network_urls` | LinkedIn profile URLs      |
| `person_locations`                 | City, region, or country   |
| `person_skills`                    | Professional skills        |
| `person_universities`              | Educational institutions   |

### Position Filters

| Filter                             | Description                                                           |
| ---------------------------------- | --------------------------------------------------------------------- |
| `current_position_seniority_level` | `Entry level`, `Mid-Senior`, `Director`, `VP`, `Executive`, `C-level` |
| `current_position_titles`          | Current job titles                                                    |
| `past_position_titles`             | Former job titles                                                     |
| `current_position_years_in`        | Duration in current role (use `min`/`max` in years)                   |
| `current_company_years_at`         | Tenure at company (use `min`/`max` in years)                          |

### Response

```json
{
  "people": [
    {
      "id": "746e4816-19c8-54d8-b558-65a5a52cc85c",
      "full_name": "Enzo Romera",
      "first_name": "Enzo",
      "last_name": "Romera",
      "location": {
        "country": "United States",
        "country_code": "US",
        "city": "San Francisco",
        "region": "California"
      },
      "social_profiles": {
        "professional_network": {
          "url": "https://www.linkedin.com/in/enzo-romera",
          "handle": "enzo-romera",
          "connection_count": 500
        }
      },
      "skills": ["JavaScript", "Project Management", "Python"],
      "educations": [
        {
          "school_name": "Stanford University",
          "degree": "BS Computer Science",
          "start_at": "2015-09-01T00:00:00Z",
          "end_at": "2019-06-01T00:00:00Z"
        }
      ],
      "languages": [{ "language": "French", "code": "FR", "proficiency": "Native or Bilingual" }],
      "employment": {
        "current": {
          "title": "Senior Software Engineer",
          "is_current": true,
          "start_at": "2022-03-15T00:00:00Z",
          "company": {
            "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "name": "Anthropic",
            "domain": "anthropic.com",
            "description": "AI safety and research company",
            "year_founded": 2021,
            "headcount": 2610,
            "company_type": "Privately Held",
            "locations": {
              "headquarters": {
                "city": "San Francisco",
                "region": "California",
                "country": "United States",
                "country_code": "US"
              }
            },
            "industry": {
              "main_industry": "Software Development"
            },
            "social_profiles": {
              "professional_network": {
                "url": "https://www.linkedin.com/company/anthropic",
                "handle": "anthropic",
                "follower_count": 125000
              }
            }
          }
        },
        "all": []
      }
    }
  ],
  "metadata": {
    "total": 20523,
    "offset": 0,
    "search_after": "WzE1LjUzNDU2MywiYjQ5MDBiYmQtOTg5MS01Mzk1LWIyODUtOWEyOGNiZThjOTM3Il0="
  }
}
```

## Company Search

Search for companies with filters. Costs 0.25 credits per result.

```
POST /company/search
```

### Request

```bash
curl -X POST $DUET_API_URL/v1/services/fullenrich/api/v2/company/search \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 20,
    "offset": 0,
    "industries": [
      {"value": "Software Development", "exact_match": false}
    ],
    "headquarters_locations": [
      {"value": "San Francisco", "exact_match": false}
    ],
    "headcounts": [
      {"min": 100, "max": 1000}
    ]
  }'
```

### Filters

| Filter                      | Description                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `names`                     | Company names                                                                                                                                                                                                                                                                                         |
| `domains`                   | Company domains                                                                                                                                                                                                                                                                                       |
| `professional_network_urls` | Company LinkedIn URLs                                                                                                                                                                                                                                                                                 |
| `keywords`                  | Searches company description text. Use this for specific terms not covered by `industries` or `specialties`.                                                                                                                                                                                          |
| `specialties`               | Matches company-declared specialties (e.g., "AI Safety", "Cloud Computing"). More specific than `industries`.                                                                                                                                                                                         |
| `industries`                | LinkedIn-standard broad industry categories. Common values: `Software Development`, `IT Services and IT Consulting`, `Financial Services`, `Research Services`, `Internet Publishing`, `Telecommunications`, `Higher Education`. These are broad — use `keywords` or `specialties` to narrow further. |
| `types`                     | `Public Company`, `Privately Held`, `Non-profit`, etc.                                                                                                                                                                                                                                                |
| `headquarters_locations`    | City, region, or country                                                                                                                                                                                                                                                                              |
| `founded_years`             | Founding year range (use `min`/`max`)                                                                                                                                                                                                                                                                 |
| `headcounts`                | Employee count range (use `min`/`max`)                                                                                                                                                                                                                                                                |
| `company_ids`               | Specific company IDs                                                                                                                                                                                                                                                                                  |

Each filter supports `value`, `exact_match`, and `exclude`. Numeric filters use `min`/`max`.

### Response

```json
{
  "companies": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Anthropic",
      "domain": "anthropic.com",
      "description": "AI safety and research company",
      "year_founded": 2021,
      "headcount": 2610,
      "headcount_range": "1001-5000",
      "company_type": "Privately Held",
      "locations": {
        "headquarters": {
          "city": "San Francisco",
          "region": "California",
          "country": "United States",
          "country_code": "US"
        },
        "offices": []
      },
      "social_profiles": {
        "professional_network": {
          "url": "https://www.linkedin.com/company/anthropic",
          "handle": "anthropic",
          "follower_count": 125000
        }
      },
      "specialties": ["AI Safety", "Machine Learning"],
      "industry": {
        "main_industry": "Software Development"
      }
    }
  ],
  "metadata": {
    "total": 1523,
    "offset": 0,
    "search_after": "WzE1LjUzNDU2MywiYjQ5MDBiYmQtOTg5MS01Mzk1LWIyODUtOWEyOGNiZThjOTM3Il0="
  }
}
```

Pagination uses the same `offset`, `limit`, and `search_after` pattern as the People Search endpoint.
