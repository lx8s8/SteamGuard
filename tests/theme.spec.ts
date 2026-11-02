import { expect, test, type Page } from "@playwright/test";

async function themeFixture(page: Page, theme: string, language: string, preview = false) {
  await page.addInitScript(({ theme, language, preview }) => {
    localStorage.setItem("steamguard.theme", theme);
    localStorage.setItem("steamguard.textSize", preview ? "100" : "125");
    localStorage.setItem("steamguard.language", language);
    const token = { id:"theme-demo", name:"demo@example.test", issuer:"Example", kind:"totp", code:"123456", remaining:24, period:30, algorithm:"SHA1", digits:6, counter:0, pinned:false, icon:null, group:null, loggedIn:false };
    const tokens = preview ? [
      {...token,id:"github-demo",name:"GitHub · demo",issuer:"GitHub",code:"429183",icon:"brand:github"},
      {...token,id:"google-demo",name:"Google · demo@example.test",issuer:"Google",code:"708264",icon:"brand:google"},
      {...token,id:"steam-demo",name:"Steam · demo",issuer:"Steam",kind:"steam",code:"X4G2D",icon:"brand:steam"},
    ] : [token];
    Object.assign(window, { isTauri:true, __TAURI_INTERNALS__:{ invoke:async(command:string) => {
      switch(command) {
        case "vault_status": return { initialized:true,locked:false,tokenCount:tokens.length };
        case "list_tokens": return tokens;
        case "token_codes": return { revision:"theme-demo",codes:tokens.map(t=>({id:t.id,code:t.code,remaining:24,period:30})) };
        case "desktop_snapshot": return {revision:"theme-demo",initialized:true,locked:false,preview:false,previewEnabled:false,tokens};
        case "desktop_codes": return {revision:"theme-demo",codes:tokens.map(t=>({id:t.id,code:t.code,remaining:24,period:30}))};
        case "token_groups": return [];
        case "sync_status": return { configured:false,active:false,busy:false,conflicts:[],lastSuccess:0 };
        case "desktop_settings": case "quick_capabilities": return {supported:false};
        default: return null;
      }
    } } });
  }, {theme,language,preview});
}
async function assertContrast(page: Page, selector: string) {
  const checks = await page.locator(selector).evaluateAll(elements => {
    const rgb = (value:string) => (value.match(/[\d.]+/g)||[]).map(Number);
    const luminance = (a:number[]) => a.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    return elements.filter(el=>el.getBoundingClientRect().width>0).map(el=>{
      const style=getComputedStyle(el); const fg=rgb(style.color);
      let current:Element|null=el, bg=rgb(style.backgroundColor);
      while((bg.length<3||bg[3]===0)&&current?.parentElement) { current=current.parentElement;bg=rgb(getComputedStyle(current).backgroundColor); }
      const a=luminance(fg),b=luminance(bg);
      return {label:el.className||el.tagName,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
    });
  });
  expect(checks.length).toBeGreaterThan(0);
  for(const check of checks) expect(check.ratio,check.label).toBeGreaterThanOrEqual(4.5);
}
for (const [theme, width, language] of [["light",1180,"en"],["dark",320,"zh-CN"],["light",390,"ar"],["dark",1180,"en"]] as const) {
  test(`quiet surfaces and readable controls in ${theme} at ${width}px ${language}`, async({page})=>{
    await page.setViewportSize({width,height:860});
    await themeFixture(page,theme,language);
    await page.goto("/");
    await expect(page.locator(".token-card")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("dir",language==="ar"?"rtl":"ltr");
    await expect(page.locator("html")).toHaveAttribute("data-theme",theme);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
    await assertContrast(page,".token-identity h3,.token-code,.token-identity > span,.token-avatar.initials,.page-heading .button.primary");
    await page.screenshot({path:`artifacts/magpie-theme-tokens-${theme}-${width}-${language}.png`,fullPage:true});
    await page.locator(".token-menu").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertContrast(page,".modal h2,.modal .field-label,.modal input,.modal .danger-text,.modal .button.primary");
    await page.screenshot({path:`artifacts/magpie-theme-modal-${theme}-${width}-${language}.png`,fullPage:true});
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.locator(width<=900?".mobile-nav button":".sidebar nav button").last().click();
    await expect(page.locator(".settings-grid")).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1);
    await assertContrast(page,".settings-grid .panel-title h2,.settings-grid .setting-row h3,.settings-grid .setting-row p,.settings-grid .form-hint");
    await page.screenshot({path:`artifacts/magpie-theme-settings-${theme}-${width}-${language}.png`,fullPage:true});
  });
}


test("branded token lists remain compact across desktop, phone and tray", async ({page}) => {
  await themeFixture(page,"light","zh-CN",true);
  await page.setViewportSize({width:1180,height:860});
  await page.goto("/");
  await expect(page.locator(".token-card")).toHaveCount(3);
  await expect(page.locator(".brand-symbol svg")).toHaveCount(1);
  await page.screenshot({path:"artifacts/preview-desktop-light.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  await expect(page.locator(".token-card")).toHaveCount(3);
  await expect(page.locator(".mobile-nav")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({path:"artifacts/preview-mobile-light.png"});
  await page.setViewportSize({width:360,height:348});
  await page.goto("/?view=tray");
  await expect(page.locator(".tray-token")).toHaveCount(3);
  await expect(page.locator(".tray-progress[data-otp-progress] .otp-progress-fill")).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(361);
  await page.screenshot({path:"artifacts/preview-tray-light.png"});
});
