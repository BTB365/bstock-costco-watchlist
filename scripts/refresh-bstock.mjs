import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url);
const DATA_PATH = new URL('../data/listings.json', import.meta.url);
const WATCHLIST_URL = process.env.BSTOCK_SAVED_SEARCH_URL || 'https://bstock.com/all-auctions?savedSearchId=696e3b9488671096827bcdd8';
const EMAIL = process.env.BSTOCK_EMAIL;
const PASSWORD = process.env.BSTOCK_PASSWORD;
const HEADLESS = process.env.HEADLESS !== 'false';
const MAX_LISTINGS = Number(process.env.MAX_LISTINGS || 60);

const money = s => Number(String(s || '').replace(/[^0-9.]/g, '')) || 0;
const int = s => Number(String(s || '').replace(/[^0-9]/g, '')) || 0;
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const uniq = xs => [...new Set(xs.filter(Boolean))];

function readExistingCache(existing) {
  const itemImages = new Map();
  const listingImages = new Map();
  for (const l of existing?.listings || []) {
    if (l.id && l.images?.length) listingImages.set(l.id, l.images);
    for (const i of l.items || []) {
      if (i.item && i.img) itemImages.set(String(i.item), { img: i.img, imgSource: i.imgSource || 'previous verified image' });
    }
  }
  return { itemImages, listingImages };
}

async function existingData() {
  try { return JSON.parse(await fs.readFile(DATA_PATH, 'utf8')); }
  catch { return { listings: [] }; }
}

async function deleteGeneratedListingFiles() {
  const dataDir = new URL('../data/', import.meta.url);
  try {
    const names = await fs.readdir(dataDir);
    await Promise.all(names.filter(n => /^listing\d+\.json$/.test(n)).map(n => fs.unlink(new URL(n, dataDir)).catch(() => {})));
  } catch {}
}

async function safeClick(page, selector, opts={}) {
  const loc = page.locator(selector).first();
  if (await loc.count()) {
    try { await loc.click({ timeout: opts.timeout || 2500 }); return true; } catch {}
  }
  return false;
}

async function loginIfNeeded(page) {
  if (!EMAIL || !PASSWORD) throw new Error('Missing BSTOCK_EMAIL/BSTOCK_PASSWORD GitHub secrets.');
  await page.goto(WATCHLIST_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  // Cookie / privacy banners are safe to accept and otherwise block buttons sometimes.
  await safeClick(page, 'button:has-text("Accept")');
  await safeClick(page, 'button:has-text("I agree")');

  const needsLogin = await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"], input[type="password"]').count();
  if (!needsLogin && !/login|signin|auth/i.test(page.url())) return;

  const email = page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"], input#email').first();
  if (await email.count()) await email.fill(EMAIL, { timeout: 15000 });
  await safeClick(page, 'button:has-text("Continue"), button:has-text("Next"), input[type="submit"]');
  await page.waitForTimeout(1500);

  const pass = page.locator('input[type="password"], input[name*="password" i], input[autocomplete="current-password"]').first();
  if (await pass.count()) await pass.fill(PASSWORD, { timeout: 15000 });
  const submitted = await safeClick(page, 'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), button:has-text("Continue"), input[type="submit"]', { timeout: 5000 });
  if (!submitted) await page.keyboard.press('Enter');
  await page.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(()=>{});
  await page.waitForTimeout(6000);

  const body = await page.textContent('body').catch(()=> '') || '';
  if (/captcha|verify you are human|checking your browser/i.test(body)) {
    throw new Error('BStock/Cloudflare presented a human verification challenge; scheduled refresh cannot bypass it.');
  }
}

async function collectListingLinks(page) {
  await page.goto(WATCHLIST_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(5000);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(900);
  }
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/buy/listings/details/"]')]
    .map(a => ({ href: new URL(a.getAttribute('href'), location.href).href, text: (a.innerText || a.textContent || '').trim() })));
  const seen = new Set();
  return links.filter(l => {
    const id = l.href.match(/details\/([a-f0-9]+)/i)?.[1] || l.href;
    if (seen.has(id)) return false;
    seen.add(id);
    return seen.size <= MAX_LISTINGS;
  });
}

function parseEndTime(text, scriptsText) {
  const all = `${text}\n${scriptsText}`;
  const iso = all.match(/(?:endTime|endDate|closeTime|auctionEnd(?:Date)?)["']?\s*[:=]\s*["']([^"']{16,40})/i)?.[1];
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(+d)) return d.toISOString();
  }
  const mdy = all.match(/(?:Ends?|Closing|End Date)\s*:?\s*([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4}[^\n|]{0,40}\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)?.[1]
    || all.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}[^\n|]{0,30}\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)?.[1];
  if (mdy) {
    const d = new Date(mdy + ' America/Denver');
    if (!isNaN(+d)) return d.toISOString();
  }
  return null;
}

function parseSummary(text) {
  const currentBid = money(text.match(/(?:Current\s+Bid|High\s+Bid|Current\s+Price|Bid)\s*\$?([\d,.]+)/i)?.[1]);
  const msrp = money(text.match(/(?:Ext\.?\s*Retail|Retail\s+Value|MSRP)\s*\$?([\d,.]+)/i)?.[1]);
  const units = int(text.match(/(\d[\d,]*)\s+(?:Units?|Items?)/i)?.[1]);
  const pallets = int(text.match(/(\d+)\s+Pallets?/i)?.[1]);
  const spaces = int(text.match(/(?:Spaces?|Pallet\s+Spaces?)\s*:?\s*(\d+)/i)?.[1]) || pallets;
  const weight = int(text.match(/(?:Weight|Total\s+Weight)\s*:?\s*([\d,]+)\s*(?:lbs?|pounds?)/i)?.[1]);
  const shipCost = money(text.match(/(?:Shipping|Delivery|Freight|Estimated\s+Shipping|Cost\s+to\s+Deliver)\s*(?:Cost|Estimate|Fee)?\s*:?\s*\$([\d,.]+)/i)?.[1]);
  return { currentBid, msrp, units, shipCost, shipment: { pallets, spaces, weight } };
}

async function scrapeTableManifest(page) {
  return await page.evaluate(() => {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    const tables = [...document.querySelectorAll('table')];
    const out = [];
    for (const table of tables) {
      const rows = [...table.querySelectorAll('tr')].map(tr => [...tr.children].map(td => clean(td.innerText || td.textContent)));
      if (rows.length < 2) continue;
      let headerIndex = rows.findIndex(r => r.some(c => /item|sku/i.test(c)) && r.some(c => /qty|quantity/i.test(c)));
      if (headerIndex < 0) continue;
      const headers = rows[headerIndex].map(h => h.toLowerCase());
      const get = (r, pats) => {
        const idx = headers.findIndex(h => pats.some(p => p.test(h)));
        return idx >= 0 ? r[idx] : '';
      };
      for (const r of rows.slice(headerIndex + 1)) {
        if (r.length < 2) continue;
        const item = get(r, [/item/, /sku/]);
        const desc = get(r, [/desc/, /product/, /title/]);
        if (!item || !desc) continue;
        out.push({
          item, desc,
          qty: get(r, [/qty/, /quantity/]),
          unit: get(r, [/unit.*retail/, /retail.*unit/, /^price$/]),
          ext: get(r, [/ext/, /extended/, /total.*retail/]),
          vendor: get(r, [/vendor/, /manufacturer/]),
          brand: get(r, [/brand/]),
          model: get(r, [/model/]),
          cat: get(r, [/category/, /cat/]),
          department: get(r, [/department/, /dept/]),
          condition: get(r, [/condition/]),
          lotId: get(r, [/lot/]),
          location: get(r, [/location/])
        });
      }
    }
    return out;
  });
}

function parseCsv(text) {
  const rows=[]; let row=[], cell='', q=false;
  for (let i=0;i<text.length;i++) { const c=text[i], n=text[i+1];
    if (q && c==='"' && n==='"') { cell+='"'; i++; }
    else if (c==='"') q=!q;
    else if (!q && c===',') { row.push(cell); cell=''; }
    else if (!q && /\r|\n/.test(c)) { if (c==='\r' && n==='\n') i++; row.push(cell); if (row.some(x=>x.trim())) rows.push(row); row=[]; cell=''; }
    else cell+=c;
  }
  row.push(cell); if (row.some(x=>x.trim())) rows.push(row);
  return rows;
}

async function rowsToManifest(rows) {
  const hi = rows.findIndex(r => r.some(c => /item|sku/i.test(c)) && r.some(c => /qty|quantity/i.test(c)));
  if (hi < 0) return [];
  const headers = rows[hi].map(h => clean(h).toLowerCase());
  const get = (r,pats) => { const idx=headers.findIndex(h=>pats.some(p=>p.test(h))); return idx>=0?r[idx]:''; };
  return rows.slice(hi+1).map(r => ({
    item:get(r,[/item/,/sku/]), desc:get(r,[/desc/,/product/,/title/]), qty:get(r,[/qty/,/quantity/]), unit:get(r,[/unit.*retail/,/retail.*unit/,/^price$/]), ext:get(r,[/ext/,/extended/,/total.*retail/]), vendor:get(r,[/vendor/,/manufacturer/]), brand:get(r,[/brand/]), model:get(r,[/model/]), cat:get(r,[/category/,/cat/]), department:get(r,[/department/,/dept/]), condition:get(r,[/condition/]), lotId:get(r,[/lot/]), location:get(r,[/location/])
  })).filter(x => x.item && x.desc);
}

async function parseManifestFile(filePath) {
  const buf = await fs.readFile(filePath);
  if (buf.subarray(0,2).toString() === 'PK') {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return rowsToManifest(XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }));
  }
  return rowsToManifest(parseCsv(buf.toString('utf8')));
}

async function scrapeDownloadedManifest(page) {
  const button = page.locator('button:has-text("Download Manifest"), a:has-text("Download Manifest")').last();
  if (!(await button.count())) return [];
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await button.click({ timeout: 5000 });
    const download = await downloadPromise;
    const filePath = await download.path();
    if (!filePath) return [];
    return await parseManifestFile(filePath);
  } catch { return []; }
}

async function scrapeCsvManifest(page) {
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: new URL(a.href, location.href).href, text: (a.innerText || '').trim() })));
  const manifest = links.find(l => /manifest|download/i.test(l.text + ' ' + l.href) && /csv|manifest|download/i.test(l.href));
  if (!manifest) return [];
  try {
    const res = await page.request.get(manifest.href, { timeout: 30000 });
    if (!res.ok()) return [];
    return await rowsToManifest(parseCsv(await res.text()));
  } catch { return []; }
}

async function scrapeListing(page, link, cache) {
  await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3500);
  const text = clean(await page.textContent('body').catch(()=> '') || '');
  if (/captcha|verify you are human|checking your browser/i.test(text)) throw new Error('Human verification appeared on detail page.');
  const scriptsText = await page.evaluate(() => [...document.scripts].map(s => s.textContent || '').join('\n')).catch(()=> '');
  const h1 = clean(await page.locator('h1').first().textContent({ timeout: 3000 }).catch(()=>''));
  const title = h1 || clean((await page.title()).replace(/\s*\|\s*B-?Stock.*$/i, '')) || link.text || 'BStock listing';
  const id = link.href.match(/details\/([a-f0-9]+)/i)?.[1] || Buffer.from(link.href).toString('hex').slice(0,24);
  const summary = parseSummary(`${title} ${text}`);
  const endTime = parseEndTime(text, scriptsText);
  if (endTime && new Date(endTime) <= new Date()) return null;

  const images = uniq(await page.evaluate(() => {
    const srcs = [...document.images].map(img => img.currentSrc || img.src);
    const bgs = [...document.querySelectorAll('*')].map(el => getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1]).filter(Boolean);
    return [...srcs, ...bgs].map(s => new URL(s, location.href).href).filter(s => /cloudfront|product-image|image|uploads|cdn/i.test(s));
  }).catch(()=> []));

  let items = await scrapeDownloadedManifest(page);
  if (!items.length) items = await scrapeCsvManifest(page);
  if (!items.length) items = await scrapeTableManifest(page);
  items = items.map(i => {
    const item = clean(i.item).replace(/^#/, '');
    const cached = cache.itemImages.get(item);
    return {
      item,
      desc: clean(i.desc),
      qty: int(i.qty),
      unit: money(i.unit),
      ext: money(i.ext),
      vendor: clean(i.vendor),
      brand: clean(i.brand),
      model: clean(i.model),
      cat: clean(i.cat),
      department: clean(i.department),
      condition: clean(i.condition) || 'USED_GOOD',
      lotId: clean(i.lotId),
      location: clean(i.location),
      img: cached?.img || '',
      imgSource: cached?.img ? cached.imgSource : '',
      costcoUrl: `https://sameday.costco.com/search?search_term=${encodeURIComponent(item)}`
    };
  }).filter(i => i.item && i.desc);

  const prettyId = title.match(/\(([A-Z]{2,4}-\d+)\)/)?.[1] || title.match(/\b\d{5}-[A-Z0-9-]+\b/)?.[0] || id;
  const condition = /scratch\s*&\s*dent/i.test(title) ? 'SCRATCH_DENT' : /like new/i.test(title) ? 'LIKE_NEW' : /new/i.test(title) && !/used/i.test(title) ? 'NEW' : 'USED_GOOD';
  const location = title.match(/,\s*([^,]+,\s*[A-Z]{2})\s*$/)?.[1] || text.match(/Location\s*:?\s*([^\n|]{3,80})/i)?.[1] || '';
  const gallery = images.length ? images : (cache.listingImages.get(id) || []);

  return {
    bidCount: int(text.match(/(\d+)\s+Bids?/i)?.[1]), condition,
    currentBid: summary.currentBid, endTime, href: link.href, id,
    images: gallery,
    items,
    location: clean(location), lot: prettyId, msrp: summary.msrp || items.reduce((s,i)=>s+i.ext,0), prettyId,
    shipCost: summary.shipCost, shipment: summary.shipment,
    title, units: summary.units || items.reduce((s,i)=>s+i.qty,0)
  };
}

async function main() {
  const existing = await existingData();
  const cache = readExistingCache(existing);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36' });
  const page = await context.newPage();
  const errors = [];
  let listings = [];
  try {
    await loginIfNeeded(page);
    const links = await collectListingLinks(page);
    if (!links.length) {
      const finalUrl = page.url();
      const pageTitle = await page.title().catch(() => '');
      const bodySnippet = clean((await page.textContent('body').catch(() => '') || '')).slice(0, 500);
      console.log(`No listing links found on saved search page after login. URL=${finalUrl} Title=${pageTitle}`);
      existing.lastRefreshAttempt = new Date().toISOString();
      existing.snapshot = new Date().toISOString();
      existing.refreshStatus = 'ok-empty';
      existing.refreshNote = 'No active listing links were returned by the saved search at refresh time.';
      existing.refreshDiagnostics = { url: finalUrl, title: pageTitle, bodySnippet };
      existing.refreshErrors = [];
      existing.listings = [];
      await fs.writeFile(DATA_PATH, JSON.stringify(existing, null, 2));
      await deleteGeneratedListingFiles();
      return;
    }
    for (const [idx, link] of links.entries()) {
      try {
        console.log(`Scraping ${idx+1}/${links.length}: ${link.href}`);
        const l = await scrapeListing(page, link, cache);
        if (l) listings.push(l);
      } catch (e) { errors.push(`${link.href}: ${e.message}`); }
    }
  } finally {
    await browser.close().catch(()=>{});
  }

  if (!listings.length) {
    const next = {
      snapshot: new Date().toISOString(),
      refreshStatus: errors.length ? 'ok-empty-with-errors' : 'ok-empty',
      refreshErrors: errors.slice(0, 20),
      listings: []
    };
    await fs.writeFile(DATA_PATH, JSON.stringify(next, null, 2));
    await deleteGeneratedListingFiles();
    console.log(`Refresh complete: no active listings. ${errors.length} listing scrape errors.`);
    return;
  }

  listings.sort((a,b) => (new Date(a.endTime || 0)) - (new Date(b.endTime || 0)));
  const next = { snapshot: new Date().toISOString(), refreshStatus: errors.length ? 'partial' : 'ok', refreshErrors: errors.slice(0, 20), listings };
  await fs.writeFile(DATA_PATH, JSON.stringify(next, null, 2));
  await deleteGeneratedListingFiles();
  for (const [i,l] of listings.entries()) await fs.writeFile(new URL(`../data/listing${i}.json`, import.meta.url), JSON.stringify(l, null, 2));
  console.log(`Refresh complete: ${listings.length} active listings, ${errors.length} errors.`);
}

main().catch(err => { console.error(err); process.exit(1); });
