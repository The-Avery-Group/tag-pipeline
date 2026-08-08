// Agency Intelligence is intentionally limited to this maintained target list.
// Add another entry here when TAG begins tracking a new agency. SAM identifiers
// are optional because the Contract Awards API can resolve the official name;
// pipeline identifiers are merged in automatically when they are available.
export const TARGET_AGENCY_GROUPS = [
  {
    department: 'Department of Defense',
    agencies: [
      { name: 'DEPT OF THE ARMY', parentName: 'DEPT OF DEFENSE', tier: 'subtier' },
      { name: 'DEFENSE LOGISTICS AGENCY', parentName: 'DEPT OF DEFENSE', tier: 'subtier' },
      { name: 'DEFENSE HEALTH AGENCY (DHA)', searchName: 'DEFENSE HEALTH AGENCY', parentName: 'DEPT OF DEFENSE', tier: 'subtier' },
      { name: 'DEFENSE COUNTERINTELLIGENCE AND SECURITY AGENCY (DCSA)', searchName: 'DEFENSE COUNTERINTELLIGENCE AND SECURITY AGENCY', parentName: 'DEPT OF DEFENSE', tier: 'subtier' },
    ],
  },
  {
    department: 'Department of Health and Human Services',
    agencies: [
      { name: 'NATIONAL INSTITUTES OF HEALTH', parentName: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES', tier: 'subtier' },
      { name: 'OFFICE OF THE ASSISTANT SECRETARY FOR FINANCIAL RESOURCES (ASFR)', searchName: 'OFFICE OF THE ASSISTANT SECRETARY FOR FINANCIAL RESOURCES', parentName: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES', tier: 'subtier' },
      { name: 'FOOD AND DRUG ADMINISTRATION', parentName: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES', tier: 'subtier' },
      { name: 'CENTERS FOR DISEASE CONTROL AND PREVENTION', parentName: 'DEPARTMENT OF HEALTH AND HUMAN SERVICES', tier: 'subtier' },
    ],
  },
  {
    department: 'Department of Veterans Affairs',
    agencies: [
      { name: 'VETERANS AFFAIRS, DEPARTMENT OF', parentName: 'VETERANS AFFAIRS, DEPARTMENT OF', tier: 'department' },
    ],
  },
  {
    department: 'National Aeronautics and Space Administration',
    agencies: [
      { name: 'NATIONAL AERONAUTICS AND SPACE ADMINISTRATION', parentName: 'NATIONAL AERONAUTICS AND SPACE ADMINISTRATION', tier: 'department' },
    ],
  },
]

export const TARGET_AGENCIES = TARGET_AGENCY_GROUPS.flatMap((group) =>
  group.agencies.map((agency) => ({ ...agency, departmentLabel: group.department })),
)
