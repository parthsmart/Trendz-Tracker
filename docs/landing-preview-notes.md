# Public homepage release notes

The homepage ships at `/landing.html` on Trendz Tracker. The root (`/`) serves the portal sign-in page. Every student sign-in link opens the portal. The existing Trendz Abacus domain remains the source for the linked legacy pages until a separate domain cutover.

Files: `landing.html`, `css/landing.css`, `js/landing.js`, `public/landing/img/` (local WebP copies). The new page is listed in `vite.config.ts` and in `NAV_STAGE_AND_PUBLIC_ALLOWLIST`.

## Assets used

**Hero:** `photos/jr-mcwc-2018-1.jpg`

**Gallery, 8 featured photos:** jr-mcwc-2019-2, 2016-5, 2017-4, 2016-1, 2018-6, 2019-1, 2017-1, and `legacy-additions/Vision.jpg`

**Gallery, 11 more behind "View all":** jr-mcwc-2016-2, 2016-4, 2017-3, 2017-5, 2018-2, 2018-4, 2019-4, 2019-6, International_Community_2, Life-Skill-Dev, and `legacy-additions/Soft-Skills.jpg`

**Course cards:** Mental-Math-Training-Program, Mental-Math-Program, Teacher-Training-Program. These are only 300 px wide.

**Records:** LBR_2018_Cover, LBR_2019_Cover

**3D abacus:** a CSS model of `legacy-additions/abacus.jpg`. The photo itself is not used.

**Videos:** EvzeeWWAhJo, 5q7GMolDF04 and KDob6ngPPCs are featured. 9n5aFuF6Ga8, wIBqaQznqKc, pjP4H5epvHc and 9ZSjABayEsU appear as archive links.

**Left out:** nc1/nc2 posters (expired registration details), Mission.jpg (duplicates jr-mcwc-2018-6), International_Community_1 (duplicates jr-mcwc-2018-4), illustrations, the franchise stock image, and the Limca inner-page scans.

## Content review

- Trendz confirmed permission to republish the student photos and Limca covers on the homepage and in the public repository on 25 November 2026.
- **Captions:** the year comes from each file name. The descriptions are based on what each photo shows and need a check.
- **Records claim:** confirm "Trendz students' performances recorded in Limca editions including 2018 and 2019". No headline counters were used (590+ records, 37 champions, 10000+ students, "4 years in a row", "since 2006").
- **Courses:** no age ranges or course details are published. The old site says ages 5–18.
- **Practice-session outline:** the four steps describe typical abacus practice and need a Trendz teacher to check them.
- **Contacts:** WhatsApp +91 86962 84696, phone +91 86969 16411 and trendzeducation@gmail.com come from the old site. Confirm these are still current and who answers enquiries.
- **YouTube channel:** the link is @trendzabacus9591. The old site links channel UCZW68wVod9C9df9jlVb6hGQ. Confirm both are the same official channel.

## Legacy destinations needing a decision or redirect

| Old URL | Preview handling |
| --- | --- |
| InternationalPerformance.aspx, NationalRecords.aspx, Trendz-Abacus.aspx | Linked from the footer. They will need redirects or new pages when the domain moves. |
| BusinessOpportunity.aspx (franchise / teacher training) | Linked from the footer as "Teacher training & franchise". |
| OnlineForm.aspx (enquiry form) | Replaced by WhatsApp, phone and email. Redirect to `/landing.html#enquire`. |
| abacus.aspx, MiraculousPerformances.aspx, OurSponsors.aspx | Not linked. Decide whether to keep, merge or redirect. |
| 17NationalCompetition.aspx, "14 Competition Flyer.pdf" | Left out because they are expired. Archive or redirect them. |
| SelectTest.aspx / testLogin.aspx (old online test login) | Not linked. Redirect to `/` (Trendz Tracker sign-in) if it is retired. |
| Twitter link | Not carried over. Confirm whether the account is still active. |
