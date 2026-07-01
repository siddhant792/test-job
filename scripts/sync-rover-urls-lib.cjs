const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

const ROVER_MRE_LIST_URL = 'https://www.rover.infrastructure.gov.au/PublishedApprovals/MREApprovals/';
const ROVER_SEV_LIST_URL = 'https://www.rover.infrastructure.gov.au/PublishedApprovals/SEVApprovals/';
const PAGE_TIMEOUT_MS = 60000;
const SEV_TOKEN_PATTERN = /SEV-\d+/gi;

const UNDER_REVIEW_LABEL = 'Under review';

const FILTER_LABELS = {
  MRE: {
    active: 'In Force Approvals',
    expanded: 'All Approvals'
  },
  SEV: {
    active: 'In Force Entries',
    expanded: 'Expired Entries'
  }
};

const normalizeApprovalNumber = (value) => (value || '').trim().toUpperCase();

const extractSevApprovalNumbers = (value) => {
  const matches = String(value || '').match(SEV_TOKEN_PATTERN);
  return matches ? [...new Set(matches.map(normalizeApprovalNumber))] : [];
};

const summarizeList = (values, limit = 25) => {
  if (values.length <= limit) return values;
  return [...values.slice(0, limit), `...and ${values.length - limit} more`];
};

const waitForGridRows = async (page, linkPattern) => {
  await page.waitForFunction(
    (pattern) =>
      Array.from(document.querySelectorAll('a[href]')).some((a) =>
        a.getAttribute('href')?.includes(pattern)
      ),
    linkPattern,
    { timeout: PAGE_TIMEOUT_MS }
  );
};

const waitForGridRefreshAfterFilter = async (page) => {
  await page.waitForTimeout(800);
  await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForFunction(
    () => {
      const spinners = document.querySelectorAll(
        '.loading-overlay, .entity-list-loading, [class*="loading"]:not([class*="unloading"])'
      );
      return !Array.from(spinners).some((el) => el.offsetParent !== null);
    },
    { timeout: PAGE_TIMEOUT_MS }
  ).catch(() => undefined);
};

const clickFilterByLabel = async (page, label, logger) => {
  const dropdownToggleSelectors = [
    'button.btn-filter',
    'button.dropdown-toggle[data-toggle="dropdown"]',
    'a.dropdown-toggle[data-toggle="dropdown"]',
    '[data-toggle="dropdown"]'
  ];

  let opened = false;
  for (const sel of dropdownToggleSelectors) {
    const toggle = page.locator(sel).first();
    if (await toggle.count()) {
      await toggle.click();
      opened = true;
      break;
    }
  }

  if (!opened) {
    logger?.(`[filter] could not find dropdown toggle for label "${label}"`);
    return false;
  }

  await page.waitForSelector('.dropdown-menu', { state: 'visible', timeout: 5000 }).catch(() => undefined);

  const filterLink = page
    .locator('.dropdown-menu a.filterlink, .dropdown-menu li a')
    .filter({ hasText: label })
    .first();

  if (await filterLink.count()) {
    await filterLink.click();
    await waitForGridRefreshAfterFilter(page);
    logger?.(`[filter] applied "${label}" via .filterlink`);
    return true;
  }

  const fallback = page.getByText(label, { exact: true }).first();
  if (await fallback.count()) {
    await fallback.click();
    await waitForGridRefreshAfterFilter(page);
    logger?.(`[filter] applied "${label}" via text fallback`);
    return true;
  }

  logger?.(`[filter] label "${label}" not found in dropdown`);
  return false;
};

const extractCurrentPageMappings = async (page, linkPattern, underReviewLabel = '') => {
  return page.evaluate(
    ({ pattern, reviewLabel }) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const mappings = [];

      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const label = (anchor.textContent || '').trim().toUpperCase();

        if (!href.includes(pattern)) continue;
        if (!label.startsWith('MRE-') && !label.startsWith('SEV-')) continue;

        const cell = anchor.closest('td, [role="gridcell"]') || anchor.parentElement;
        const cellText = (cell?.textContent || '').trim();
        const isUnderReview = reviewLabel
          ? cellText.toLowerCase().includes(reviewLabel.toLowerCase())
          : false;

        mappings.push({
          approvalNumber: label,
          roverUrl: new URL(href, window.location.origin).toString(),
          isUnderReview
        });
      }

      return mappings;
    },
    { pattern: linkPattern, reviewLabel: underReviewLabel }
  );
};

const getCurrentPageNumber = async (page) => {
  return page.evaluate(() => {
    const currentLink = Array.from(document.querySelectorAll('a[role="button"], button')).find(
      (el) => el.getAttribute('aria-current') === 'page'
    );
    return currentLink ? Number(currentLink.textContent?.trim()) : 1;
  });
};

const goToNextPage = async (page, currentPageNumber) => {
  const nextPageState = await page.evaluate(() => {
    const nextLink = document.querySelector('a.entity-pager-next-link[aria-label="Next page"]');
    const parentItem = nextLink?.closest('li');
    return {
      exists: Boolean(nextLink),
      disabled: parentItem?.classList.contains('disabled') ?? true
    };
  });

  if (!nextPageState.exists || nextPageState.disabled) return false;

  await page.locator('a.entity-pager-next-link[aria-label="Next page"]').click();
  await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForFunction(
    (pageNumber) => {
      const currentLink = Array.from(document.querySelectorAll('a[role="button"], button')).find(
        (el) => el.getAttribute('aria-current') === 'page'
      );
      return Number(currentLink?.textContent?.trim()) > pageNumber;
    },
    currentPageNumber,
    { timeout: PAGE_TIMEOUT_MS }
  );
  return true;
};

const collectMappings = async (page, startUrl, linkPattern, label, logger, underReviewLabel = '') => {
  const mappings = new Map();

  await waitForGridRows(page, linkPattern);

  while (true) {
    const currentPageNumber = await getCurrentPageNumber(page);
    const pageMappings = await extractCurrentPageMappings(page, linkPattern, underReviewLabel);

    logger(`[${label}] page ${currentPageNumber}: found ${pageMappings.length} links`);

    for (const mapping of pageMappings) {
      mappings.set(normalizeApprovalNumber(mapping.approvalNumber), {
        roverUrl: mapping.roverUrl,
        isUnderReview: mapping.isUnderReview
      });
    }

    const moved = await goToNextPage(page, currentPageNumber);
    if (!moved) break;

    await waitForGridRows(page, linkPattern);
  }

  logger(`[${label}] completed: ${mappings.size} unique mappings collected`);
  return mappings;
};

const collectMappingsForFilter = async (
  page,
  startUrl,
  linkPattern,
  label,
  filterLabel,
  logger,
  underReviewLabel = ''
) => {
  await page.goto(startUrl, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT_MS
  });

  await waitForGridRows(page, linkPattern);

  if (filterLabel) {
    const switched = await clickFilterByLabel(page, filterLabel, logger);
    logger(
      `[${label}] filter "${filterLabel}": ${switched ? 'applied' : 'not found — using default view'}`
    );

    if (switched) {
      await waitForGridRows(page, linkPattern);
    }
  }

  return collectMappings(page, page.url(), linkPattern, label, logger, underReviewLabel);
};

const collectSevMappings = async (page, logger) => {
  const mappings = new Map();

  for (const [variantLabel, filterLabel] of [
    ['SEV active', FILTER_LABELS.SEV.active],
    ['SEV expired', FILTER_LABELS.SEV.expanded]
  ]) {
    logger(`Collecting Rover ${variantLabel} URLs...`);
    const variantMappings = await collectMappingsForFilter(
      page,
      ROVER_SEV_LIST_URL,
      '/PublishedApprovals/SEVDetails/',
      variantLabel,
      filterLabel,
      logger,
      UNDER_REVIEW_LABEL
    );

    for (const [approvalNumber, value] of variantMappings.entries()) {
      mappings.set(approvalNumber, value);
    }
  }

  return mappings;
};

const collectMreMappings = async (page, logger) => {
  const activeMappings = await collectMappingsForFilter(
    page,
    ROVER_MRE_LIST_URL,
    '/PublishedApprovals/ModelReportDetails/',
    'MRE active',
    FILTER_LABELS.MRE.active,
    logger
  );

  const expandedMappings = await collectMappingsForFilter(
    page,
    ROVER_MRE_LIST_URL,
    '/PublishedApprovals/ModelReportDetails/',
    'MRE all',
    FILTER_LABELS.MRE.expanded,
    logger
  );

  const mappings = new Map(activeMappings);
  for (const [approvalNumber, value] of expandedMappings.entries()) {
    mappings.set(approvalNumber, value);
  }

  return mappings;
};

const updateCustomerModelReports = async (
  supabase,
  sourceColumn,
  targetColumn,
  mappings,
  underReviewColumn = null
) => {
  const selectColumns = [`id`, sourceColumn, targetColumn];
  if (underReviewColumn) selectColumns.push(underReviewColumn);

  const { data, error } = await supabase
    .from('customer_model_reports')
    .select(selectColumns.join(', '))
    .not(sourceColumn, 'is', null);

  if (error) throw error;

  let updatedCount = 0;
  const unmatchedApprovals = [];

  for (const row of data || []) {
    const sourceValue = row[sourceColumn];
    const approvalNumbers =
      sourceColumn === 'sevs_entry'
        ? extractSevApprovalNumbers(sourceValue)
        : [normalizeApprovalNumber(sourceValue)].filter(Boolean);

    if (approvalNumbers.length === 0) continue;

    const matchedEntries = approvalNumbers
      .map((approvalNumber) => ({
        approvalNumber,
        entry: mappings.get(approvalNumber) || null
      }))
      .filter((item) => item.entry);

    const missingApprovals = approvalNumbers.filter(
      (approvalNumber) => !mappings.has(approvalNumber)
    );
    unmatchedApprovals.push(...missingApprovals);

    if (matchedEntries.length === 0) continue;

    const nextValue =
      sourceColumn === 'sevs_entry'
        ? matchedEntries.map((item) => item.entry.roverUrl).join(' | ')
        : matchedEntries[0].entry.roverUrl;

    const updatePayload = { updated_at: new Date().toISOString() };
    let hasChange = false;

    if (row[targetColumn] !== nextValue) {
      updatePayload[targetColumn] = nextValue;
      hasChange = true;
    }

    if (underReviewColumn) {
      const nextUnderReview = matchedEntries.some((item) => item.entry.isUnderReview);

      if (Boolean(row[underReviewColumn]) !== nextUnderReview) {
        updatePayload[underReviewColumn] = nextUnderReview;
        hasChange = true;
      }
    }

    if (!hasChange) continue;

    const { error: updateError } = await supabase
      .from('customer_model_reports')
      .update(updatePayload)
      .eq('id', row.id);

    if (updateError) throw updateError;
    updatedCount += 1;
  }

  return {
    updatedCount,
    unmatchedApprovals: [...new Set(unmatchedApprovals)].sort()
  };
};

const runRoverUrlSync = async ({
  supabaseUrl,
  supabaseSecretKey,
  headed = false,
  logger = console.log
}) => {
  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error(
      'Missing SUPABASE_URL/REACT_APP_SUPABASE_URL or SECRET_KEY_SUPABASE environment variables.'
    );
  }

  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false }
  });

  const browser = await chromium.launch({ headed });
  const page = await browser.newPage();

  try {
    logger('Collecting Rover MRE URLs...');
    const mreMappings = await collectMreMappings(page, logger);
    logger(`Collected ${mreMappings.size} MRE mappings.`);

    const sevMappings = await collectSevMappings(page, logger);
    logger(`Collected ${sevMappings.size} SEV mappings.`);

    logger('Updating customer_model_reports...');
    const mrResult = await updateCustomerModelReports(
      supabase,
      'mr_approval',
      'mr_approval_rover_url',
      mreMappings
    );
    const sevResult = await updateCustomerModelReports(
      supabase,
      'sevs_entry',
      'sevs_entry_rover_url',
      sevMappings,
      'sev_under_review'
    );

    if (mrResult.unmatchedApprovals.length > 0) {
      logger(
        `[MRE] unmatched approvals (${mrResult.unmatchedApprovals.length}): ${summarizeList(mrResult.unmatchedApprovals).join(', ')}`
      );
    }

    if (sevResult.unmatchedApprovals.length > 0) {
      logger(
        `[SEV] unmatched approvals (${sevResult.unmatchedApprovals.length}): ${summarizeList(sevResult.unmatchedApprovals).join(', ')}`
      );
    }

    return {
      message: 'Rover URLs synced successfully',
      updatedMrApprovals: mrResult.updatedCount,
      updatedSevsEntries: sevResult.updatedCount,
      totalMrMappings: mreMappings.size,
      totalSevMappings: sevMappings.size,
      unmatchedMrApprovals: mrResult.unmatchedApprovals,
      unmatchedSevsEntries: sevResult.unmatchedApprovals
    };
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
};

module.exports = { runRoverUrlSync };