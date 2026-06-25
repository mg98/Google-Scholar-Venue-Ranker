const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  await page.goto(process.argv[2]);
  await page.waitForTimeout(800);
  await page.hover('.gsr-summary-header__action--explore');
  await page.waitForTimeout(250);
  await page.screenshot({ path: process.argv[3] });
  await browser.close();
})();
