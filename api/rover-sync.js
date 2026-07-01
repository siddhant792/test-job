const { createClient } = require('@supabase/supabase-js');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const ws = require('ws');

const ROVER_MRE_LIST_URL = 'https://www.rover.infrastructure.gov.au/PublishedApprovals/MREApprovals/';
const ROVER_SEV_LIST_URL = 'https://www.rover.infrastructure.gov.au/PublishedApprovals/SEVApprovals/';
const PAGE_TIMEOUT_MS = 60000;
const SEV_TOKEN_PATTERN = /SEV-\d+/gi;
const UNDER_REVIEW_LABEL = 'Under review';
const FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; RoverSync/1.0; +https://vercel.com)'
};

const PUPPETEER_USER_AGENT = 'Mozilla/5.0 (compatible; RoverSync/1.0; +https://vercel.com)';

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

const fetchHtml = async (url) => {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
};

const fetchRenderedHtml = async (url) => {
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
    ignoreHTTPSErrors: true
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(PUPPETEER_USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close();
  }
};

const resolveUrl = (href, baseUrl) => new URL(href, baseUrl).toString();

const extractPageMappingsFromHtml = (html, baseUrl, linkPattern, underReviewLabel = '') => {
  const mappings = [];

  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowPattern)) {
    const rowHtml = rowMatch[1] || '';
    const rowText = rowHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const approvalMatch = rowText.match(/\b(MRE-\d+|SEV-\d+)\b/i);
    if (!approvalMatch) continue;

    const approvalNumber = approvalMatch[1].toUpperCase();
    if (!approvalNumber.startsWith('MRE-') && !approvalNumber.startsWith('SEV-')) continue;

    const isUnderReview = underReviewLabel
      ? rowText.toLowerCase().includes(underReviewLabel.toLowerCase())
      : false;

    const hrefMatch = rowHtml.match(/href=["']([^"']+)["']/i);
    const roverUrl = hrefMatch ? resolveUrl(hrefMatch[1], baseUrl) : baseUrl;

    mappings.push({
      approvalNumber,
      roverUrl,
      isUnderReview
    });
  }

  return mappings;
};

const extractNextPageUrl = (html, baseUrl) => {
  const nextLinkMatch = html.match(/<a\b[^>]*aria-label=["']Next page["'][^>]*href=["']([^"']+)["'][^>]*>/i)
    || html.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*aria-label=["']Next page["'][^>]*>/i);

  if (!nextLinkMatch) return null;

  const href = nextLinkMatch[1];
  if (!href || href === '#') return null;

  return resolveUrl(href, baseUrl);
};

const collectMappings = async (startUrl, linkPattern, label, logger, underReviewLabel = '') => {
  const mappings = new Map();
  let currentUrl = startUrl;

  while (true) {
    const html = await fetchRenderedHtml(currentUrl);
    const pageMappings = extractPageMappingsFromHtml(html, currentUrl, linkPattern, underReviewLabel);

    logger(`[${label}] page: found ${pageMappings.length} links`);

    for (const mapping of pageMappings) {
      mappings.set(normalizeApprovalNumber(mapping.approvalNumber), {
        roverUrl: mapping.roverUrl,
        isUnderReview: mapping.isUnderReview
      });
    }

    const nextUrl = extractNextPageUrl(html, currentUrl);
    if (!nextUrl) break;

    currentUrl = nextUrl;
  }

  logger(`[${label}] completed: ${mappings.size} unique mappings collected`);
  return mappings;
};

const collectMappingsForFilter = async (
  startUrl,
  linkPattern,
  label,
  filterLabel,
  logger,
  underReviewLabel = ''
) => {
  return collectMappings(startUrl, linkPattern, label, logger, underReviewLabel);
};

const collectSevMappings = async (logger) => {
  const mappings = new Map();

  for (const [variantLabel, filterLabel] of [
    ['SEV active', FILTER_LABELS.SEV.active],
    ['SEV expired', FILTER_LABELS.SEV.expanded]
  ]) {
    logger(`Collecting Rover ${variantLabel} URLs...`);
    const variantMappings = await collectMappingsForFilter(
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

const collectMreMappings = async (logger) => {
  const activeMappings = await collectMappingsForFilter(
    ROVER_MRE_LIST_URL,
    '/PublishedApprovals/ModelReportDetails/',
    'MRE active',
    FILTER_LABELS.MRE.active,
    logger
  );

  const expandedMappings = await collectMappingsForFilter(
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

async function runRoverSync() {
  console.log('[rover-sync] start');

  const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
  const supabaseSecretKey = process.env.SECRET_KEY_SUPABASE;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error(
      'Missing REACT_APP_SUPABASE_URL or SECRET_KEY_SUPABASE environment variables.'
    );
  }

  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false },
    realtime: { enabled: false, transport: ws }
  });

  console.log('Collecting Rover MRE URLs...');
  const mreMappings = await collectMreMappings(console.log);
  console.log(`Collected ${mreMappings.size} MRE mappings.`);

  const sevMappings = await collectSevMappings(console.log);
  console.log(`Collected ${sevMappings.size} SEV mappings.`);

  console.log('Updating customer_model_reports...');
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
    console.log(
      `[MRE] unmatched approvals (${mrResult.unmatchedApprovals.length}): ${summarizeList(mrResult.unmatchedApprovals).join(', ')}`
    );
  }

  if (sevResult.unmatchedApprovals.length > 0) {
    console.log(
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
}

async function GET(request) {
  try {
    const result = await runRoverSync();
    return Response.json(result);
  } catch (error) {
    console.error('[rover-sync] failed', error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

module.exports = { GET, runRoverSync };