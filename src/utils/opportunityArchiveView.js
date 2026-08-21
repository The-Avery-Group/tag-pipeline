export const OPPORTUNITY_PRIMARY_TABS = ['All', 'Responses', 'Expiring', 'Tracked', 'New']

export function resolveOpportunityListView(searchParams) {
  const requested = searchParams.get('tab')
  const normalized = requested === 'RFIs' ? 'Responses' : requested === 'Archive' ? 'All' : requested
  const activeTab = OPPORTUNITY_PRIMARY_TABS.includes(normalized) ? normalized : 'All'
  return {
    activeTab,
    showArchived: activeTab !== 'New' && (searchParams.get('archived') === '1' || requested === 'Archive'),
  }
}
