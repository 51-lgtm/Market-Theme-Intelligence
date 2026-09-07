'use strict';
// Real local browser + HTTP smoke test. It never seeds market data or calls AI.
// Use a fresh isolated database and random temporary authentication credentials.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname,'..');
const out = path.join(root,'artifacts');
fs.mkdirSync(out,{recursive:true});
const stamp = crypto.randomUUID();
const password = crypto.randomBytes(24).toString('hex');
const port = Number(process.env.SMOKE_PORT || 8010), legacyPort = port + 1;
const base = `http://127.0.0.1:${port}`;
const env = {...process.env, ASTRA_ADMIN_PASSWORD:password, ASTRA_JWT_SECRET:crypto.randomBytes(48).toString('hex'),
  ASTRA_DATABASE_PATH:path.join(out,`ui-${stamp}.sqlite3`), COOKIE_SECURE:'false', ASTRA_BACKGROUND_JOBS:'false',
  LEGACY_API_URL:`http://127.0.0.1:${legacyPort}`, OPENAI_API_KEY:'', OPENAI_AGENT_MODEL:'',
  FINNHUB_API_KEY:'', ALPHA_VANTAGE_API_KEY:'', ANTHROPIC_API_KEY:'', API_TOKEN:'', SEC_USER_AGENT:'',
  AUTO_TRADE:'false', LIVE_TRADING:'false', PAPER_TRADING:'false', SHADOW_TRADING:'true', MANUAL_APPROVAL:'true',
  BROKER_MODE:'shadow', ASTRA_UNIVERSE:'SPY,JMIA,MU,NVDA', HOST:'127.0.0.1'};
const children = [];
let browser;
const errors = [], report = {started_at:new Date().toISOString(),pages:[],console_errors:errors,market:null};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function ready(url){for(let i=0;i<100;i++){try{if((await fetch(url)).ok)return;}catch{}await delay(150);}throw Error('service_startup_timeout');}
function start(command,args,extra={}) {
  const child = spawn(command,args,{cwd:root,env:{...env,...extra},windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',()=>{}); child.stderr.on('data',data=>{if(String(data).includes('Traceback'))errors.push('server_traceback');});
  children.push(child);return child;
}
(async()=>{
  try {
    start(process.execPath,['server.js'],{PORT:String(legacyPort)});
    await ready(env.LEGACY_API_URL+'/healthz');
    start(process.env.ASTRA_PYTHON || path.join(root,'.venv','Scripts','python.exe'),['-m','uvicorn','astra.app:create_app','--factory','--host','127.0.0.1','--port',String(port)]);
    await ready(base+'/healthz');
    try{browser=await chromium.launch({headless:true});}catch{browser=await chromium.launch({headless:true,channel:'msedge'});}
    const context=await browser.newContext({viewport:{width:1440,height:1080},locale:'ja-JP'});
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto(base+'/astra/');
    await page.locator('#password').fill(password);
    await page.locator('form button[type=submit]').click();
    await page.locator('.sidebar').waitFor();
    await page.locator('h1').filter({hasText:'トレーディング司令室'}).waitFor({timeout:15000});
    report.pages.push('dashboard');
    await page.screenshot({path:path.join(out,'astra-dashboard-empty.png'),fullPage:true});
    const session=await context.request.get(base+'/api/astra/auth/session');
    const csrf=(await session.json()).csrf_token;
    const refresh=await context.request.post(base+'/api/astra/refresh',{headers:{'X-CSRF-Token':csrf},data:{symbols:['SPY','JMIA','MU','NVDA']}});
    assert.equal(refresh.status(),200);
    let dashboard;
    for(let i=0;i<70;i++){
      await delay(1500);
      dashboard=await (await context.request.get(base+'/api/astra/dashboard')).json();
      if(!dashboard.system.jobs.refresh_running)break;
    }
    assert.ok(dashboard&&!dashboard.system.jobs.refresh_running,'market refresh should finish');
    report.market={status:dashboard.status,as_of:dashboard.as_of,rows:dashboard.scanner.map(r=>({ticker:r.ticker,price:r.price,status:r.data_status,technical_as_of:r.technical_as_of})),providers:dashboard.system.providers,last_error:dashboard.system.last_error};
    await page.reload();await page.locator('.sidebar').waitFor();
    if(dashboard.scanner.length)await page.locator('table').getByText(dashboard.scanner[0].ticker,{exact:true}).first().waitFor();
    await page.screenshot({path:path.join(out,'astra-dashboard-desktop.png'),fullPage:true});
    for(const label of ['スキャナー','ポートフォリオ','Shadow Trade','戦略分析','シグナル','設定・システム']){
      await page.locator('.sidebar').getByRole('button',{name:new RegExp('^'+label)}).click();
      await page.locator('h1').waitFor();
      await delay(150);
      assert.equal(await page.locator('.error-banner').count(),0,label);
      report.pages.push(label);
    }
    await page.locator('.sidebar').getByRole('button',{name:/JMIA/}).click();
    await page.getByText('JMIA Priority Intelligence',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'astra-jmia-desktop.png'),fullPage:true});
    report.pages.push('ticker_detail_jmia');
    await page.locator('.sidebar').getByRole('button',{name:'司令室',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    await delay(200);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
    assert.equal(overflow,false,'mobile page must not overflow horizontally');
    await page.screenshot({path:path.join(out,'astra-dashboard-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'メニューを開く'}).click();
    await page.locator('.sidebar').getByRole('button',{name:'Shadow Trade',exact:true}).click();
    await page.locator('h1').filter({hasText:'判断を、記録で検証する。'}).waitFor();
    report.pages.push('mobile_navigation_shadow');
    assert.equal((await context.request.get(base+'/api/astra-evidence')).status(),404);
    const legacy=await context.request.get(base+'/'); assert.equal(legacy.status(),200);assert.match(await legacy.text(),/uscmd_ultra_v3/);
    report.legacy_proxy='ok';
    assert.deepEqual(errors,[]);
    report.status='passed';
  } catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
  finally{
    if(browser)await browser.close();
    for(const child of children.reverse())child.kill();
    report.finished_at=new Date().toISOString();
    fs.writeFileSync(path.join(out,'ui-smoke-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }
})();
