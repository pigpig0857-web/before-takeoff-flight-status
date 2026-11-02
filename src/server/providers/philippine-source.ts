// Reviewed official editions; changed/new editions require evidence review.
export const philippineIndex =
  'https://www.philippineairlines.com/ph/en/flight-timetable-page.html';
// The public Angular/AEM page converts its .html URL to .model.json.
export const philippinePublication =
  'https://www.philippineairlines.com/ph/en/flight-timetable-page.model.json';
export const philippinePDFs = [
  {
    url: 'https://www.philippineairlines.com/content/dam/palportal/migration/feature/timetable/261009-INTL-SUMMER-TIMETABLE-of-Oct-09-2026.pdf',
    from: '2026-03-29',
    through: '2026-10-24',
    page: 3,
  },
  {
    url: 'https://www.philippineairlines.com/content/dam/palportal/migration/feature/timetable/261009-INTL-WINTER-TIMETABLE-as-of-Oct-9-2026.pdf',
    from: '2026-10-25',
    through: '2027-03-27',
    page: 4,
  },
] as const;
