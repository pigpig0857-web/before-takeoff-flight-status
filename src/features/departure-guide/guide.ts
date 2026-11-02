export const guideSteps = [
  {
    label: '還沒到機場',
    title: '先確認航廈，再安排出發',
    description:
      '帶好護照、訂位資料，以及目的地要求的旅行文件。先向實際承運航空公司確認報到截止時間，再為交通、報到與通關預留時間。',
    checklist: [
      '確認訂位上的日期、機場與實際承運航空公司',
      '查閱航空公司的行李與報到規定',
      '確認交通路線與抵達航廈',
    ],
  },
  {
    label: '準備報到',
    title: '找到航空公司櫃台，完成報到',
    description:
      '依現場看板找到報到櫃台，出示旅行文件並辦理行李託運。即使已網路報到，也請確認是否需要文件查驗或託運行李。',
    checklist: [
      '核對現場航班看板與報到櫃台',
      '完成文件查驗與行李託運',
      '取得登機證，確認登機時間與登機門',
    ],
  },
  {
    label: '拿到登機證',
    title: '依指標完成安檢與證照查驗',
    description:
      '準備好登機證與護照，依機場指標前往出境安全檢查，再辦理出境證照查驗。通關後，確認最新登機門位置。',
    checklist: [
      '依現場指示完成安全檢查',
      '完成出境證照查驗',
      '再次確認登機門與登機時間',
    ],
  },
  {
    label: '到登機門了',
    title: '在登機門等候，留意廣播與看板',
    description:
      '核對登機門看板上的航班號與目的地，依登機證和地勤指示登機。登機時間早於起飛時間，請勿等到起飛前才到登機門。',
    checklist: [
      '確認看板上的航班與目的地',
      '留意登機門變更與廣播',
      '依地勤指示出示登機證與證件',
    ],
  },
];
export const OFFICIAL_AIRPORT = 'https://web.taoyuan-airport.com/index.aspx';
export const OFFICIAL_GUIDE =
  'https://www.taoyuan-airport.com/go_abroad/index.html';
